// Bibliothèque de modèles 3D — partagée par les deux jeux.
//
// Les modèles sont livrés AVEC les applications : un dossier assets/models/
// versionné, et un niveau ne stocke qu'un identifiant ("arbre"). Rien à
// télécharger au lancement, donc rien ne peut manquer en plein live.
//
// Ce fichier est du CODE, recopié depuis le dépôt du site à chaque « npm start ».
// N'y ajoute PAS tes modèles : ils seraient effacés au lancement suivant.
// Le catalogue vit dans assets/models/catalogue.js, à côté des .glb, et il est
// injecté ici au démarrage par definirCatalogue().
//
// Une pièce « modèle » dans un niveau :
//   { id, role:"modele", model:"arbre", pos:[x,y,z], size:[sx,sy,sz],
//     rot:[rx,ry,rz]°, solid:false, anim:{...} }
// `size` est un FACTEUR D'ÉCHELLE (1,1,1 = taille native du fichier).
//
// `anim` anime la pièce autour de SON ORIGINE (le point où tu la poses) :
//   { type:"aucune"|"rotation"|"balancier",
//     axe:"x"|"y"|"z",     axe de rotation
//     sens: 1 | -1,        1 = sens des aiguilles d'une montre vu du dessus
//     vitesse: 15,         tours/minute (rotation) ou allers-retours/minute
//     amplitude: 90,       degrés de part et d'autre (balancier uniquement)
//     phase: 0 }           décalage de départ en degrés, pour désynchroniser
//                          plusieurs obstacles identiques
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Catalogue courant. Tableau VIVANT : on le remplit sur place pour que les
// modules qui l'ont importé voient la mise à jour.
// taille = dimensions natives (mètres) ; centre = décalage du centre par
// rapport à l'origine du modèle. Servent aux collisions et au volume témoin
// sans attendre le chargement du fichier.
export const MODELES = [];

// Modèle de repli : un catalogue absent ne doit jamais empêcher un niveau de
// s'ouvrir, le modèle s'affichera juste avec une collision approximative.
const DEF_REPLI = { id: "?", label: "Modèle", icon: "📦", taille: [1, 1, 1], centre: [0, 0.5, 0] };

// Appelé au démarrage de l'application avec le contenu de
// assets/models/catalogue.js.
export function definirCatalogue(liste) {
  MODELES.length = 0;
  for (const m of liste || []) {
    if (!m || !m.id) continue;
    MODELES.push({
      id: String(m.id),
      label: m.label || m.id,
      icon: m.icon || "📦",
      taille: Array.isArray(m.taille) && m.taille.length === 3 ? m.taille : [1, 1, 1],
      centre: Array.isArray(m.centre) && m.centre.length === 3 ? m.centre : [0, 0.5, 0],
    });
  }
  return MODELES;
}

export function modeleDef(id) {
  return MODELES.find((m) => m.id === id) || MODELES[0] || { ...DEF_REPLI, id: id || "?" };
}

// Dossier des modèles. Les deux applications de bureau ont la même profondeur
// (renderer/ et source/), le site passe son propre chemin public.
const BASE_PAR_DEFAUT = "../assets/models/";

const cache = new Map(); // id -> Promise<THREE.Group>
const loader = new GLTFLoader();

// Signalement des échecs de chargement. Sans ça, un modèle qui ne charge pas
// se contente d'un volume témoin gris et l'utilisateur ne sait pas pourquoi.
let _onErreur = null;
export function surErreurModele(fn) {
  _onErreur = typeof fn === "function" ? fn : null;
}

function chargerScene(id, base) {
  if (cache.has(id)) return cache.get(id);
  const url = (base || BASE_PAR_DEFAUT) + id + ".glb";
  const p = new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => {
        const msg = (err && (err.message || err.type)) || "erreur inconnue";
        console.warn(`[assets] modèle « ${id} » non chargé (${url}) : ${msg}`);
        if (_onErreur) {
          try {
            _onErreur(id, url, msg);
          } catch {}
        }
        resolve(null); // on ne rejette jamais : un modèle manquant ne doit pas
        //               casser le niveau, il sera simplement remplacé par un
        //               volume témoin.
      },
    );
  });
  cache.set(id, p);
  return p;
}

// Volume témoin affiché quand le modèle est absent ou pas encore chargé :
// on voit tout de suite où la pièce se trouve, et le niveau reste éditable.
function volumeTemoin(def) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(def.taille[0], def.taille[1], def.taille[2]),
    new THREE.MeshStandardMaterial({
      color: 0x8a93ad,
      roughness: 0.9,
      transparent: true,
      opacity: 0.35,
      flatShading: true,
    }),
  );
  m.position.set(def.centre[0], def.centre[1], def.centre[2]);
  g.add(m);
  g.userData.temoin = true;
  return g;
}

