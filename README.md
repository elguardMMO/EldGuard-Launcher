# EldGuard Launcher

Lanceur du serveur **EldGuard** (Minecraft Java 1.20.1, Forge) : connexion au compte Microsoft du joueur, installation de Java 17, de Forge et du mod,
mises à jour automatiques (chaque fichier est vérifié par son empreinte SHA-1), puis lancement du jeu connecté au serveur.

## Pour les joueurs
Télécharge l'installateur dans la rubrique **Releases** de ce dépôt, lance-le, connecte-toi avec ton compte Microsoft, puis clique sur **JOUER**.
Il faut posséder Minecraft Java Edition.

## Pour le développement
```
npm install
npm start
```
- `config.json` : nom, ID d'application Microsoft, version de Minecraft et de Forge, liens.
- `config.local.json` (non versionné) : adresse du serveur pour les essais. En production, elle est intégrée à l'installateur au moment de sa fabrication.
- `node tools/make_manifest.js <dossier des jars> <adresse web> [version]` : fabrique la liste des fichiers à publier avec les jars.
- `npm run dist` : fabrique l'installateur Windows.

Les mots de passe ne sont jamais vus par le lanceur : la connexion passe par la page officielle de Microsoft (code d'appareil).
