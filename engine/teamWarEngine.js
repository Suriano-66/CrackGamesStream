// Moteur 3D « Rouge vs Bleu » — bagarre de bonhommes (Three.js + cannon-es).
//
// Principe : deux camps s'affrontent dans une arène. Chaque cadeau TikTok fait
// apparaître des combattants aux couleurs du camp du viewer, avec sa photo de
// profil sur la tête. Les bonhommes foncent sur l'ennemi le plus proche et se
// battent à coups de poings. Un combattant KO est éliminé pour la manche.
// Le dernier camp encore debout gagne.
//
// Un niveau est une liste de PIÈCES (boîtes) placées dans l'éditeur :
//   { id, role, pos:[x,y,z], size:[l,h,p], rot:[rx,ry,rz]°, color? }
// Rôles : arene | mur | bumper | spawnRouge | spawnBleu
// (les anciens rôles butRouge / butBleu / noyau sont ignorés sans casser)
//
// API publique identique aux autres moteurs, pour être interchangeable :
//   handleEvent, setConnected, resize, dispose, getDebug, setCameraMode,
//   focusPlayer, getBoard, getInfo, startRace, stopRace, setAutoRace, loadLevel
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { creerObjetModele, estModele, collisionModele, estAnimee, animDe, angleAnim, vitesseAnim, vecteurAxe, appliquerAnim } from "./assets.js";

// ----- Paramètres de jeu -----
const MAX_LIVE = 120;          // combattants simultanés (budget de rendu)
const MAX_PER_PLAYER = 25;     // combattants max par viewer
const ROUND_MAX_MS = 90000;    // durée max d'une manche
const INTERMISSION_MS = 9000;  // pause entre deux manches
const COUNTDOWN_MS = 3000;     // 3 · 2 · 1 · BAGARRE
const MIN_PER_TEAM = 3;        // joueurs requis DANS CHAQUE CAMP pour un départ auto
const SPAWN_PER_TICK = 4;      // combattants sortis de la file par frame (compte à rebours)
const D2R = Math.PI / 180;

// ----- Combat -----
const FIGHTER_R = 0.5;         // rayon du corps physique
const FIGHTER_H = 1.9;         // hauteur visuelle
const HP_MAX = 100;
const PUNCH_DAMAGE = 14;
const PUNCH_REACH = 1.75;
const PUNCH_COOLDOWN = 750;    // ms entre deux coups
const PUNCH_WINDUP = 130;      // ms avant que le coup porte
const PUNCH_KNOCKBACK = 5.4;
const WALK_SPEED = 5.6;        // vitesse de marche visée (m/s)
const WALK_ACCEL = 7;          // vivacité de la mise en vitesse
const STUN_MS = 260;           // temps où l'on subit le recul sans se rediriger
const RETARGET_MS = 500;       // fréquence de recherche d'une nouvelle cible

// ----- Rig de caméra -----
// Deux étages d'amortissement, tous deux indépendants du nombre d'images par
// seconde (exp(-dt/tau) et non un lerp à coefficient fixe) : la cible brute est
// d'abord lissée, puis la caméra suit cette cible lissée. Une zone morte et un
// plafond de vitesse empêchent tout à-coup — c'est ce qui distingue un plan de
// diffusion d'une caméra qui saute sur chaque nouvel arrivant.
const CAM_AIM_TAU = 0.85;      // lissage de la cible
const CAM_LOOK_TAU = 0.45;     // lissage du point regardé
const CAM_POS_TAU = 0.7;       // lissage de la position
const CAM_DEADZONE = 1.8;      // sous ce déplacement, la cible ne bouge pas
const CAM_AIM_MAX_SPEED = 13;  // m/s : plafond de déplacement de la cible
const CAM_DIST_TAU = 1.4;      // lissage de la distance de cadrage
const CAM_MIN_SHOT_MS = 6500;  // durée minimale d'un plan
const KO_FALL_MS = 380;        // durée de la chute
const KO_FADE_MS = 900;        // disparition après la chute

export const TEAMS = {
  rouge: { id: "rouge", label: "Rouge", color: "#ff3b5c", hex: 0xff3b5c },
  bleu: { id: "bleu", label: "Bleu", color: "#3ba3ff", hex: 0x3ba3ff },
};

const ROLE_COLORS = {
  arene: 0x2b3350,
  mur: 0x59627f,
  bumper: 0xffc23c,
  spawnRouge: 0x8e1f33,
  spawnBleu: 0x1f4d8e,
};
// Rôles de l'ancienne version (noyau à pousser) : on les affiche en décor.
const LEGACY_ROLES = new Set(["butRouge", "butBleu", "noyau"]);

// Arène de secours si le niveau est vide.
const FALLBACK_PLATFORMS = [
  { id: "sol", role: "arene", pos: [0, 0, 0], size: [46, 2, 66], rot: [0, 0, 0] },
  { id: "murG", role: "mur", pos: [-23.5, 3, 0], size: [1, 6, 66], rot: [0, 0, 0] },
  { id: "murD", role: "mur", pos: [23.5, 3, 0], size: [1, 6, 66], rot: [0, 0, 0] },
  { id: "murN", role: "mur", pos: [0, 3, -33.5], size: [48, 6, 1], rot: [0, 0, 0] },
  { id: "murS", role: "mur", pos: [0, 3, 33.5], size: [48, 6, 1], rot: [0, 0, 0] },
  { id: "spR", role: "spawnRouge", pos: [0, 1.2, -24], size: [38, 0.4, 14], rot: [0, 0, 0] },
  { id: "spB", role: "spawnBleu", pos: [0, 1.2, 24], size: [38, 0.4, 14], rot: [0, 0, 0] },
  { id: "bmp1", role: "bumper", pos: [-12, 2.6, -8], size: [3, 3, 3], rot: [0, 0, 0] },
  { id: "bmp2", role: "bumper", pos: [12, 2.6, 8], size: [3, 3, 3], rot: [0, 0, 0] },
];

// Config des cadeaux, partagée avec la course de billes (réglée par compte
// depuis l'app Streamer). Même forme que côté marbleRaceEngine.
const DEFAULT_GIFT = { byGift: {}, default: null, maxPerPlayer: MAX_PER_PLAYER };

// Nombre de combattants offerts. Si le streamer a défini une règle pour ce
// cadeau, elle prime ; sinon on retombe sur un barème basé sur les diamants.
function fightersForGift(giftName, diamonds, count, cfg) {
  const c = cfg || DEFAULT_GIFT;
  const n = Math.max(1, count || 1);
  const regle =
    c.byGift && giftName && c.byGift[giftName] != null
      ? Number(c.byGift[giftName])
      : c.default != null
        ? Number(c.default)
        : null;
  if (regle != null && isFinite(regle)) return Math.max(0, Math.floor(regle * n));
  const v = Math.max(0, Number(diamonds) || 0) * n;
  if (v < 5) return 1;
  if (v < 20) return 2;
  if (v < 50) return 3;
  if (v < 100) return 5;
  if (v < 300) return 7;
  return 11;
}
function hashInt(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 100000;
  return h;
}

// ---------------------------------------------------------------------------
// Silhouette du bonhomme : géométries fusionnées une seule fois et partagées
// par tous les combattants (sinon 100 bonhommes = des centaines d'objets).
// ---------------------------------------------------------------------------
function mergeBoxes(boxes) {
  // boxes : [{ size:[x,y,z], pos:[x,y,z], shade:number }]
  const parts = [];
  let total = 0;
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]).toNonIndexed();
    g.translate(b.pos[0], b.pos[1], b.pos[2]);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = b.shade;
      col[i * 3 + 1] = b.shade;
      col[i * 3 + 2] = b.shade;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    parts.push(g);
    total += n;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// Corps + jambes + tête. Origine = sous les pieds. Teinte via vertexColors :
