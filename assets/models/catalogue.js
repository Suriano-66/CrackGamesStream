// ════════════════════════════════════════════════════════════════════════
//  CATALOGUE DES MODÈLES 3D — c'est ICI que tu ajoutes tes modèles.
//
//  Ce fichier vit à côté des .glb, dans assets/models/. Il n'est JAMAIS
//  synchronisé ni écrasé par « npm start » : tes ajouts sont donc permanents.
//  (Ne mets pas de modèles dans engine/assets.js : ce fichier-là est du code
//  recopié depuis le dépôt du site à chaque lancement.)
//
//  Pour ajouter un modèle :
//    1. dépose ton fichier .glb dans ce dossier (assets/models/) ;
//    2. ajoute une ligne ci-dessous. L'`id` doit être le nom du fichier
//       SANS l'extension : "monArbre" → monArbre.glb
//    3. `taille` et `centre` servent aux collisions et au volume témoin.
//       Tu peux les laisser approximatifs au début : sélectionne le modèle
//       dans le Studio, la console développeur (F12) affiche les valeurs
//       exactes à recopier.
//
//  Si tu veux le même modèle dans l'app Streamer et sur le site, copie le
//  .glb ET cette ligne dans leurs dossiers respectifs :
//    CrackGamesStream/assets/models/   et   CrackGamesLive/public/models/
// ════════════════════════════════════════════════════════════════════════

export const CATALOGUE = [
  // id           libellé affiché    icône   dimensions natives      centre
  { id: "arbre",   label: "Arbre",   icon: "🌲", taille: [2.24, 3.6, 2.19], centre: [0, 1.8, 0.06] },
  { id: "buisson", label: "Buisson", icon: "🌿", taille: [1.63, 1.02, 1.07], centre: [0.04, 0.5, 0.02] },
  { id: "rocher",  label: "Rocher",  icon: "🪨", taille: [2.64, 2.13, 2.56], centre: [0.12, 0.75, 0] },
  { id: "caisse",  label: "Caisse",  icon: "📦", taille: [1.26, 1.2, 1.26], centre: [0, 0.6, 0] },
  { id: "tonneau", label: "Tonneau", icon: "🛢️", taille: [1.01, 1.2, 1.06], centre: [0, 0.6, 0] },
  { id: "panneau", label: "Panneau", icon: "🪧", taille: [2, 2.45, 0.16], centre: [0, 1.22, 0] },
  { id: "gradin",  label: "Gradin",  icon: "🏟️", taille: [4, 1.5, 2.7], centre: [0, 0.75, -0.9] },
  { id: "marteau",  label: "Marteau",  icon: "🔨", taille: [3.17, 1.76, 3.85], centre: [0, 0.96, 1.45] },

  // ── Ajoute tes modèles ici ──
  // { id: "monArbre", label: "Mon arbre", icon: "🌳", taille: [2, 4, 2], centre: [0, 2, 0] },
];
