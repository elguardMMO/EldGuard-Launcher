'use strict';
const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const fail = m => { $('error').textContent = m; show('error', !!m); };
const clean = m => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function avatar(uuid) {
  const img = $('avatar');
  img.onerror = () => { img.onerror = null; img.src = '../../assets/emblem.png'; img.style.height = '190px'; };
  img.src = uuid ? `https://mc-heads.net/body/${uuid}/right` : '../../assets/emblem.png';
}

async function refresh() {
  const s = await window.eld.state();
  show('login', !s.loggedIn);
  show('home', s.loggedIn);
  $('mcv').textContent = s.config.minecraft;
  $('lv').textContent = s.config.version;
  $('btnDiscord').disabled = !s.config.discord;
  $('ram').value = s.settings.ram;
  if (s.loggedIn) { $('pseudo').textContent = s.name; $('acc').textContent = s.name; avatar(s.uuid); }
  pollStatus();
}

async function pollStatus() {
  const r = await window.eld.status();
  const box = $('srv');
  box.classList.remove('up', 'down');
  if (!r.known) { $('srvTxt').textContent = 'SERVEUR'; return; }
  if (r.up) { box.classList.add('up'); $('srvTxt').textContent = `EN LIGNE · ${r.online}/${r.max}`; }
  else { box.classList.add('down'); $('srvTxt').textContent = 'HORS LIGNE'; }
}
setInterval(pollStatus, 30000);

async function login(mode) {
  fail('');
  $('btnLogin').disabled = true; $('btnCode').disabled = true;
  if (mode === 'browser') $('btnLogin').textContent = 'EN ATTENTE DE MICROSOFT…';
  try { await window.eld.login(mode); show('deviceBox', false); } catch (e) { fail(clean(e.message)); }
  $('btnLogin').textContent = 'SE CONNECTER AVEC MICROSOFT';
  $('btnLogin').disabled = false; $('btnCode').disabled = false;
  refresh();
}
$('btnLogin').addEventListener('click', () => login('browser'));
$('btnCode').addEventListener('click', () => login('code'));
$('btnLogout').addEventListener('click', async () => { await window.eld.logout(); refresh(); });
$('btnFolder').addEventListener('click', () => window.eld.openFolder());
$('btnDiscord').addEventListener('click', () => window.eld.link('discord'));
$('btnSettings').addEventListener('click', () => show('settings', true));
$('btnCloseSettings').addEventListener('click', () => show('settings', false));
$('ram').addEventListener('change', e => window.eld.setRam(e.target.value));
$('wMin').addEventListener('click', () => window.eld.win('min'));
$('wClose').addEventListener('click', () => window.eld.win('close'));

$('btnPlay').addEventListener('click', async () => {
  fail('');
  $('btnPlay').disabled = true;
  $('ready').textContent = 'Préparation…';
  show('progressWrap', true);
  $('bar').style.width = '0%';
  const r = await window.eld.play();
  if (!r.ok) { fail(r.error); $('btnPlay').disabled = false; $('ready').textContent = 'Prêt à jouer'; show('progressWrap', false); }
});

window.eld.onDevice(d => { $('deviceCode').textContent = d.code; $('deviceUrl').textContent = d.url; show('deviceBox', true); });
window.eld.onLog(m => { $('status').textContent = m; });
window.eld.onProgress(p => { $('bar').style.width = `${Math.max(0, Math.min(100, Math.round(p * 100)))}%`; });
window.eld.onStarted(() => { $('status').textContent = 'Minecraft démarre… bon jeu !'; $('bar').style.width = '100%'; $('ready').textContent = 'En jeu'; });
window.eld.onClosed(code => { $('btnPlay').disabled = false; $('ready').textContent = 'Prêt à jouer'; show('progressWrap', false); if (code) fail(`Minecraft s'est arrêté (code ${code}).`); });

// aperçus de développement (captures d'écran) : jamais déclenchés par un joueur
window.__demo = mode => {
  if (mode === 'login') { show('login', true); show('home', false); show('deviceBox', true); $('deviceCode').textContent = 'D56E-35F0'; $('deviceUrl').textContent = 'microsoft.com/link'; }
  if (mode === 'home') {
    show('login', false); show('home', true); $('pseudo').textContent = 'ElGuardMMO'; $('acc').textContent = 'ElGuardMMO';
    avatar(null); show('progressWrap', true); $('bar').style.width = '42%'; $('status').textContent = 'Téléchargement : eldguard-1.20.1-1.0.0.jar (1/2)';
    $('srv').classList.add('up'); $('srvTxt').textContent = 'EN LIGNE · 3/50';
  }
};

refresh();