// 1.0 = couleur du camp pleine, <1 = plus sombre.
function buildBodyGeometry() {
  return mergeBoxes([
    { size: [0.26, 0.62, 0.28], pos: [-0.17, 0.31, 0], shade: 0.42 }, // jambe G
    { size: [0.26, 0.62, 0.28], pos: [0.17, 0.31, 0], shade: 0.42 },  // jambe D
    { size: [0.74, 0.8, 0.44], pos: [0, 1.02, 0], shade: 1.0 },       // torse
    { size: [0.5, 0.14, 0.34], pos: [0, 1.46, 0], shade: 0.55 },      // cou / col
    { size: [0.62, 0.6, 0.58], pos: [0, 1.85, 0], shade: 0.92 },      // tête
  ]);
}
// Bras : pivot à hauteur d'épaule, origine au niveau du pivot pour pouvoir
// faire tourner tout l'ensemble vers l'avant (coup de poing).
function buildArmsGeometry() {
  return mergeBoxes([
    { size: [0.22, 0.62, 0.24], pos: [-0.53, -0.26, 0], shade: 0.58 },
    { size: [0.22, 0.62, 0.24], pos: [0.53, -0.26, 0], shade: 0.58 },
    { size: [0.27, 0.25, 0.27], pos: [-0.53, -0.64, 0], shade: 1.0 }, // poing G
    { size: [0.27, 0.25, 0.27], pos: [0.53, -0.64, 0], shade: 1.0 },  // poing D
  ]);
}

