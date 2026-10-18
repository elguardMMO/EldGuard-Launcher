'use strict';
/**
 * Fabrique l'installateur Windows (dist/EldGuard Launcher Setup x.y.z.exe) sans publier.
 * À lancer avec le Node intégré à Electron (le Node installé sur le PC est trop ancien pour electron-builder) :
 *   $env:ELECTRON_RUN_AS_NODE='1'; .\node_modules\electron\dist\electron.exe tools\build_installer.js
 */
process.noAsar = true;           // sous Electron, « fs » lirait les .asar comme des dossiers : electron-builder doit les traiter comme de simples fichiers
const path = require('path');
const { build, Platform } = require('electron-builder');
build({ targets: Platform.WINDOWS.createTarget('nsis'), projectDir: path.join(__dirname, '..'), publish: 'never' })
  .then(files => console.log('FABRIQUÉ :\n' + files.join('\n')))
  .catch(e => { console.error('ÉCHEC :', e && e.message ? e.message : e); process.exit(1); });