// Crée l'objet 3D d'une pièce « modèle ».
// Renvoie IMMÉDIATEMENT un groupe (avec un volume témoin), rempli dès que le
// fichier est chargé. Les appelants restent donc entièrement synchrones.
export function creerObjetModele(piece, opts = {}) {
  const def = modeleDef(piece.model);
  // Deux groupes imbriqués : l'extérieur porte la transformation de la pièce
  // (position/rotation/échelle, manipulée par le gizmo), l'intérieur ne porte
  // que l'animation. Sans cette séparation, animer écraserait la rotation
  // réglée par l'utilisateur.
  const groupe = new THREE.Group();
  const anime = new THREE.Group();
  groupe.add(anime);
  groupe.userData.anime = anime;
  anime.add(volumeTemoin(def));
  chargerScene(def.id, opts.base).then((scene) => {
    if (!scene) return; // fichier absent : on garde le volume témoin
    // on retire le témoin et on met le vrai modèle
    for (const enfant of [...anime.children]) anime.remove(enfant);
    const clone = scene.clone(true);
    clone.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        if (opts.teinte && o.material) {
          o.material = o.material.clone();
          o.material.color = new THREE.Color(opts.teinte);
        }
      }
    });
    anime.add(clone);
    if (typeof opts.onCharge === "function") opts.onCharge(groupe);
  });
  return groupe;
}

// Demi-dimensions et décalage de la boîte de collision d'une pièce « modèle »,
// calculés depuis les dimensions natives et l'échelle appliquée.
export function collisionModele(piece) {
  const def = modeleDef(piece.model);
  const s = piece.size || [1, 1, 1];
  return {
    demi: [
      Math.max(0.05, (def.taille[0] * Math.abs(s[0])) / 2),
      Math.max(0.05, (def.taille[1] * Math.abs(s[1])) / 2),
      Math.max(0.05, (def.taille[2] * Math.abs(s[2])) / 2),
    ],
    centre: [def.centre[0] * s[0], def.centre[1] * s[1], def.centre[2] * s[2]],
  };
}

// Une pièce est-elle un modèle 3D ?
export function estModele(piece) {
  return piece && piece.role === "modele";
}

// ───────────────────────── Animations ─────────────────────────

export const ANIM_DEFAUT = {
  type: "aucune",
  axe: "y",
  sens: 1,
  vitesse: 15,
  amplitude: 90,
  phase: 0,
};

export function animDe(piece) {
  const a = (piece && piece.anim) || null;
  if (!a) return { ...ANIM_DEFAUT };
  return {
    type: a.type === "rotation" || a.type === "balancier" ? a.type : "aucune",
    axe: a.axe === "x" || a.axe === "z" ? a.axe : "y",
    sens: Number(a.sens) < 0 ? -1 : 1,
    vitesse: isFinite(Number(a.vitesse)) ? Math.max(0, Number(a.vitesse)) : ANIM_DEFAUT.vitesse,
    amplitude: isFinite(Number(a.amplitude)) ? Number(a.amplitude) : ANIM_DEFAUT.amplitude,
    phase: isFinite(Number(a.phase)) ? Number(a.phase) : 0,
  };
}

export function estAnimee(piece) {
  const a = animDe(piece);
  return a.type !== "aucune" && a.vitesse > 0;
}

// Angle de l'animation à l'instant t (secondes), en RADIANS.
export function angleAnim(anim, t) {
  const a = anim.type ? anim : animDe({ anim });
  const phase = (a.phase * Math.PI) / 180;
  if (a.type === "rotation") {
    // vitesse en tours/minute → radians/seconde
    return phase + a.sens * (a.vitesse / 60) * 2 * Math.PI * t;
  }
  if (a.type === "balancier") {
    const ampl = (a.amplitude * Math.PI) / 180;
    return a.sens * ampl * Math.sin(2 * Math.PI * (a.vitesse / 60) * t + phase);
  }
  return 0;
}

// Vitesse angulaire à l'instant t (radians/seconde) — nécessaire pour que le
// corps physique projette correctement ce qu'il percute.
export function vitesseAnim(anim, t) {
  const a = anim.type ? anim : animDe({ anim });
  if (a.type === "rotation") return a.sens * (a.vitesse / 60) * 2 * Math.PI;
  if (a.type === "balancier") {
    const ampl = (a.amplitude * Math.PI) / 180;
    const w = 2 * Math.PI * (a.vitesse / 60);
    const phase = (a.phase * Math.PI) / 180;
    return a.sens * ampl * w * Math.cos(w * t + phase);
  }
  return 0;
}

export function vecteurAxe(axe) {
  return axe === "x" ? [1, 0, 0] : axe === "z" ? [0, 0, 1] : [0, 1, 0];
}

// Applique l'animation au groupe INTÉRIEUR d'un objet créé par
// creerObjetModele : le groupe extérieur garde la transformation de la pièce
// (c'est lui que manipule le gizmo), l'intérieur ne porte que l'animation.
export function appliquerAnim(objet, piece, t) {
  const inner = objet && objet.userData && objet.userData.anime;
  if (!inner) return 0;
  const a = animDe(piece);
  const ang = angleAnim(a, t);
  inner.rotation.set(0, 0, 0);
  if (a.axe === "x") inner.rotation.x = ang;
  else if (a.axe === "z") inner.rotation.z = ang;
  else inner.rotation.y = ang;
  return ang;
}
