'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const auth = require('./auth');
const game = require('./game');

const appDir = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(appDir, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
// config.local.json (jamais versionné) : adresse du serveur pendant les essais. En production, l'adresse vient de la liste hébergée (manifest.server).
try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(appDir, 'config.local.json'), 'utf8').replace(/^\uFEFF/, ''))); } catch { /* absent : normal */ }
const root = path.join(app.getPath('userData'), 'EldGuard');
const sessionFile = path.join(root, 'session.bin');
const settingsFile = path.join(root, 'settings.json');
let win = null;
let session = null;           // { refresh_token, name, uuid, mc: { access_token, expires } }

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function readSettings() {
  try { return Object.assign({ ram: cfg.memory.max }, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch { return { ram: cfg.memory.max }; }
}
function writeSettings(s) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s)); }

function saveSession() {
  fs.mkdirSync(root, { recursive: true });
  const raw = JSON.stringify({ refresh_token: session.refresh_token, name: session.name, uuid: session.uuid });
  fs.writeFileSync(sessionFile, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(raw) : Buffer.from(raw));
}
function loadSession() {
  try {
    const b = fs.readFileSync(sessionFile);
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString());
  } catch { return null; }
}

async function mcFromRefresh(refresh) {
  const ms = await auth.refresh(cfg.microsoftClientId, refresh);
  const mc = await auth.minecraftFromMicrosoft(ms.access_token);
  session = { refresh_token: ms.refresh_token || refresh, name: mc.name, uuid: mc.uuid, mc };
  saveSession();
  return mc;
}

// ---------------------------------------------------------------- état du serveur (ping Minecraft) : l'interface ne reçoit jamais l'adresse
function varint(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); }
function pingServer(host, port, timeout = 4000) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host, port }, () => {
      const h = Buffer.from(host, 'utf8');
      const hs = Buffer.concat([varint(0), varint(763), varint(h.length), h, Buffer.from([(port >> 8) & 255, port & 255]), varint(1)]);
      sock.write(Buffer.concat([varint(hs.length), hs, Buffer.from([1, 0])]));
    });
    let buf = Buffer.alloc(0);
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(null); });
    sock.on('error', () => resolve(null));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('{');
      if (i < 0) return;
      try { const j = JSON.parse(buf.slice(i).toString('utf8').replace(/\0+$/, '')); sock.destroy(); resolve({ online: j.players ? j.players.online : 0, max: j.players ? j.players.max : 0 }); } catch { /* paquet incomplet : on attend la suite */ }
    });
  });
}

ipcMain.handle('state', async () => {
  const s = loadSession();
  const base = { config: { name: cfg.name, minecraft: cfg.minecraft, version: app.getVersion(), discord: !!(cfg.links && cfg.links.discord) }, settings: readSettings() };
  return s ? Object.assign(base, { loggedIn: true, name: s.name, uuid: s.uuid }) : Object.assign(base, { loggedIn: false });
});

ipcMain.handle('status', async () => {
  try {
    const srv = cfg.server || (await game.readManifest(cfg, appDir)).server;
    if (!srv || !srv.host) return { known: false };
    const r = await pingServer(srv.host, Number(srv.port) || 25565);
    return r ? { known: true, up: true, online: r.online, max: r.max } : { known: true, up: false };
  } catch { return { known: false }; }
});

ipcMain.handle('login', async () => {
  const dc = await auth.startDeviceCode(cfg.microsoftClientId);
  send('device', { code: dc.user_code, url: dc.verification_uri, expires: dc.expires_in });
  shell.openExternal(dc.verification_uri);
  const ms = await auth.waitDeviceCode(cfg.microsoftClientId, dc);
  const mc = await auth.minecraftFromMicrosoft(ms.access_token);
  session = { refresh_token: ms.refresh_token, name: mc.name, uuid: mc.uuid, mc };
  saveSession();
  return { name: mc.name, uuid: mc.uuid };
});

ipcMain.handle('logout', async () => { session = null; fs.rmSync(sessionFile, { force: true }); return true; });
ipcMain.handle('set-ram', async (_e, ram) => { if (/^([2-9]|1[0-6])G$/.test(ram)) writeSettings(Object.assign(readSettings(), { ram })); return readSettings(); });
ipcMain.handle('link', async (_e, which) => { const u = cfg.links && cfg.links[which]; if (u && /^https:\/\//.test(u)) shell.openExternal(u); return !!u; });
ipcMain.handle('open-folder', async () => { fs.mkdirSync(root, { recursive: true }); shell.openPath(root); });
ipcMain.handle('win', async (_e, act) => { if (!win) return; if (act === 'min') win.minimize(); else if (act === 'close') win.close(); });

ipcMain.handle('play', async () => {
  try {
    let mc = session && session.mc && session.mc.expires > Date.now() + 60000 ? session.mc : null;
    if (!mc) {
      const s = session || loadSession();
      if (!s) throw new Error('Connecte-toi d’abord avec ton compte Microsoft.');
      mc = await mcFromRefresh(s.refresh_token);
    }
    const ram = readSettings().ram;
    await game.launch({ cfg: Object.assign({}, cfg, { memory: { min: '2G', max: ram } }), appDir, root, auth: mc, emit: (ch, d) => send('game:' + ch, d) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1100, height: 680, resizable: false, frame: false, backgroundColor: '#0a0c1c', title: `${cfg.name} Launcher`,
    icon: path.join(appDir, 'assets', 'emblem.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // mode essai (développement) : ELD_SHOT=<fichier.png> enregistre une capture puis quitte ; ELD_DEMO=login|home force l'affichage
  if (process.env.ELD_SHOT) {
    win.webContents.on('console-message', (_e, lvl, msg, line, src) => console.log('[console]', msg, src + ':' + line));
    win.webContents.on('did-finish-load', async () => {
      if (process.env.ELD_DEMO) await win.webContents.executeJavaScript(`window.__demo('${process.env.ELD_DEMO}')`);
      if (process.env.ELD_DEBUG) console.log('[dbg]', await win.webContents.executeJavaScript(`JSON.stringify({rs:document.readyState, hasDemo: typeof window.__demo, srv: (r=>[r.x,r.y,r.width,r.height])(document.getElementById('srv').getBoundingClientRect()), srvDisp:getComputedStyle(document.querySelector('.corner')).display, main:(r=>[r.x,r.y,r.width,r.height])(document.querySelector('main').getBoundingClientRect()), loginCls:document.getElementById('login').className, homeCls:document.getElementById('home').className, errs: window.__errs||null})`));
      setTimeout(async () => { const img = await win.webContents.capturePage(); fs.writeFileSync(process.env.ELD_SHOT, img.toPNG()); app.quit(); }, 1200);
    });
  }
});
app.on('window-all-closed', () => app.quit());