export function createTeamWar3D(canvas, opts = {}) {
  const onState = opts.onState || (() => {});
  const onPick = opts.onPick || (() => {});
  const controls = !!opts.controls;

  let levelPlatforms =
    opts.level && Array.isArray(opts.level.platforms) && opts.level.platforms.length
      ? opts.level.platforms
      : FALLBACK_PLATFORMS;
  let settings = (opts.level && opts.level.settings) || {};
  let cameraPref = settings.camera || "auto";
  let teamMode = settings.teamMode || "equilibre";
  let giftConfig = Object.assign({}, DEFAULT_GIFT, opts.giftConfig || {});
  const assetsBase = opts.assetsBase || "../assets/models/";
  let disposed = false;

  // ----- Rendu -----
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 4000);
  camera.position.set(0, 26, -52);

  scene.add(new THREE.HemisphereLight(0xd8e6ff, 0x20263c, 1.25));
  const sun = new THREE.DirectionalLight(0xfff4e2, 1.35);
  sun.position.set(-40, 80, -30);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xff7d95, 0.4);
  rim.position.set(40, 25, 55);
  scene.add(rim);

  function buildSky() {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 1024;
    const g = c.getContext("2d");
    const grd = g.createLinearGradient(0, 0, 1024, 1024);
    grd.addColorStop(0, "#331025");
    grd.addColorStop(0.4, "#1d1740");
    grd.addColorStop(0.66, "#14294f");
    grd.addColorStop(1, "#080b16");
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 380; i++) {
      g.globalAlpha = 0.25 + Math.random() * 0.6;
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.arc(Math.random() * 1024, Math.random() * 680, Math.random() * 1.3 + 0.2, 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1800, 40, 20),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }),
      ),
    );
    scene.fog = new THREE.Fog(0x191636, 130, 520);
  }
  buildSky();

  // ----- Physique -----
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -30, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  const matGround = new CANNON.Material("ground");
  const matBody = new CANNON.Material("body");
  const matBumper = new CANNON.Material("bumper");
  // ATTENTION : un corps en fixedRotation avec le moindre frottement de contact
  // est TOTALEMENT bloqué par le solveur de cannon-es (les équations de
  // frottement ne peuvent être satisfaites sans rotation). Les combattants sont
  // donc sans frottement : leur déplacement est piloté en vitesse, et on les
  // freine nous-mêmes. Ne remets pas de friction ici sans relire ce commentaire.
  world.addContactMaterial(new CANNON.ContactMaterial(matGround, matBody, { friction: 0, restitution: 0.02 }));
  world.addContactMaterial(new CANNON.ContactMaterial(matBody, matBody, { friction: 0, restitution: 0.14 }));
  world.addContactMaterial(new CANNON.ContactMaterial(matBumper, matBody, { friction: 0.02, restitution: 1.35 }));

  // Géométries partagées
  const GEO_BODY = buildBodyGeometry();
  const GEO_ARMS = buildArmsGeometry();
  const GEO_FACE = new THREE.PlaneGeometry(0.52, 0.52);

  const S = {
    players: new Map(),
    fighters: [],
    spawnQueue: [],
    pieceMeshes: [],
    animes: [], // obstacles animés : { piece, obj, corps, base }
    pieceBodies: [],
    spawn: { rouge: null, bleu: null },
    center: new THREE.Vector3(0, 0, 0),
    axis: new THREE.Vector3(0, 0, 1), // du camp bleu vers le camp rouge
    span: 50,
    killY: -40,
    phase: "filling", // filling | countdown | battle | intermission
    phaseStart: 0,
    roundStart: 0,
    frozen: false,
    winner: null,
    connected: false,
    autoRace: opts.autoRace !== false,
    nextTeam: "rouge",
    ko: { rouge: 0, bleu: 0 },
    camOverride: null,
    camMode: 0,
    camModeStart: 0,
    camLook: new THREE.Vector3(0, 0, 0),
    camAim: new THREE.Vector3(0, 0, 0),   // cible lissée (zone morte + plafond)
    camDist: 26,                          // distance de cadrage lissée
    camCut: true,                         // vrai = coupe franche (pas de glissé)
    camLastMode: "",
    camHold: new THREE.Vector3(0, 0, 0),  // dernier point connu en mode focus
    focusPlayerId: null,
    lastState: 0,
    seed: 11,
    uid: 1,
    frameDt: 0.016,
    fps: 60,
    free: { pos: new THREE.Vector3(0, 30, -50), yaw: 0, pitch: -0.25, keys: new Set(), fast: false, slow: false },
  };

  function rnd() {
    S.seed = (S.seed * 1103515245 + 12345) & 0x7fffffff;
    return S.seed / 0x7fffffff;
  }
  function teamDef(t) {
    return TEAMS[t] || TEAMS.rouge;
  }

  // ----- Pièces de décor -----
  const matCache = new Map();
  function pieceMat(role, color) {
    const key = (color || "") + "|" + (role || "arene");
    if (matCache.has(key)) return matCache.get(key);
    const base = color ? new THREE.Color(color) : new THREE.Color(ROLE_COLORS[role] ?? ROLE_COLORS.arene);
    const isSpawn = role === "spawnRouge" || role === "spawnBleu";
    const m = new THREE.MeshStandardMaterial({
      color: base,
      roughness: role === "bumper" ? 0.35 : role === "mur" ? 0.55 : 0.9,
      metalness: role === "bumper" ? 0.45 : role === "mur" ? 0.2 : 0.04,
      emissive: role === "bumper" ? base.clone().multiplyScalar(0.4) : base.clone().multiplyScalar(0.07),
      transparent: isSpawn,
      opacity: isSpawn ? 0.85 : 1,
    });
    matCache.set(key, m);
    return m;
  }
  const _unit = new THREE.BoxGeometry(1, 1, 1);
  const _e = new THREE.Euler();
  const _q = new THREE.Quaternion();
  function pieceQuat(rot) {
    _e.set((rot[0] || 0) * D2R, (rot[1] || 0) * D2R, (rot[2] || 0) * D2R, "XYZ");
    _q.setFromEuler(_e);
    return _q;
  }
  function zoneFrom(pl) {
    const size = pl.size || [10, 1, 10];
    return {
      center: new THREE.Vector3(pl.pos[0], pl.pos[1], pl.pos[2]),
      size: new THREE.Vector3(Math.max(0.2, size[0]), Math.max(0.2, size[1]), Math.max(0.2, size[2])),
      quat: pieceQuat(pl.rot || [0, 0, 0]).clone(),
    };
  }

  function clearArena() {
    for (const m of S.pieceMeshes) scene.remove(m);
    for (const b of S.pieceBodies) world.removeBody(b);
    S.pieceMeshes = [];
    S.pieceBodies = [];
    S.animes = [];
  }

  function buildArena() {
    clearArena();
    let minY = Infinity;
    S.spawn = { rouge: null, bleu: null };

    for (const pl of levelPlatforms) {
      const role = pl.role || "arene";
      const size = pl.size || [10, 1, 10];
      const pos = pl.pos || [0, 0, 0];
      const q = pieceQuat(pl.rot || [0, 0, 0]);
      // Les pièces de l'ancienne version ne sont plus que du décor sans collision.
      const legacy = LEGACY_ROLES.has(role);

      // --- Modèle 3D de la bibliothèque ---
      if (estModele(pl)) {
        const obj = creerObjetModele(pl, { base: assetsBase });
        obj.position.set(pos[0], pos[1], pos[2]);
        obj.quaternion.copy(q);
        obj.scale.set(size[0] || 1, size[1] || 1, size[2] || 1);
        scene.add(obj);
        S.pieceMeshes.push(obj);
        const anime = estAnimee(pl);
        if (pl.solid) {
          const col = collisionModele(pl);
          // Un obstacle animé a besoin d'un corps CINÉMATIQUE : un corps
          // statique traverserait les billes sans jamais les projeter.
          const corps = new CANNON.Body({
            mass: 0,
            type: anime ? CANNON.Body.KINEMATIC : CANNON.Body.STATIC,
            material: matGround,
          });
          // La forme est DÉCALÉE par rapport à l'origine du corps : l'origine
          // reste le pivot, donc faire tourner le corps fait balayer le marteau.
          corps.addShape(
            new CANNON.Box(new CANNON.Vec3(col.demi[0], col.demi[1], col.demi[2])),
            new CANNON.Vec3(col.centre[0], col.centre[1], col.centre[2]),
          );
          corps.position.set(pos[0], pos[1], pos[2]);
          corps.quaternion.set(q.x, q.y, q.z, q.w);
          corps.updateMassProperties();
          world.addBody(corps);
          S.pieceBodies.push(corps);
          if (anime) S.animes.push({ piece: pl, obj, corps, base: q.clone() });
        } else if (anime) {
          S.animes.push({ piece: pl, obj, corps: null, base: q.clone() });
        }
        continue;
      }

      const mesh = new THREE.Mesh(_unit, pieceMat(legacy ? "arene" : role, pl.color));
      mesh.scale.set(Math.max(0.2, size[0]), Math.max(0.2, size[1]), Math.max(0.2, size[2]));
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.quaternion.copy(q);
      scene.add(mesh);
      S.pieceMeshes.push(mesh);

      if (!legacy) {
        const body = new CANNON.Body({ mass: 0, material: role === "bumper" ? matBumper : matGround });
        body.addShape(
          new CANNON.Box(
            new CANNON.Vec3(Math.max(0.1, size[0] / 2), Math.max(0.1, size[1] / 2), Math.max(0.1, size[2] / 2)),
          ),
        );
        body.position.set(pos[0], pos[1], pos[2]);
        body.quaternion.set(q.x, q.y, q.z, q.w);
        world.addBody(body);
        S.pieceBodies.push(body);
      }

      if (pos[1] < minY) minY = pos[1];
      if (role === "spawnRouge" && !S.spawn.rouge) S.spawn.rouge = zoneFrom(pl);
      if (role === "spawnBleu" && !S.spawn.bleu) S.spawn.bleu = zoneFrom(pl);
    }

    if (!S.spawn.rouge) S.spawn.rouge = zoneFrom(FALLBACK_PLATFORMS[5]);
    if (!S.spawn.bleu) S.spawn.bleu = zoneFrom(FALLBACK_PLATFORMS[6]);

    const a = S.spawn.bleu.center;
    const b = S.spawn.rouge.center;
    S.center.copy(a).add(b).multiplyScalar(0.5);
    const ax = b.clone().sub(a);
    ax.y = 0;
    S.span = Math.max(12, ax.length());
    S.axis.copy(ax.lengthSq() > 1e-4 ? ax.normalize() : new THREE.Vector3(0, 0, 1));
    S.killY = (isFinite(minY) ? minY : 0) - 35;
  }

  // ----- Visage : photo de profil TikTok (ou initiale) sur la tête -----
  const faceCache = new Map();
  function faceTexture(p) {
    if (faceCache.has(p.id)) return faceCache.get(p.id);
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 128;
    const g = c.getContext("2d");
    if (p.img && p.img.complete && p.img.naturalWidth > 0) {
      try {
        g.drawImage(p.img, 0, 0, 128, 128);
      } catch {
        drawCartoonFace(g, p);
      }
    } else {
      drawCartoonFace(g, p);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const entry = { tex, mat, hasImg: !!(p.img && p.img.complete && p.img.naturalWidth > 0) };
    faceCache.set(p.id, entry);
    return entry;
  }
  // Visage cartoon dessiné : deux yeux, un sourcil froncé, une bouche.
  function drawCartoonFace(g, p) {
    g.clearRect(0, 0, 128, 128);
    g.fillStyle = "#0d1220";
    for (const x of [40, 88]) {
      g.beginPath();
      g.ellipse(x, 54, 11, 13, 0, 0, 7);
      g.fill();
    }
    g.fillStyle = "#ffffff";
    for (const x of [43, 91]) {
      g.beginPath();
      g.arc(x, 50, 4, 0, 7);
      g.fill();
    }
    // sourcils froncés : on est là pour se battre
    g.strokeStyle = "#0d1220";
    g.lineWidth = 7;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(26, 30);
    g.lineTo(52, 40);
    g.moveTo(102, 30);
    g.lineTo(76, 40);
    g.stroke();
    g.lineWidth = 6;
    g.beginPath();
    g.arc(64, 88, 16, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
  }
  function dropFace(id) {
    const f = faceCache.get(id);
    if (!f) return;
    f.tex.dispose();
    f.mat.dispose();
    faceCache.delete(id);
  }

  // ----- Étiquettes de pseudo (une par joueur, sur son combattant de tête) ---
  const labelCache = new Map();
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function labelFor(p) {
    if (labelCache.has(p.id)) return labelCache.get(p.id);
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const g = c.getContext("2d");
    const name = p.name.length > 14 ? p.name.slice(0, 14) : p.name;
    g.font = "700 34px sans-serif";
    const tw = Math.min(236, g.measureText(name).width);
    g.fillStyle = "rgba(8,10,16,.8)";
    roundRect(g, 128 - tw / 2 - 12, 10, tw + 24, 44, 12);
    g.fill();
    g.strokeStyle = teamDef(p.team).color;
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(name, 128, 33, 236);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(2.5, 0.62, 1);
    sprite.visible = false;
    scene.add(sprite);
    const entry = { sprite, tex };
    labelCache.set(p.id, entry);
    return entry;
  }
  function dropLabel(id) {
    const l = labelCache.get(id);
    if (!l) return;
    scene.remove(l.sprite);
    l.tex.dispose();
    labelCache.delete(id);
  }

  // ----- Combattants -----
  // Un matériau PAR COMBATTANT (et non par joueur) : le fondu de KO et le
  // flash d'encaissement modifient le matériau, donc le partager ferait
  // disparaître ou clignoter tous les bonhommes du même viewer d'un coup.
  function bodyMat(p) {
    const col = new THREE.Color(p.color);
    return new THREE.MeshStandardMaterial({
      color: col,
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.05,
      flatShading: true,
      emissive: col.clone().multiplyScalar(0.08),
      transparent: true,
      opacity: 1,
    });
  }

  function spawnFighter(p) {
    if (S.fighters.length >= MAX_LIVE) return;
    if (p.alive >= MAX_PER_PLAYER) return;
    const z = S.spawn[p.team];
    if (!z) return;
    const off = new THREE.Vector3(
      (rnd() - 0.5) * Math.max(2, z.size.x - 2),
      z.size.y / 2 + 0.6,
      (rnd() - 0.5) * Math.max(2, z.size.z - 2),
    ).applyQuaternion(z.quat);
    const start = z.center.clone().add(off);

    const body = new CANNON.Body({
      mass: 1.4,
      material: matBody,
      shape: new CANNON.Sphere(FIGHTER_R),
      linearDamping: 0.12,
      angularDamping: 0.99,
      fixedRotation: true, // un bonhomme ne roule pas
    });
    body.updateMassProperties();
    body.position.set(start.x, start.y + FIGHTER_R, start.z);
    world.addBody(body);
    if (S.frozen) {
      body.type = CANNON.Body.STATIC;
      body.velocity.set(0, 0, 0);
      body.updateMassProperties();
    }

    const mat = bodyMat(p);
    const group = new THREE.Group();
    const bodyMesh = new THREE.Mesh(GEO_BODY, mat);
    group.add(bodyMesh);
    const arms = new THREE.Mesh(GEO_ARMS, mat);
    arms.position.set(0, 1.34, 0); // hauteur d'épaule = pivot des bras
    group.add(arms);
    const face = new THREE.Mesh(GEO_FACE, faceTexture(p).mat.clone());
    face.position.set(0, 1.87, 0.3); // plaqué sur l'avant de la tête
    group.add(face);
    scene.add(group);

    S.fighters.push({
      body,
      group,
      arms,
      face,
      mat,
      playerId: p.id,
      team: p.team,
      hp: HP_MAX,
      targetId: -1,
      nextTarget: 0,
      nextPunch: 0,
      punchAt: 0,      // instant où le coup porte (0 = pas de coup en cours)
      punchStart: 0,   // début de l'animation de coup
      hitFlash: 0,
      stunUntil: 0,
      facing: p.team === "rouge" ? 0 : Math.PI,
      ko: 0,           // instant du KO (0 = debout)
      bob: rnd() * 6.28,
      uid: S.uid++,
    });
    p.alive++;
  }

  function removeFighter(i) {
    const f = S.fighters[i];
    if (!f) return;
    world.removeBody(f.body);
    scene.remove(f.group);
    f.mat.dispose();
    f.face.material.dispose();
    const p = S.players.get(f.playerId);
    if (p && f.ko === 0) p.alive = Math.max(0, p.alive - 1);
    S.fighters.splice(i, 1);
  }
  function removeAllFighters() {
    for (let i = S.fighters.length - 1; i >= 0; i--) removeFighter(i);
    S.spawnQueue.length = 0;
    for (const p of S.players.values()) p.alive = 0;
  }
  function queueSpawns(p, n) {
    for (let i = 0; i < n; i++) S.spawnQueue.push(p.id);
  }
  function unfreezeAll() {
    S.frozen = false;
    for (const f of S.fighters) {
      if (f.body.type === CANNON.Body.STATIC) {
        f.body.type = CANNON.Body.DYNAMIC;
        f.body.mass = 1.4;
        f.body.updateMassProperties();
        f.body.wakeUp();
      }
    }
  }

  // ----- Joueurs / cadeaux -----
  function pickTeam(id) {
    if (teamMode === "pseudo") return hashInt(id) % 2 === 0 ? "rouge" : "bleu";
    if (teamMode === "alterne") {
      const t = S.nextTeam;
      S.nextTeam = t === "rouge" ? "bleu" : "rouge";
      return t;
    }
    let r = 0,
      b = 0;
    for (const p of S.players.values()) (p.team === "rouge" ? r++ : b++);
    if (r < b) return "rouge";
    if (b < r) return "bleu";
    const t = S.nextTeam;
    S.nextTeam = t === "rouge" ? "bleu" : "rouge";
    return t;
  }
  function ensurePlayer(id, name, avatar) {
    let p = S.players.get(id);
    if (!p) {
      const team = pickTeam(id);
      const baseHue = team === "rouge" ? 350 : 210;
      const hue = (baseHue + ((hashInt(id) % 24) - 12) + 360) % 360;
      const light = 46 + (hashInt(name || id) % 13); // 46–58 % : reste franc
      p = {
        id,
        name: name || "Viewer",
        team,
        color: `hsl(${hue}, 88%, ${light}%)`,
        sent: 0,    // total de combattants offerts (classement)
        roster: 0,  // effectif engagé dans la manche
        alive: 0,   // debout en ce moment
        kills: 0,   // KO infligés (classement)
        img: null,
      };
      if (avatar) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = avatar;
        img.onload = () => {
          p.img = img;
          dropFace(p.id); // la prochaine apparition portera la photo
        };
      }
      S.players.set(id, p);
    } else if (name && p.name !== name) {
      p.name = name;
      dropLabel(p.id);
    }
    return p;
  }
  function handleGift(id, name, avatar, giftName, diamonds, count) {
    if (!id) return;
    const p = ensurePlayer(id, name, avatar);
    const n = fightersForGift(giftName, diamonds, count, giftConfig);
    if (n <= 0) return;
    p.sent += n;
    // Le cadeau alimente TOUJOURS l'effectif de la prochaine manche, jamais la
    // manche en cours : une fois lancée, plus personne n'entre sur le terrain.
    const cap = Math.min(MAX_PER_PLAYER, giftConfig.maxPerPlayer || MAX_PER_PLAYER);
    p.roster = Math.min(cap, p.roster + n);
  }
  function handleEvent(e) {
    if (!e) return;
    if (e.type === "gift") handleGift(e.userId, e.nickname, e.avatar, e.giftName, e.diamonds, e.count);
    else if (e.type === "connected") S.connected = true;
    else if (e.type === "disconnected") S.connected = false;
  }

  // ----- IA de mêlée -----
  const _d = new THREE.Vector3();
  const _imp = new CANNON.Vec3();
  function findTarget(f) {
    // Ennemi debout le plus proche. Recherche bornée : on parcourt la liste,
    // c'est O(n²) mais n reste sous MAX_LIVE et seulement toutes les 500 ms.
    let best = null;
    let bestD = Infinity;
    for (const o of S.fighters) {
      if (o.team === f.team || o.ko) continue;
      const dx = o.body.position.x - f.body.position.x;
      const dz = o.body.position.z - f.body.position.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }
  function fighterByUid(uid) {
    if (uid < 0) return null;
    for (const o of S.fighters) if (o.uid === uid) return o;
    return null;
  }
  function applyDamage(target, attacker, now) {
    if (target.ko) return;
    target.hp -= PUNCH_DAMAGE;
    target.hitFlash = now;
    target.stunUntil = now + STUN_MS;
    // recul dans l'axe du coup
    _d.set(
      target.body.position.x - attacker.body.position.x,
      0,
      target.body.position.z - attacker.body.position.z,
    );
    if (_d.lengthSq() > 1e-4) _d.normalize();
    _imp.set(_d.x * PUNCH_KNOCKBACK, 1.6, _d.z * PUNCH_KNOCKBACK);
    target.body.applyImpulse(_imp);
    if (target.hp <= 0) {
      target.ko = now;
      target.hp = 0;
      const tp = S.players.get(target.playerId);
      if (tp) tp.alive = Math.max(0, tp.alive - 1);
      const ap = S.players.get(attacker.playerId);
      if (ap) ap.kills++;
      S.ko[target.team]++;
    }
  }

  function updateFighters(now) {
    const fighting = S.phase === "battle";
    for (const f of S.fighters) {
      if (f.ko) continue;

      // --- cible ---
      if (fighting && now >= f.nextTarget) {
        f.nextTarget = now + RETARGET_MS + rnd() * 220;
        const t = findTarget(f);
        f.targetId = t ? t.uid : -1;
      }
      const target = fighting ? fighterByUid(f.targetId) : null;

      if (!target || target.ko) {
        f.targetId = -1;
        continue;
      }

      _d.set(
        target.body.position.x - f.body.position.x,
        0,
        target.body.position.z - f.body.position.z,
      );
      const dist = _d.length();
      if (dist > 1e-4) _d.multiplyScalar(1 / dist);
      f.facing = Math.atan2(_d.x, _d.z);

      const stunned = now < f.stunUntil;
      if (dist > PUNCH_REACH && !stunned) {
        // --- marche vers l'ennemi (pilotage en vitesse) ---
        const k = Math.min(1, S.frameDt * WALK_ACCEL);
        const v = f.body.velocity;
        v.x += (_d.x * WALK_SPEED - v.x) * k;
        v.z += (_d.z * WALK_SPEED - v.z) * k;
      } else if (!stunned) {
        // au contact : on freine pour rester au corps à corps (pas de frottement)
        const k = Math.min(1, S.frameDt * WALK_ACCEL);
        const v = f.body.velocity;
        v.x -= v.x * k;
        v.z -= v.z * k;
      }
      if (dist <= PUNCH_REACH && now >= f.nextPunch && !f.punchAt) {
        // --- coup de poing (le dégât porte après le temps d'armement) ---
        f.punchAt = now + PUNCH_WINDUP;
        f.punchStart = now;
        f.nextPunch = now + PUNCH_COOLDOWN + rnd() * 260;
      }

      // le coup porte-t-il ?
      if (f.punchAt && now >= f.punchAt) {
        f.punchAt = 0;
        const t2 = fighterByUid(f.targetId);
        if (t2 && !t2.ko) {
          const dx = t2.body.position.x - f.body.position.x;
          const dz = t2.body.position.z - f.body.position.z;
          if (dx * dx + dz * dz <= (PUNCH_REACH + 0.5) * (PUNCH_REACH + 0.5)) applyDamage(t2, f, now);
        }
      }
    }
  }

  // ----- Animation : marche, coup, encaissement, KO -----
  function animateFighters(now) {
    for (let i = S.fighters.length - 1; i >= 0; i--) {
      const f = S.fighters[i];
      const b = f.body.position;

      if (b.y < S.killY) {
        // tombé du plateau : compte comme un KO
        if (!f.ko) {
          const p = S.players.get(f.playerId);
          if (p) p.alive = Math.max(0, p.alive - 1);
          S.ko[f.team]++;
        }
        removeFighter(i);
        continue;
      }

      if (f.ko) {
        const kv = Math.min(1, S.frameDt * 3.2);
        f.body.velocity.x -= f.body.velocity.x * kv;
        f.body.velocity.z -= f.body.velocity.z * kv;
        const t = now - f.ko;
        const fall = Math.min(1, t / KO_FALL_MS);
        f.group.position.set(b.x, b.y - FIGHTER_R, b.z);
        f.group.rotation.set(-Math.PI / 2 * fall, f.facing, 0, "YXZ");
        if (t > KO_FALL_MS) {
          const fade = 1 - Math.min(1, (t - KO_FALL_MS) / KO_FADE_MS);
          f.mat.opacity = fade;
          f.face.material.opacity = fade;
          if (fade <= 0.01) {
            removeFighter(i);
            continue;
          }
        }
        continue;
      }

      // debout
      const speed = Math.hypot(f.body.velocity.x, f.body.velocity.z);
      f.bob += S.frameDt * (4 + speed * 1.7);
      const bounce = speed > 0.4 ? Math.abs(Math.sin(f.bob)) * 0.09 : 0;
      f.group.position.set(b.x, b.y - FIGHTER_R + bounce, b.z);
      f.group.rotation.set(0, f.facing, Math.sin(f.bob) * 0.05 * (speed > 0.4 ? 1 : 0), "YXZ");

      // bras : balancier en marche, détente vers l'avant pendant le coup
      const PUNCH_ANIM_MS = 320;
      const kp = f.punchStart ? (now - f.punchStart) / PUNCH_ANIM_MS : 1;
      if (kp < 1) {
        f.arms.rotation.x = -1.6 * Math.sin(Math.max(0, kp) * Math.PI);
      } else {
        f.punchStart = 0;
        f.arms.rotation.x = Math.sin(f.bob) * 0.35 * (speed > 0.4 ? 1 : 0.12);
      }

      // flash blanc quand on encaisse
      if (f.hitFlash) {
        const k = 1 - Math.min(1, (now - f.hitFlash) / 220);
        if (k <= 0) {
          f.hitFlash = 0;
          f.mat.emissive.setRGB(0, 0, 0);
          f.mat.emissiveIntensity = 1;
        } else {
          f.mat.emissive.setRGB(k, k * 0.75, k * 0.75);
        }
      }
    }
  }

  // ----- Cycle de manche -----
  function teamCounts() {
    let r = 0,
      b = 0;
    for (const f of S.fighters) {
      if (f.ko) continue;
      if (f.team === "rouge") r++;
      else b++;
    }
    return { r, b };
  }
  // Joueurs en attente (ayant offert) par camp.
  function queuedCounts() {
    let r = 0,
      b = 0;
    for (const p of S.players.values()) {
      if (p.roster <= 0) continue;
      if (p.team === "rouge") r++;
      else b++;
    }
    return { r, b };
  }
  // Départ automatique : il faut MIN_PER_TEAM joueurs dans CHAQUE camp.
  function teamsReady() {
    const { r, b } = queuedCounts();
    return r >= MIN_PER_TEAM && b >= MIN_PER_TEAM;
  }
  // Départ manuel (bouton du panneau de contrôle) : un joueur par camp suffit.
  function canForceStart() {
    const { r, b } = queuedCounts();
    return r >= 1 && b >= 1;
  }
  function startCountdown(now) {
    S.phase = "countdown";
    S.phaseStart = now;
    S.frozen = true;
    S.winner = null;
    S.ko = { rouge: 0, bleu: 0 };
    removeAllFighters();
    // On engage l'effectif accumulé, puis on le remet à zéro : pour jouer la
    // manche SUIVANTE, il faudra renvoyer un cadeau.
    for (const p of S.players.values()) {
      p.fielded = p.roster;
      p.kills = 0;
      p.roster = 0;
      if (p.fielded > 0) queueSpawns(p, p.fielded);
    }
    S.camCut = true;
  }
  function startBattle(now) {
    S.phase = "battle";
    S.phaseStart = now;
    S.roundStart = now;
    unfreezeAll();
  }
  function endBattle(now, team) {
    S.phase = "intermission";
    S.phaseStart = now;
    let mvp = null;
    if (team) {
      for (const p of S.players.values()) {
        if (p.team !== team) continue;
        if (!mvp || p.kills > mvp.kills || (p.kills === mvp.kills && p.sent > mvp.sent)) mvp = p;
      }
    }
    S.winner = team
      ? {
          team,
          label: teamDef(team).label,
          color: teamDef(team).color,
          draw: false,
          mvp: mvp ? { name: mvp.name, kills: mvp.kills, sent: mvp.sent } : null,
        }
      : { team: null, label: "Égalité", color: "#dfe6ff", draw: true, mvp: null };
    S.camCut = true;
  }

  // Les joueurs de la manche écoulée sortent de la partie : seuls restent ceux
  // qui ont offert PENDANT la manche (leur cadeau les inscrit pour la suivante).
  function purgePlayers() {
    for (const [id, p] of [...S.players]) {
      if (p.roster > 0) {
        p.fielded = 0;
        p.alive = 0;
        continue;
      }
      S.players.delete(id);
      dropLabel(id);
      dropFace(id);
    }
  }
  function tickPhases(now) {
    if (S.phase === "filling") {
      if (S.autoRace && teamsReady()) startCountdown(now);
      return;
    }
    if (S.phase === "countdown") {
      if (now - S.phaseStart >= COUNTDOWN_MS) startBattle(now);
      return;
    }
    if (S.phase === "battle") {
      const { r, b } = teamCounts();
      // On attend que tout le monde soit entré avant de pouvoir conclure.
      const settled = now - S.roundStart > 1500 && S.spawnQueue.length === 0;
      if (settled && r === 0 && b === 0) return endBattle(now, null);
      if (settled && r === 0) return endBattle(now, "bleu");
      if (settled && b === 0) return endBattle(now, "rouge");
      if (now - S.roundStart >= ROUND_MAX_MS) {
        return endBattle(now, r > b ? "rouge" : b > r ? "bleu" : null);
      }
      return;
    }
    if (S.phase === "intermission") {
      if (now - S.phaseStart >= INTERMISSION_MS) {
        // Fin de la célébration : on retire les joueurs de la manche écoulée.
        purgePlayers();
        S.phase = "filling";
        S.phaseStart = now;
        S.winner = null;
        removeAllFighters();
        S.camCut = true;
      }
    }
  }

  // ----- Classement -----
  function computeBoard(limit) {
    const rows = [];
    for (const p of S.players.values()) {
      rows.push({
        id: p.id,
        name: p.name,
        color: p.color,
        team: p.team,
        teamLabel: teamDef(p.team).label,
        teamColor: teamDef(p.team).color,
        kills: p.kills,
        sent: p.sent,
        roster: p.roster,
        alive: p.alive,
      });
    }
    rows.sort((a, b) => b.kills - a.kills || b.alive - a.alive || b.sent - a.sent);
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows.slice(0, limit || 20);
  }
  function teamStats(t) {
    let players = 0,
      sent = 0,
      alive = 0,
      kills = 0;
    for (const p of S.players.values()) {
      if (p.team !== t) continue;
      players++;
      sent += p.sent;
      alive += p.alive;
      kills += p.kills;
    }
    return { players, sent, alive, kills, ko: S.ko[t] };
  }
  // Rapport de force pour la barre : −1 = les bleus écrasent, +1 = les rouges.
  function forceBalance() {
    const { r, b } = teamCounts();
    if (r + b === 0) return 0;
    return (r - b) / (r + b);
  }

  // ----- Caméras -----
  // Le centre d'intérêt est le barycentre de la mêlée (là où ça se bat).
  const _hot = new THREE.Vector3();
  function hotspot() {
    let n = 0;
    _hot.set(0, 0, 0);
    for (const f of S.fighters) {
      if (f.ko) continue;
      _hot.x += f.body.position.x;
      _hot.y += f.body.position.y;
      _hot.z += f.body.position.z;
      n++;
    }
    if (!n) return _hot.copy(S.center);
    return _hot.multiplyScalar(1 / n);
  }
  // Rayon de la mêlée autour du barycentre : le cadrage s'y adapte, sinon en
  // portrait 9:16 les bonhommes deviennent des points.
  function meleeRadius(center) {
    let m = 0;
    let n = 0;
    for (const f of S.fighters) {
      if (f.ko) continue;
      const dx = f.body.position.x - center.x;
      const dz = f.body.position.z - center.z;
      const d = dx * dx + dz * dz;
      if (d > m) m = d;
      n++;
    }
    if (!n) return 10;
    return Math.max(5, Math.sqrt(m));
  }
  const CAM_CYCLE = ["side", "close", "high"];
  const _camPos = new THREE.Vector3();
  const _camLook = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _tmpA = new THREE.Vector3();
  function sideVector() {
    return _side.set(-S.axis.z, 0, S.axis.x).normalize();
  }

  // Amortissement indépendant du framerate : à tau constant, le résultat est le
  // même à 30 ou à 144 images/seconde (un lerp à coefficient fixe, lui, va deux
  // fois plus vite quand le framerate double).
  function damp(cur, target, tau, dt) {
    cur.lerp(target, 1 - Math.exp(-dt / Math.max(0.001, tau)));
    return cur;
  }
  function dampNum(cur, target, tau, dt) {
    return cur + (target - cur) * (1 - Math.exp(-dt / Math.max(0.001, tau)));
  }

  // Cible paresseuse : zone morte (les micro-mouvements ne bougent pas la
  // caméra) + plafond de vitesse (une cible qui saute à l'autre bout de l'arène
  // ne provoque pas de coup de fouet).
  function updateAim(raw, dt) {
    _tmpA.copy(raw).sub(S.camAim);
    const dist = _tmpA.length();
    if (dist < CAM_DEADZONE) return S.camAim;
    _tmpA.multiplyScalar((dist - CAM_DEADZONE) / dist);
    _tmpA.multiplyScalar(1 - Math.exp(-dt / CAM_AIM_TAU));
    const maxStep = CAM_AIM_MAX_SPEED * dt;
    if (_tmpA.length() > maxStep) _tmpA.setLength(maxStep);
    S.camAim.add(_tmpA);
    return S.camAim;
  }

  function updateCamera(now) {
    const dt = S.frameDt;
    let mode = S.camOverride || cameraPref || "auto";
    if (mode === "auto") {
      // On ne change de plan qu'en pleine bataille, et jamais avant la durée
      // minimale : des coupes trop fréquentes donnent un rendu amateur.
      if (S.phase === "battle" && now - S.camModeStart > CAM_MIN_SHOT_MS) {
        S.camMode = (S.camMode + 1) % CAM_CYCLE.length;
        S.camModeStart = now;
        S.camCut = true;
      }
      mode = CAM_CYCLE[S.camMode];
    }
    if (mode === "free") {
      updateFree();
      S.camLastMode = mode;
      return;
    }
    // Changement de plan = coupe franche, pas un long travelling à travers la
    // carte (c'est ce qui donnait cette impression de caméra qui « part »).
    if (mode !== S.camLastMode) {
      S.camCut = true;
      S.camLastMode = mode;
    }

    // --- point d'intérêt brut ---
    let raw;
    if (mode === "focus" && S.focusPlayerId) {
      const own = S.fighters.filter((x) => x.playerId === S.focusPlayerId && !x.ko);
      if (own.length) {
        _tmpA.set(0, 0, 0);
        for (const x of own) _tmpA.add(new THREE.Vector3(x.body.position.x, x.body.position.y, x.body.position.z));
        _tmpA.multiplyScalar(1 / own.length);
        S.camHold.copy(_tmpA);
      }
      // plus aucun combattant vivant : on reste sur le dernier point connu
      raw = S.camHold;
    } else {
      raw = hotspot();
      S.camHold.copy(raw);
    }
    const aim = updateAim(raw, dt);

    // --- distance de cadrage, elle aussi lissée ---
    const wantDist =
      mode === "focus"
        ? 11
        : Math.min(S.span * 0.95, Math.max(13, meleeRadius(aim) * 1.9 + 9));
    S.camDist = dampNum(S.camDist, wantDist, CAM_DIST_TAU, dt);
    const dist = S.camDist;
    const side = sideVector().clone();

    if (mode === "focus") {
      _camLook.copy(aim).add(new THREE.Vector3(0, 1.1, 0));
      _camPos.copy(aim).addScaledVector(side, dist).add(new THREE.Vector3(0, dist * 0.55, 0));
    } else if (mode === "top") {
      _camLook.copy(aim);
      _camPos.copy(aim).add(new THREE.Vector3(0, dist * 1.35, 0)).addScaledVector(S.axis, -0.001);
    } else if (mode === "front") {
      _camLook.copy(aim).add(new THREE.Vector3(0, 1.4, 0));
      _camPos.copy(aim).addScaledVector(S.axis, -dist * 1.15).add(new THREE.Vector3(0, dist * 0.42, 0));
    } else if (mode === "high") {
      _camLook.copy(aim);
      _camPos.copy(aim).addScaledVector(side, dist * 0.5).add(new THREE.Vector3(0, dist * 1.05, 0));
    } else if (mode === "close") {
      _camLook.copy(aim).add(new THREE.Vector3(0, 1.2, 0));
      _camPos
        .copy(aim)
        .addScaledVector(side, Math.max(9, dist * 0.5))
        .addScaledVector(S.axis, dist * 0.12)
        .add(new THREE.Vector3(0, Math.max(4.5, dist * 0.3), 0));
    } else {
      _camLook.copy(aim).add(new THREE.Vector3(0, 1.3, 0));
      _camPos.copy(aim).addScaledVector(side, dist).add(new THREE.Vector3(0, dist * 0.52, 0));
    }

    if (S.camCut) {
      S.camCut = false;
      S.camAim.copy(raw);
      camera.position.copy(_camPos);
      S.camLook.copy(_camLook);
    } else {
      damp(camera.position, _camPos, CAM_POS_TAU, dt);
      damp(S.camLook, _camLook, CAM_LOOK_TAU, dt);
    }
    camera.lookAt(S.camLook);
  }

  function updateFree() {
    const f = S.free;
    const sp = (f.fast ? 90 : f.slow ? 12 : 34) * S.frameDt;
    const fw = new THREE.Vector3(Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), Math.cos(f.yaw) * Math.cos(f.pitch));
    const rt = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    if (f.keys.has("z") || f.keys.has("w") || f.keys.has("arrowup")) f.pos.addScaledVector(fw, sp);
    if (f.keys.has("s") || f.keys.has("arrowdown")) f.pos.addScaledVector(fw, -sp);
    if (f.keys.has("q") || f.keys.has("a") || f.keys.has("arrowleft")) f.pos.addScaledVector(rt, -sp);
    if (f.keys.has("d") || f.keys.has("arrowright")) f.pos.addScaledVector(rt, sp);
    if (f.keys.has(" ")) f.pos.y += sp;
    if (f.keys.has("c")) f.pos.y -= sp;
    camera.position.copy(f.pos);
    camera.lookAt(f.pos.clone().add(fw));
  }
  let dragging = false;
  function onKeyDown(e) {
    const tag = e.target && e.target.tagName;
    if (tag && /input|textarea|select/i.test(tag)) return;
    S.free.keys.add(e.key.toLowerCase());
    S.free.fast = e.ctrlKey;
    S.free.slow = e.shiftKey;
  }
  function onKeyUp(e) {
    S.free.keys.delete(e.key.toLowerCase());
    S.free.fast = e.ctrlKey;
    S.free.slow = e.shiftKey;
  }
  function onMouseDown(e) {
    if ((S.camOverride || cameraPref) === "free") dragging = true;
    else pickAt(e);
  }
  function onMouseUp() {
    dragging = false;
  }
  function onMouseMove(e) {
    if (!dragging) return;
    S.free.yaw -= e.movementX * 0.0026;
    S.free.pitch = Math.max(-1.45, Math.min(1.45, S.free.pitch - e.movementY * 0.0026));
  }
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pickAt(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(S.fighters.map((f) => f.group), true);
    if (!hits.length) return;
    let obj = hits[0].object;
    while (obj && !S.fighters.some((f) => f.group === obj)) obj = obj.parent;
    const found = S.fighters.find((f) => f.group === obj);
    if (found) {
      focusPlayer(found.playerId);
      onPick(found.playerId);
    }
  }

  // ----- Étiquettes : une par joueur, sur son combattant le plus avancé -----
  function updateLabels() {
    const best = new Map();
    for (const f of S.fighters) {
      if (f.ko) continue;
      const sign = f.team === "rouge" ? 1 : -1;
      const d =
        (f.body.position.x - S.center.x) * S.axis.x * sign + (f.body.position.z - S.center.z) * S.axis.z * sign;
      const cur = best.get(f.playerId);
      if (!cur || d > cur.d) best.set(f.playerId, { f, d });
    }
    // On n'affiche que les 10 joueurs les plus engagés : au-delà, la mêlée
    // disparaît sous les étiquettes.
    const ranked = [...best.entries()].sort((a, b) => {
      const pa = S.players.get(a[0]);
      const pb = S.players.get(b[0]);
      return (pb ? pb.alive : 0) - (pa ? pa.alive : 0);
    });
    const shown = new Set();
    for (const [pid, { f }] of ranked.slice(0, 10)) {
      const p = S.players.get(pid);
      if (!p) continue;
      const lab = labelFor(p);
      lab.sprite.visible = true;
      lab.sprite.position.set(f.body.position.x, f.body.position.y + 1.9, f.body.position.z);
      shown.add(pid);
    }
    for (const [pid, entry] of labelCache) if (!shown.has(pid)) entry.sprite.visible = false;
  }

// ───── Obstacles animés ─────
  // On fait tourner le visuel ET le corps physique, et on renseigne la vitesse
  // angulaire : sans elle, le solveur ne transmet aucune impulsion et le
  // marteau traverserait sans projeter quoi que ce soit.
  const _axeQuat = new THREE.Quaternion();
  const _axeVec = new THREE.Vector3();
  const _qFinal = new THREE.Quaternion();
  function majAnimes(tSec) {
    for (const a of S.animes) {
      const cfg = animDe(a.piece);
      const ang = appliquerAnim(a.obj, a.piece, tSec);
      if (!a.corps) continue;
      const v = vecteurAxe(cfg.axe);
      _axeVec.set(v[0], v[1], v[2]);
      _axeQuat.setFromAxisAngle(_axeVec, ang);
      _qFinal.copy(a.base).multiply(_axeQuat);
      a.corps.quaternion.set(_qFinal.x, _qFinal.y, _qFinal.z, _qFinal.w);
      const w = vitesseAnim(cfg, tSec);
      // l'axe de rotation est exprimé dans le repère de la pièce
      _axeVec.set(v[0], v[1], v[2]).applyQuaternion(a.base).multiplyScalar(w);
      a.corps.angularVelocity.set(_axeVec.x, _axeVec.y, _axeVec.z);
      a.corps.velocity.set(0, 0, 0);
    }
  }

  // ----- Boucle principale -----
  let raf = 0;
  let last = 0;
  let fpsAcc = 0;
  let fpsN = 0;
  function frame(t) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const now = t || performance.now();
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    S.frameDt = dt;
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc > 1) {
      S.fps = Math.round(fpsN / fpsAcc);
      fpsAcc = 0;
      fpsN = 0;
    }

    for (let i = 0; i < SPAWN_PER_TICK && S.spawnQueue.length; i++) {
      const p = S.players.get(S.spawnQueue.shift());
      if (p) spawnFighter(p);
    }

    majAnimes(now / 1000);
    tickPhases(now);
    updateFighters(now);
    world.step(1 / 60, dt, 3);
    animateFighters(now);
    updateLabels();
    updateCamera(now);
    renderer.render(scene, camera);

    if (now - S.lastState > 110) {
      S.lastState = now;
      emitState(now);
    }
  }

  function emitState(now) {
    let timer = 0;
    let count = 0;
    if (S.phase === "battle") timer = Math.max(0, Math.ceil((ROUND_MAX_MS - (now - S.roundStart)) / 1000));
    if (S.phase === "countdown") count = Math.max(1, Math.ceil((COUNTDOWN_MS - (now - S.phaseStart)) / 1000));
    const { r, b } = teamCounts();
    const q = queuedCounts();
    onState({
      phase: S.phase,
      timer,
      count,
      players: S.players.size,
      connected: S.connected,
      progress: forceBalance(),
      winner: S.winner,
      board: computeBoard(8),
      rouge: Object.assign(teamStats("rouge"), { standing: r, queued: q.r }),
      bleu: Object.assign(teamStats("bleu"), { standing: b, queued: q.b }),
      needPerTeam: MIN_PER_TEAM,
      live: S.fighters.length,
    });
  }

  // ----- API publique -----
  function setConnected(v) {
    S.connected = v;
  }
  function getDebug() {
    const { r, b } = teamCounts();
    return {
      phase: S.phase,
      live: S.fighters.length,
      debout: `${r}v${b}`,
      ko: `${S.ko.rouge}/${S.ko.bleu}`,
      queued: S.spawnQueue.length,
      balance: Math.round(forceBalance() * 100) / 100,
      fps: S.fps,
      killY: S.killY,
      cam: [camera.position.x, camera.position.y, camera.position.z].map((v) => Math.round(v * 100) / 100),
      camMode: S.camLastMode,
      // Sonde utile depuis la console développeur du Studio.
      sample: S.fighters.slice(0, 2).map((f) => ({
        team: f.team,
        pos: [f.body.position.x, f.body.position.y, f.body.position.z].map((v) => Math.round(v * 10) / 10),
        vitesse: Math.round(Math.hypot(f.body.velocity.x, f.body.velocity.z) * 10) / 10,
        pv: f.hp,
        cible: f.targetId,
      })),
    };
  }
  function setCameraMode(mode) {
    if (mode === "auto") S.camOverride = null;
    else S.camOverride = mode;
    if (mode === "free") {
      S.free.pos.copy(camera.position);
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      S.free.yaw = Math.atan2(dir.x, dir.z);
      S.free.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    }
  }
  function focusPlayer(id) {
    const changed = (id || null) !== S.focusPlayerId;
    S.focusPlayerId = id || null;
    S.camOverride = id ? "focus" : null;
    if (changed) S.camCut = true; // on coupe sur le joueur au lieu d'y glisser
  }
  function getBoard() {
    return computeBoard(20);
  }
  function getInfo() {
    const { r, b } = teamCounts();
    const q = queuedCounts();
    return {
      phase: S.phase,
      players: S.players.size,
      connected: S.connected,
      autoRace: S.autoRace,
      camMode: S.camOverride || cameraPref,
      focusPlayerId: S.focusPlayerId,
      progress: forceBalance(),
      rouge: Object.assign(teamStats("rouge"), { standing: r, queued: q.r }),
      bleu: Object.assign(teamStats("bleu"), { standing: b, queued: q.b }),
      needPerTeam: MIN_PER_TEAM,
      canStart: canForceStart(),
      teamMode,
      fps: S.fps,
    };
  }
  // Lancement manuel depuis le panneau de contrôle : ignore le seuil auto,
  // mais il faut tout de même au moins un joueur dans chaque camp.
  function startRace() {
    if (S.phase === "countdown" || S.phase === "battle") return false;
    if (!canForceStart()) return false;
    startCountdown(performance.now());
    return true;
  }
  function stopRace() {
    if (S.phase === "battle" || S.phase === "countdown") {
      const { r, b } = teamCounts();
      endBattle(performance.now(), r > b ? "rouge" : b > r ? "bleu" : null);
    }
  }
  function setAutoRace(v) {
    S.autoRace = !!v;
  }
  function setGiftConfig(cfg) {
    if (cfg && typeof cfg === "object") giftConfig = Object.assign({}, giftConfig, cfg);
  }
  function setTeamMode(m) {
    if (m === "equilibre" || m === "alterne" || m === "pseudo") teamMode = m;
  }
  function loadLevel(lvl) {
    if (lvl && Array.isArray(lvl.platforms) && lvl.platforms.length) levelPlatforms = lvl.platforms;
    if (lvl && lvl.settings) {
      settings = lvl.settings;
      cameraPref = settings.camera || "auto";
      if (settings.teamMode) teamMode = settings.teamMode;
    }
    removeAllFighters();
    buildArena();
    S.phase = "filling";
    S.phaseStart = performance.now();
    S.winner = null;
    S.ko = { rouge: 0, bleu: 0 };
    S.camCut = true;
  }
  function resize() {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h || 1;
    camera.updateProjectionMatrix();
  }
  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    if (controls) {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    removeAllFighters();
    clearArena();
    for (const [, l] of labelCache) {
      scene.remove(l.sprite);
      l.tex.dispose();
    }
    labelCache.clear();
    for (const [, f] of faceCache) {
      f.tex.dispose();
      f.mat.dispose();
    }
    faceCache.clear();
    GEO_BODY.dispose();
    GEO_ARMS.dispose();
    GEO_FACE.dispose();
    renderer.dispose();
  }

  // ----- Démarrage -----
  buildArena();
  S.phase = "filling";
  S.phaseStart = performance.now();
  S.camModeStart = S.phaseStart;
  resize();
  window.addEventListener("resize", resize);
  if (controls) {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }
  raf = requestAnimationFrame(frame);

  return {
    handleEvent,
    setConnected,
    resize,
    dispose,
    getDebug,
    setCameraMode,
    focusPlayer,
    getBoard,
    getInfo,
    startRace,
    stopRace,
    setAutoRace,
    setGiftConfig,
    setTeamMode,
    loadLevel,
  };
}
