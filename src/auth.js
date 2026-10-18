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

module.exports = { startDeviceCode, waitDeviceCode, refresh, minecraftFromMicrosoft };
