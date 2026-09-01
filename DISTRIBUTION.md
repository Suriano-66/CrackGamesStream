# Distribution des applications (.exe) — CrackGames Studio & Stream

Ce guide explique comment **construire les installeurs Windows**, les **publier**, et
**brancher le lien de téléchargement sur le site**. La configuration de build
(electron-builder) et les **icônes de marque** sont déjà en place dans les deux dépôts.

---

## 1. Construire un installeur

Sur une machine **Windows** (electron-builder produit un installeur Windows), dans le
dossier de l'app (`CrackGamesStudio` ou `CrackGamesStream`) :

```
npm install
npm run dist:win
```

Cela génère un installeur **NSIS** dans le dossier `dist/`, par exemple :

- `dist/CrackGames Studio Setup 0.1.0.exe`
- `dist/CrackGames Stream Setup 0.1.0.exe`

L'installeur porte désormais l'**icône de marque** (cube 3D pour le Studio, bille de
course pour Stream), laisse choisir le dossier d'installation, et crée un raccourci.

> Astuce : avant chaque nouvelle version, **incrémente `version`** dans `package.json`
> (0.1.0 → 0.1.1…) pour que les fichiers et l'historique des Releases restent distincts.

---

## 2. Où héberger le téléchargement

C'est la **décision clé**, différente pour chaque app :

### CrackGames Studio — outil interne (dépôt privé)
Le Studio est réservé aux développeurs (toi + ton collègue). Publie l'installeur en
**Release GitHub sur le dépôt privé** `Suriano-66/CrackGamesStudio`. Vous êtes
authentifiés sur GitHub, donc vous pouvez télécharger ; personne d'autre n'y accède.

### CrackGames Stream — application des streamers (téléchargement PUBLIC requis)
Les streamers n'ont **pas** accès à ton dépôt privé. Il faut un lien public. Recommandé :

- **Créer un dépôt public séparé** dédié aux binaires, p. ex. `CrackGamesStream-releases`
  (vide, juste pour héberger les Releases). Le **code reste privé**, seul l'`.exe` est
  public. Tu déposes l'installeur en Release là, et l'URL de l'asset est publique.
- *Alternative* : rendre le dépôt `CrackGamesStream` public (expose le code — déconseillé).

> Éviter d'héberger l'`.exe` sur Render : le disque y est éphémère et mal adapté aux
> gros fichiers. GitHub Releases est gratuit et fiable pour ça.

---

## 3. Créer une Release GitHub et récupérer le lien

En ligne de commande (avec `gh` installé et connecté), depuis le dépôt concerné :

```
gh release create v0.1.0 "dist/CrackGames Stream Setup 0.1.0.exe" ^
  --title "CrackGames Stream 0.1.0" --notes "Première version publique"
```

Ou via l'interface GitHub : **Releases → Draft a new release →** choisis un tag
(`v0.1.0`), **glisse l'`.exe`** dans « Attach binaries », puis **Publish**.

Récupère ensuite l'**URL de téléchargement direct** de l'asset (clic droit sur le
fichier `.exe` de la Release → Copier l'adresse du lien). Elle ressemble à :

```
https://github.com/Suriano-66/CrackGamesStream-releases/releases/download/v0.1.0/CrackGames.Stream.Setup.0.1.0.exe
```

---

## 4. Brancher le lien sur le site

Le tableau de bord affiche **déjà** un bouton « ⬇️ Télécharger CrackGames Stream »
dès que la variable d'environnement est définie. Sur **Render** (service du site
`CrackGamesLive`) → **Environment** → ajoute/modifie :

```
NEXT_PUBLIC_STREAM_APP_URL = <URL de téléchargement direct de l'.exe Stream>
```

Puis **redéploie** le site. Le bouton devient actif pour les abonnés.

*(Pour le Studio, pas besoin de bouton public : partage simplement le lien de la Release
privée à ton collègue.)*

---

## 5. À savoir

- **SmartScreen Windows** : sans **signature de code** (certificat payant), Windows
  affichera « Éditeur inconnu » au premier lancement. L'utilisateur clique
  « Informations complémentaires → Exécuter quand même ». C'est normal tant que tu n'as
  pas de certificat ; on pourra l'ajouter plus tard.
- **Mise à jour automatique** : possible plus tard avec `electron-updater` + une config
  `publish` GitHub, pour que les apps se mettent à jour seules. Non nécessaire pour
  démarrer.
- **Taille** : l'installeur fait ~80–120 Mo (Electron + three.js embarqués). Normal.

---

## Récapitulatif express

| Étape | Studio | Stream |
|------|--------|--------|
| Build | `npm run dist:win` | `npm run dist:win` |
| Héberger | Release du dépôt privé | Release d'un dépôt **public** de binaires |
| Site | (lien partagé au collègue) | `NEXT_PUBLIC_STREAM_APP_URL` sur Render |
