# CrackGames Stream 🎥🎮

Application de bureau (Windows) pour les **streamers** : elle affiche une **fenêtre
source portrait** (format TikTok 9:16) à capturer dans OBS, et un **panneau de
contrôle premium** pour piloter la course en direct.

## Installation & lancement (développement)

```bash
npm install     # electron + three + tiktok-live-connector (une fois)
npm start       # ouvre le Contrôle + la fenêtre Source
```

Au premier lancement : **connexion avec le compte du site** (abonnement actif requis).

## Générer un .exe installable

```bash
npm run dist:win     # → dist/CrackGames Stream Setup x.y.z.exe
```

## Utilisation

1. **Connecte-toi** avec ton compte.
2. **TikTok Live** : saisis `@ton_pseudo` et clique *Connecter* (mets-toi en live d'abord).
   Tant que TikTok n'est pas connecté, un **mode démo** tourne pour ne pas laisser l'écran vide.
3. **Dans OBS** : ajoute une source *Capture de fenêtre* → choisis
   **« CrackGames Stream — SOURCE »**. C'est ta fenêtre portrait.
   Boutons *Afficher / Masquer / Premier plan* pour gérer cette fenêtre.
4. **Panneau de contrôle** :
   - **Course** : Démarrer / Arrêter, et « Tout automatique » (les courses s'enchaînent seules).
   - **Caméra** : Auto, Derrière, De face, Côté, Vue du haut, ou **Libre**.
     En vue **Libre**, dans la fenêtre source : **Z Q S D** pour bouger, **souris** pour
     regarder, **Ctrl** accélère, **Shift** ralentit, **Espace/C** monter/descendre.
   - **Clique un joueur** dans le classement → la caméra le suit.
   - **Circuit** : change de map parmi les niveaux créés dans le Studio.

Tout peut rester **100 % automatique** : il suffit de laisser « Tout automatique » coché
et la caméra sur *Auto*.

## Dépôt privé, autonome

Le moteur du jeu est embarqué dans `engine/`. `node_modules`, `vendor/` et `dist/`
ne sont pas versionnés (régénérés à l'installation).
