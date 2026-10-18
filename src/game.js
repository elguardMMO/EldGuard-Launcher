'use strict';
/**
 * Installation et lancement du jeu : Java 17 (Temurin), installateur Forge, mods du serveur (liste « manifest » vérifiée par empreinte SHA-1),
 * puis démarrage de Minecraft 1.20.1 + Forge, connecté directement au serveur.
 * Tout est rangé dans le dossier du lanceur (jamais dans le .minecraft habituel du joueur).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { Client } = require('minecraft-launcher-core');

const sha1 = file => new Promise((res, rej) => {
  const h = crypto.createHash('sha1');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

async function download(url, dest, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (url.startsWith('file:///')) {                      // essais sur le même PC (manifest.local.json)
    fs.copyFileSync(decodeURIComponent(url.slice(8)), dest);
    if (onProgress) onProgress(1);
    return;
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(value);
    got += value.length;
    if (onProgress && total) onProgress(got / total);
  }
  await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
  fs.renameSync(tmp, dest);
}

/** Java 17 : celui du joueur n'est pas utilisé (versions trop variables) ; on installe Temurin 17 dans le dossier du lanceur. */
async function ensureJava(root, log, progress) {
  const dir = path.join(root, 'runtime', 'java17');
  const exe = path.join(dir, 'bin', 'javaw.exe');
  if (fs.existsSync(exe)) return exe;
  log('Installation de Java 17 (une seule fois)…');
  const zip = path.join(root, 'runtime', 'java17.zip');
  await download('https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse', zip, progress);
  const z = new AdmZip(zip);
  const tmp = path.join(root, 'runtime', '_java_tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  z.extractAllTo(tmp, true);
  const inner = fs.readdirSync(tmp).find(n => fs.existsSync(path.join(tmp, n, 'bin', 'javaw.exe')));
  if (!inner) throw new Error("L'archive Java est invalide.");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(path.join(tmp, inner), dir);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  return exe;
}

async function ensureForge(root, cfg, log, progress) {
  const file = path.join(root, 'forge', `forge-${cfg.forge}-installer.jar`);
  if (fs.existsSync(file)) return file;
  log('Téléchargement de Forge…');
  await download(`https://maven.minecraftforge.net/net/minecraftforge/forge/${cfg.forge}/forge-${cfg.forge}-installer.jar`, file, progress);
  return file;
}

/**
 * Lit la liste des fichiers du serveur. En production, c'est le service EldGuard Gate (cfg.gateUrl) qui la donne, après avoir vérifié
 * le compte Minecraft (jeton mcToken) : il renvoie aussi l'adresse du serveur et des liens de téléchargement temporaires.
 * Pendant les essais : fichier local (cfg.localManifest).
 */
async function readManifest(cfg, appDir, mcToken) {
  if (cfg.gateUrl) {
    if (!mcToken) throw new Error('Connecte-toi avec ton compte Microsoft pour récupérer les fichiers.');
    const r = await fetch(`${cfg.gateUrl.replace(/\/$/, '')}/manifest`, { method: 'POST', headers: { Authorization: `Bearer ${mcToken}` }, cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Liste des mises à jour inaccessible (${r.status}).`);
    return body;
  }
  const local = path.join(appDir, cfg.localManifest);
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  return { version: 'aucune', files: [] };
}

/** Télécharge les fichiers manquants ou modifiés ; supprime les mods retirés du serveur. */
async function syncFiles(manifest, gameDir, log, progress) {
  const files = manifest.files || [];
  const wanted = new Set(files.map(f => path.normalize(f.path).toLowerCase()));
  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  for (const n of fs.readdirSync(modsDir)) {            // mods gérés par le lanceur : retirés s'ils ne sont plus dans la liste
    const rel = path.normalize(path.join('mods', n)).toLowerCase();
    if (n.endsWith('.jar') && !wanted.has(rel)) { log(`Retrait de ${n}`); fs.rmSync(path.join(modsDir, n), { force: true }); }
  }
  let i = 0;
  for (const f of files) {
    i++;
    const rel = path.normalize(f.path);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Chemin refusé dans la liste : ${f.path}`);
    const dest = path.join(gameDir, rel);
    if (fs.existsSync(dest) && (await sha1(dest)) === f.sha1) continue;
    log(`Téléchargement : ${path.basename(rel)} (${i}/${files.length})`);
    await download(f.url, dest, p => progress((i - 1 + p) / files.length));
    if ((await sha1(dest)) !== f.sha1) { fs.rmSync(dest, { force: true }); throw new Error(`Fichier corrompu ou modifié : ${path.basename(rel)}`); }
  }
}

async function launch({ cfg, appDir, root, auth, emit, onServer }) {
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const log = m => emit('log', m);
  const prog = p => emit('progress', p);
  const java = await ensureJava(root, log, prog);
  const forge = await ensureForge(root, cfg, log, prog);
  log('Recherche des mises à jour…');
  const manifest = await readManifest(cfg, appDir, auth.access_token);
  if (onServer && manifest.server) onServer(manifest.server);
  await syncFiles(manifest, gameDir, log, prog);
  log(`Version des fichiers : ${manifest.version}`);

  const srv = cfg.server || manifest.server;
  if (!srv || !srv.host) throw new Error("Adresse du serveur inconnue : la liste des mises à jour ne la donne pas.");
  const launcher = new Client();
  launcher.on('debug', m => emit('debug', String(m)));
  launcher.on('data', m => emit('game', String(m)));
  launcher.on('progress', e => { if (e.total) prog(e.task / e.total); log(`Minecraft : ${e.type} ${e.task}/${e.total}`); });
  launcher.on('close', code => emit('closed', code));
  log('Préparation de Minecraft et de Forge (la première fois, c’est long)…');
  const proc = await launcher.launch({
    authorization: { access_token: auth.access_token, client_token: crypto.randomUUID(), uuid: auth.uuid, name: auth.name, user_properties: '{}', meta: { type: 'msa', demo: false } },
    root: path.join(root, 'minecraft'),
    javaPath: java,
    version: { number: cfg.minecraft, type: 'release' },
    forge,
    memory: { max: cfg.memory.max, min: cfg.memory.min },
    overrides: { gameDirectory: gameDir },
    server: { host: srv.host, port: String(srv.port || 25565) }
  });
  if (!proc) throw new Error('Minecraft ne démarre pas (voir le journal).');
  emit('started', null);
}

module.exports = { launch, readManifest, sha1 };
