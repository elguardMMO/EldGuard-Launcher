'use strict';
/**
 * Fabrique la liste des fichiers du serveur (manifest.json) à partir d'un dossier de mods.
 *   node tools/make_manifest.js <dossier des jars> <adresse web du dossier> [version]
 *   ex. : node tools/make_manifest.js D:\Fleur\MonMMO-partage https://mon-site.fr/eldguard/mods 2026.10.18
 * Chaque jar reçoit son empreinte SHA-1 : le lanceur ne lance jamais un fichier modifié. Sans adresse web, écrit manifest.local.json (essais sur ce PC).
 * Les jars listés sont posés dans .minecraft-du-lanceur\game\mods. À téléverser : les jars + manifest.json sur l'hébergement.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dir = process.argv[2];
const base = process.argv[3] || '';
const version = process.argv[4] || new Date().toISOString().slice(0, 10).replace(/-/g, '.');
if (!dir) { console.error('Usage : node tools/make_manifest.js <dossier> [adresse web] [version]'); process.exit(1); }
const skip = /(mmocarte|ancien|\.bak|old)/i;                   // le serveur choisit lui-même : on n'embarque pas les vieilles versions
const files = fs.readdirSync(dir).filter(n => n.endsWith('.jar') && !skip.test(n) && !/^monmmo-/i.test(n)).map(n => {
  const p = path.join(dir, n);
  const sha1 = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  return { path: `mods/${n}`, url: base ? `${base.replace(/\/$/, '')}/${encodeURIComponent(n)}` : 'file:///' + p.replace(/\\/g, '/'), sha1, size: fs.statSync(p).size };
});
const out = path.join(__dirname, '..', base ? 'manifest.json' : 'manifest.local.json');
fs.writeFileSync(out, JSON.stringify({ version, files }, null, 2));
console.log(`${files.length} fichier(s) -> ${out}`);
files.forEach(f => console.log(`  ${f.path}  ${(f.size / 1e6).toFixed(1)} Mo  ${f.sha1.slice(0, 10)}`));
