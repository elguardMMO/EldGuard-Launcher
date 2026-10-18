'use strict';
/**
 * Connexion Microsoft -> Xbox Live -> Minecraft, par « flux d'appareil » : le joueur ouvre une page et saisit un code, le lanceur ne voit jamais son mot de passe.
 * Étapes : (1) code d'appareil Microsoft, (2) jeton Xbox Live, (3) jeton XSTS, (4) jeton Minecraft, (5) profil.
 * Le jeton de rafraîchissement Microsoft permet de se reconnecter sans rien retaper (stocké chiffré par le lanceur).
 */
const SCOPE = 'XboxLive.signin offline_access';
const TENANT = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';

async function post(url, body, json = true) {
  const res = await fetch(url, {
    method: 'POST',
    headers: json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString()
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/** Étape 1 : demande un code que le joueur saisit sur https://microsoft.com/link. */
async function startDeviceCode(clientId) {
  const r = await post(`${TENANT}/devicecode`, { client_id: clientId, scope: SCOPE }, false);
  if (!r.ok) throw new Error(`Microsoft a refusé la demande de connexion (${r.status}) : ${r.data.error_description || r.data.error || ''}`);
  return r.data; // { user_code, device_code, verification_uri, expires_in, interval, message }
}

/** Attend que le joueur valide le code (interroge Microsoft toutes les « interval » secondes). */
async function waitDeviceCode(clientId, dc, onTick) {
  const end = Date.now() + dc.expires_in * 1000;
  let wait = Math.max(3, dc.interval || 5);
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, wait * 1000));
    const r = await post(`${TENANT}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: dc.device_code }, false);
    if (r.ok) return r.data; // { access_token, refresh_token }
    const e = r.data.error;
    if (e === 'authorization_pending') { if (onTick) onTick(); continue; }
    if (e === 'slow_down') { wait += 5; continue; }
    if (e === 'authorization_declined') throw new Error('Connexion refusée sur la page Microsoft.');
    if (e === 'expired_token') break;
    throw new Error(`Connexion Microsoft impossible : ${r.data.error_description || e}`);
  }
  throw new Error('Le code a expiré. Clique de nouveau sur « Se connecter ».');
}

/**
 * Connexion par navigateur (comme le lanceur officiel) : la page de connexion Microsoft s'ouvre, le joueur y saisit son compte, puis Microsoft
 * le renvoie vers « http://localhost:<port> » où le lanceur attend le code (PKCE, sans secret). Il faut que « http://localhost » soit déclaré
 * dans l'application Azure (Authentification > Applications mobiles et de bureau). Le mot de passe n'est jamais vu par le lanceur.
 */
async function browserLogin(clientId, openUrl, timeoutMs = 180000) {
  const crypto = require('crypto');
  const http = require('http');
  const b64 = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const verifier = b64(crypto.randomBytes(48));
  const challenge = b64(crypto.createHash('sha256').update(verifier).digest());
  const state = b64(crypto.randomBytes(16));
  const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>EldGuard</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0c1c;color:#e8e2c8;font-family:Segoe UI,sans-serif;text-align:center"><div><h1 style="color:#ffc857;letter-spacing:6px">${title}</h1><p>${msg}</p></div>`;

  let server;
  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Pas de réponse de Microsoft. Si la page a affiché une erreur, utilise « Connexion avec un code » sous le bouton.")), timeoutMs);
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.writeHead(404).end(); return; }   // favicon, etc.
      const err = u.searchParams.get('error');
      const ok = !err && u.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? page('CONNEXION RÉUSSIE', 'Tu peux fermer cet onglet et revenir au lanceur EldGuard.') : page('CONNEXION REFUSÉE', 'Retourne dans le lanceur et réessaie.'));
      clearTimeout(timer);
      if (err) reject(new Error(`Connexion Microsoft refusée : ${u.searchParams.get('error_description') || err}`));
      else if (!ok) reject(new Error('Réponse Microsoft invalide (état différent).'));
      else resolve(u.searchParams.get('code'));
    });
    server.on('error', reject);
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const redirect = `http://localhost:${server.address().port}`;
  try {
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
    openUrl(`${TENANT}/authorize?${q}`);
    const code = await codePromise;
    const r = await post(`${TENANT}/token`, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier, scope: SCOPE }, false);
    if (!r.ok) throw new Error(`Connexion Microsoft impossible : ${r.data.error_description || r.data.error || r.status}`);
    return r.data; // { access_token, refresh_token }
  } finally { server.close(); }
}

async function refresh(clientId, refreshToken) {
  const r = await post(`${TENANT}/token`, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: SCOPE }, false);
  if (!r.ok) throw new Error('Session Microsoft expirée, reconnecte-toi.');
  return r.data;
}

/** Étapes 2 à 5 : de la session Microsoft au profil Minecraft. */
async function minecraftFromMicrosoft(msAccessToken) {
  const xbl = await post('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
  });
  if (!xbl.ok) throw new Error(`Xbox Live a refusé la connexion (${xbl.status}).`);
  const xsts = await post('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
  });
  if (!xsts.ok) {
    const code = xsts.data.XErr;
    const why = { 2148916233: "ce compte Microsoft n'a pas de profil Xbox (crée-le sur xbox.com)", 2148916238: 'compte enfant : il doit être ajouté à une famille Microsoft', 2148916235: 'Xbox Live indisponible dans ton pays' }[code];
    throw new Error(`Xbox Live (XSTS) a refusé : ${why || 'erreur ' + code}.`);
  }
  const uhs = xsts.data.DisplayClaims.xui[0].uhs;
  const mc = await post('https://api.minecraftservices.com/authentication/login_with_xbox', { identityToken: `XBL3.0 x=${uhs};${xsts.data.Token}` });
  if (!mc.ok) {
    throw new Error(mc.status === 403
      ? "Minecraft a refusé l'accès (403) : l'application Azure n'est pas encore autorisée par Mojang (formulaire https://aka.ms/AppRegInfo)."
      : `Minecraft a refusé la connexion (${mc.status}).`);
  }
  const prof = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${mc.data.access_token}` } });
  if (prof.status === 404) throw new Error("Ce compte n'a pas acheté Minecraft Java Edition.");
  if (!prof.ok) throw new Error(`Profil Minecraft indisponible (${prof.status}).`);
  const p = await prof.json();
  return { access_token: mc.data.access_token, uuid: p.id, name: p.name, expires: Date.now() + (mc.data.expires_in || 86400) * 1000 };
}

module.exports = { startDeviceCode, waitDeviceCode, browserLogin, refresh, minecraftFromMicrosoft };
