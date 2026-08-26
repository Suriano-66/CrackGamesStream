// Moteur 3D de "La grande course" — Three.js + cannon-es.
// NOUVEAU modèle : le circuit est une liste de PLATEFORMES libres
//   { id, role:"track|start|finish|wall", pos:[x,y,z], size:[w,h,l], rot:[rx,ry,rz]°, color? }
// placées/orientées/étirées dans l'éditeur 3D (façon Roblox).
// Les billes apparaissent au-dessus de la plateforme "start" et l'arrivée
// est la plateforme "finish". Tout est parfaitement lié (chaque plateforme
// est une boîte de collision solide) : plus de trous sous les virages.
import * as THREE from "three";
import * as CANNON from "cannon-es";

// ----- Paramètres -----
const MARBLE_R = 0.42;
const MAX_LIVE = 150;
const MAX_BALLS = 100;
const RACE_MAX_MS = 90000;
const INTERMISSION_MS = 8000;
const CAM_SWITCH_MS = 7000;

// ----- Rig de caméra -----
// Amortissement indépendant du nombre d'images par seconde, cible paresseuse
// (zone morte + plafond de vitesse) et coupe franche au changement de plan.
// Sans ça la caméra sursautait à chaque bille qui apparaissait, parce que le
// point suivi était le barycentre de TOUTES les billes.
const CAM_AIM_TAU = 0.8;
const CAM_LOOK_TAU = 0.45;
const CAM_POS_TAU = 0.65;
const CAM_DEADZONE = 1.4;
const CAM_AIM_MAX_SPEED = 26; // les billes vont vite : plafond plus haut
const CAM_MIN_SHOT_MS = 6500;
const LEAD_HYSTERESIS = 2.5; // avance requise pour changer de bille suivie
const MIN_PLAYERS = 4; // joueurs requis pour un départ automatique
const MIN_FORCE_PLAYERS = 2; // minimum pour un départ manuel depuis le panneau
const COUNTDOWN_MS = 3000; // 3·2·1 avant le GO (billes retenues au départ)
const D2R = Math.PI / 180;

// Circuit de secours minimal (si aucune plateforme n'est fournie).
const FALLBACK_PLATFORMS = [
  { id: "s", role: "start", pos: [0, 16, 0], size: [14, 1, 12], rot: [16, 0, 0] },
  { id: "t", role: "track", pos: [0, 9, 18], size: [14, 1, 24], rot: [16, 0, 0] },
  { id: "f", role: "finish", pos: [0, 3, 36], size: [16, 1, 14], rot: [6, 0, 0] },
];

const ROLE_COLORS = {
  track: 0x3a4670,
  start: 0x2fbf6b,
  finish: 0xffcf40,
  wall: 0xff3c5f,
};

// Config cadeaux → billes (réglable depuis l'app Streamer).
//  byGift : { "Rose": 1, "Lion": 50, ... } (billes par cadeau nommé)
//  default : billes pour un cadeau non listé · maxPerPlayer : plafond par joueur
const DEFAULT_GIFT = { byGift: {}, default: 1, maxPerPlayer: 100 };
function marblesForGift(giftName, count, cfg) {
  const c = cfg || DEFAULT_GIFT;
  const per =
    c.byGift && giftName && c.byGift[giftName] != null
      ? Number(c.byGift[giftName])
      : c.default != null
        ? Number(c.default)
        : 1;
  return Math.max(0, Math.floor((isFinite(per) ? per : 1) * Math.max(1, count || 1)));
}
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function createMarbleRace3D(canvas, opts = {}) {
  const onState = opts.onState || (() => {});
  const onPick = opts.onPick || (() => {});
  // Contrôles temps réel (app Streamer). Off par défaut → Studio/overlay inchangés.
  const controls = !!opts.controls;
  let levelPlatforms =
    opts.level && Array.isArray(opts.level.platforms) && opts.level.platforms.length
      ? opts.level.platforms
      : FALLBACK_PLATFORMS;
  let settings = (opts.level && opts.level.settings) || {};
  let cameraPref = settings.camera || "auto"; // auto|chase|front|side|top|free|focus
  let disposed = false;

  // ----- Rendu -----
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 4000);
  camera.position.set(0, 30, -30);

  scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x1a2030, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-40, 80, -20);
  scene.add(sun);

  // ----- Skybox (procédurale : dégradé + étoiles) -----
  function buildSky() {
    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 1024;
    const g = c.getContext("2d");
    const grd = g.createLinearGradient(0, 0, 0, 1024);
    grd.addColorStop(0, "#0a1030");
    grd.addColorStop(0.45, "#241a4a");
    grd.addColorStop(0.75, "#5b2a63");
    grd.addColorStop(1, "#0b0f1a");
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 500; i++) {
      const x = Math.random() * 1024;
      const y = Math.random() * 620;
      const r = Math.random() * 1.4 + 0.2;
      g.globalAlpha = 0.4 + Math.random() * 0.6;
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1800, 40, 20),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }),
    );
    scene.add(sky);
    scene.fog = new THREE.Fog(0x241a4a, 160, 620);
  }
  buildSky();

  // ----- Physique -----
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -34, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  const matGround = new CANNON.Material("ground");
  const matBall = new CANNON.Material("ball");
  world.addContactMaterial(
    new CANNON.ContactMaterial(matGround, matBall, { friction: 0.16, restitution: 0.05 }),
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(matBall, matBall, { friction: 0.04, restitution: 0.2 }),
  );

  const S = {
    players: new Map(),
    marbles: [],
    spawnQueue: [],
    trackMeshes: [],
    trackBodies: [],
    // repères de spawn / arrivée
    spawnFwd: new THREE.Vector3(0, 0, 1),
    spawnUp: new THREE.Vector3(0, 1, 0),
    spawnRight: new THREE.Vector3(1, 0, 0),
    spawnBase: new THREE.Vector3(0, 16, 0),
    spawnWid: 14,
    spawnLen: 12,
    finishCenter: null,
    finishR: 6,
    killY: -100,
    startDir: new THREE.Vector3(0, 0, 1),
    phase: "filling",
    phaseStart: 0,
    raceStart: 0,
    finishOrder: [],
    camMode: 0,
    camModeStart: 0,
    lastNudge: 0,
    lastState: 0,
    seed: 1,
    winner: null,
    connected: false,
    camLook: new THREE.Vector3(0, 0, 0),
    camDir: new THREE.Vector3(0, 0, 1),
    camAim: new THREE.Vector3(0, 0, 0),  // cible lissée (zone morte + plafond)
    camCut: true,                        // vrai = coupe franche
    camLastMode: "",
    camHold: new THREE.Vector3(0, 0, 0), // dernier point connu
    leadId: null,                        // bille suivie, avec hystérésis
    // Contrôles temps réel
    camOverride: null, // null = suit `cameraPref` ; sinon force un mode
    focusPlayerId: null,
    frozen: false, // billes retenues pendant le compte à rebours
    countdownStart: 0,
    autoRace: opts.autoRace !== false, // true = les courses s'enchaînent seules
    giftConfig: Object.assign({}, DEFAULT_GIFT, opts.giftConfig || {}),
    frameDt: 0.016,
    free: { pos: new THREE.Vector3(0, 40, -30), yaw: 0, pitch: -0.3, keys: new Set(), fast: false, slow: false },
  };

  function rnd() {
    S.seed = (S.seed * 1103515245 + 12345) & 0x7fffffff;
    return S.seed / 0x7fffffff;
  }

  // ----- Matériaux plateformes -----
  const matCache = new Map();
  function platMat(role, color) {
    const key = color || role || "track";
    if (matCache.has(key)) return matCache.get(key);
    const base = color
      ? new THREE.Color(color)
      : new THREE.Color(ROLE_COLORS[role] ?? ROLE_COLORS.track);
    const m = new THREE.MeshStandardMaterial({
      color: base,
      roughness: role === "wall" ? 0.5 : 0.9,
      metalness: role === "wall" ? 0.2 : 0.05,
      emissive: role === "finish" ? new THREE.Color(0x4a3a00) : base.clone().multiplyScalar(0.05),
    });
    matCache.set(key, m);
    return m;
  }

  const _unit = new THREE.BoxGeometry(1, 1, 1);
  const _e = new THREE.Euler();
  const _q = new THREE.Quaternion();
  function platQuat(rot) {
    _e.set((rot[0] || 0) * D2R, (rot[1] || 0) * D2R, (rot[2] || 0) * D2R, "XYZ");
    _q.setFromEuler(_e);
    return _q;
  }

  function clearTrack() {
    for (const m of S.trackMeshes) scene.remove(m);
    for (const b of S.trackBodies) world.removeBody(b);
    S.trackMeshes = [];
    S.trackBodies = [];
  }

  function buildTrack() {
    clearTrack();
    const platforms = levelPlatforms;
    let startPlat = null,
      finishPlat = null,
      highPlat = null,
      lowPlat = null;
    let minY = Infinity,
      highY = -Infinity,
      lowY = Infinity;

    for (const pl of platforms) {
      const size = pl.size || [10, 1, 10];
      const pos = pl.pos || [0, 0, 0];
      const q = platQuat(pl.rot || [0, 0, 0]);
      const mesh = new THREE.Mesh(_unit, platMat(pl.role, pl.color));
      mesh.scale.set(Math.max(0.2, size[0]), Math.max(0.2, size[1]), Math.max(0.2, size[2]));
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.quaternion.copy(q);
      scene.add(mesh);
      S.trackMeshes.push(mesh);

      const body = new CANNON.Body({ mass: 0, material: matGround });
      body.addShape(
        new CANNON.Box(
          new CANNON.Vec3(
            Math.max(0.1, size[0] / 2),
            Math.max(0.1, size[1] / 2),
            Math.max(0.1, size[2] / 2),
          ),
        ),
      );
      body.position.set(pos[0], pos[1], pos[2]);
      body.quaternion.set(q.x, q.y, q.z, q.w);
      world.addBody(body);
      S.trackBodies.push(body);

      if (pos[1] < minY) minY = pos[1];
      if (pos[1] > highY) {
        highY = pos[1];
        highPlat = pl;
      }
      if (pos[1] < lowY) {
        lowY = pos[1];
        lowPlat = pl;
      }
      if (pl.role === "start" && !startPlat) startPlat = pl;
      if (pl.role === "finish" && !finishPlat) finishPlat = pl;
    }

    // --- Repère de spawn depuis la plateforme de départ (ou la plus haute) ---
    const sp = startPlat || highPlat || FALLBACK_PLATFORMS[0];
    {
      const q = platQuat(sp.rot || [0, 0, 0]);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
      // direction de descente = gravité projetée sur la surface
      let fwd = new THREE.Vector3(0, -1, 0);
      fwd.addScaledVector(up, -fwd.dot(up));
      if (fwd.lengthSq() < 1e-4) fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
      const center = new THREE.Vector3(sp.pos[0], sp.pos[1], sp.pos[2]);
      const topCenter = center.clone().addScaledVector(up, (sp.size ? sp.size[1] : 1) / 2);
      S.spawnFwd = fwd;
      S.spawnUp = up;
      S.spawnRight = right;
      S.spawnBase = topCenter;
      S.spawnWid = sp.size ? sp.size[0] : 12;
      S.spawnLen = sp.size ? sp.size[2] : 12;
      S.startDir = fwd.clone();
    }

    // --- Arrivée : plateforme "finish" (ou la plus basse) ---
    const fp = finishPlat || lowPlat;
    if (fp) {
      S.finishCenter = new THREE.Vector3(fp.pos[0], fp.pos[1], fp.pos[2]);
      S.finishR = Math.max(fp.size ? fp.size[0] : 12, fp.size ? fp.size[2] : 12) / 2 + 2.5;
    } else {
      S.finishCenter = null;
      S.finishR = 6;
    }
    S.killY = minY - 40;
  }

  // Progression : plus la bille est proche de l'arrivée, plus le score est haut.
  function progressOf(pos) {
    if (S.finishCenter) {
      const dx = pos.x - S.finishCenter.x;
      const dy = pos.y - S.finishCenter.y;
      const dz = pos.z - S.finishCenter.z;
      return -Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return -pos.y;
  }

  // ----- Billes -----
  const ballGeo = new THREE.SphereGeometry(MARBLE_R, 14, 14);
  function spawnMarble(p) {
    if (S.marbles.length >= MAX_LIVE) return;
    const fwd = S.spawnFwd,
      up = S.spawnUp,
      right = S.spawnRight,
      base = S.spawnBase;
    const lateral = (rnd() - 0.5) * Math.max(2, S.spawnWid - 2);
    const backd = 1 + rnd() * Math.min(7, S.spawnLen * 0.42); // vers l'amont
    const start = base
      .clone()
      .addScaledVector(fwd, -backd)
      .addScaledVector(right, lateral)
      .addScaledVector(up, 1.0 + rnd() * 0.9);
    const body = new CANNON.Body({
      mass: 1,
      material: matBall,
      shape: new CANNON.Sphere(MARBLE_R),
      linearDamping: 0.04,
      angularDamping: 0.3,
    });
    body.position.set(start.x, start.y, start.z);
    body.velocity.set(fwd.x * 2, fwd.y * 2, fwd.z * 2);
    world.addBody(body);
    // Compte à rebours : la bille est gelée au départ jusqu'au GO.
    if (S.frozen) {
      body.type = CANNON.Body.STATIC;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.updateMassProperties();
    }
    const col = new THREE.Color(p.color);
    const mesh = new THREE.Mesh(
      ballGeo,
      new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.2,
        metalness: 0.4,
        emissive: col.clone().multiplyScalar(0.18),
      }),
    );
    scene.add(mesh);
    S.marbles.push({ body, mesh, playerId: p.id, finished: false });
  }
  function queueSpawns(p, n) {
    for (let i = 0; i < n; i++) S.spawnQueue.push(p);
  }

  // ----- Avatars -----
  const avatarCache = new Map();
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function avatarTexture(p) {
    if (avatarCache.has(p.id)) return avatarCache.get(p.id);
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 320;
    const g = c.getContext("2d");
    g.fillStyle = p.color;
    g.beginPath();
    g.arc(128, 104, 92, 0, 7);
    g.fill();
    if (p.img && p.img.complete && p.img.naturalWidth > 0) {
      g.save();
      g.beginPath();
      g.arc(128, 104, 88, 0, 7);
      g.clip();
      try {
        g.drawImage(p.img, 40, 16, 176, 176);
      } catch {}
      g.restore();
    } else {
      g.fillStyle = "#fff";
      g.font = "700 104px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText((p.name[0] || "?").toUpperCase(), 128, 112);
    }
    g.lineWidth = 8;
    g.strokeStyle = "rgba(255,255,255,.9)";
    g.beginPath();
    g.arc(128, 104, 92, 0, 7);
    g.stroke();
    const name = p.name.length > 12 ? p.name.slice(0, 12) : p.name;
    g.font = "700 38px sans-serif";
    const tw = g.measureText(name).width;
    g.fillStyle = "rgba(8,10,16,.82)";
    roundRect(g, 128 - tw / 2 - 14, 222, tw + 28, 54, 14);
    g.fill();
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(name, 128, 249);
    if (p.full) g.fillText("⚠️", 128 + tw / 2 + 30, 249);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
    );
    sprite.scale.set(2.6, 3.25, 1);
    const entry = { sprite, tex, full: p.full, hasImg: !!(p.img && p.img.complete) };
    avatarCache.set(p.id, entry);
    scene.add(sprite);
    return entry;
  }

  // ----- Joueurs / cadeaux -----
  function ensurePlayer(id, name, avatar) {
    let p = S.players.get(id);
    if (!p) {
      const hue = Math.round((S.players.size * 137.508 + (hashHue(id) % 40)) % 360);
      p = { id, name: name || "Viewer", color: `hsl(${hue}, 85%, 60%)`, ballCount: 0, pending: 0, full: false, finishRank: null, img: null };
      if (avatar) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = avatar;
        p.img = img;
      }
      S.players.set(id, p);
    }
    return p;
  }
  function handleGift(userId, nickname, avatar, giftName, count) {
    const p = ensurePlayer(userId, nickname, avatar);
    // Fusion : la config de cadeaux par compte (côté collègue) s'applique
    // désormais à la file d'attente et non plus à la course en cours.
    const cap = Math.min(MAX_BALLS, S.giftConfig.maxPerPlayer || MAX_BALLS);
    if (p.pending >= cap) {
      p.full = true;
      return;
    }
    // Le cadeau alimente la course SUIVANTE, jamais celle en cours : une fois
    // le départ donné, plus aucune bille n'apparaît.
    p.pending = Math.min(cap, p.pending + marblesForGift(giftName, count, S.giftConfig));
    if (p.pending >= cap) p.full = true;
  }
  // Joueurs ayant des billes en attente pour la prochaine course.
  function queuedPlayers() {
    let n = 0;
    for (const p of S.players.values()) if (p.pending > 0) n++;
    return n;
  }
  // Retire les joueurs de la course écoulée : pour la suivante, il faut avoir
  // renvoyé un cadeau.
  function purgePlayers() {
    for (const [id, p] of [...S.players]) {
      if (p.pending > 0) {
        p.ballCount = 0;
        p.finishRank = null;
        p.full = false;
        continue;
      }
      S.players.delete(id);
      const a = avatarCache.get(id);
      if (a) {
        scene.remove(a.sprite);
        a.tex.dispose();
        avatarCache.delete(id);
      }
    }
  }

  function removeAllMarbles() {
    for (const m of S.marbles) {
      world.removeBody(m.body);
      scene.remove(m.mesh);
      m.mesh.material.dispose();
    }
    S.marbles = [];
  }
  function startRace(now) {
    S.seed = Math.floor((now % 100000) + S.players.size * 7 + 3);
    S.finishOrder = [];
    S.winner = null;
    S.spawnQueue = [];
    for (const p of S.players.values()) p.finishRank = null;
    removeAllMarbles();
    buildTrack();
    S.camDir.set(S.startDir.x, 0, S.startDir.z);
    if (S.camDir.lengthSq() < 0.001) S.camDir.set(0, 0, 1);
    S.camDir.normalize();
    // On engage les billes accumulées et on remet la file à zéro : pour courir
    // la manche suivante, il faudra renvoyer un cadeau.
    let engaged = 0;
    for (const p of S.players.values()) {
      p.ballCount = p.pending;
      p.pending = 0;
      p.full = false;
      if (p.ballCount > 0) {
        queueSpawns(p, p.ballCount);
        engaged++;
      }
    }
    const enough = engaged >= MIN_FORCE_PLAYERS;
    S.frozen = enough;
    S.phase = enough ? "countdown" : "filling";
    S.camCut = true;
    S.phaseStart = now;
    S.countdownStart = now;
    S.raceStart = now; // recalé au GO
    S.camMode = 0;
    S.camModeStart = now;
  }
  // GO : on lâche les billes retenues.
  function releaseRace(now) {
    S.frozen = false;
    for (const m of S.marbles) {
      m.body.type = CANNON.Body.DYNAMIC;
      m.body.updateMassProperties();
      m.body.wakeUp();
      m.body.velocity.set(S.spawnFwd.x * 3, S.spawnFwd.y * 3, S.spawnFwd.z * 3);
    }
    S.phase = "racing";
    S.raceStart = now;
    S.phaseStart = now;
    S.camModeStart = now;
  }
  function endRace(now) {
    S.phase = "intermission";
    S.phaseStart = now;
    S.winner = S.finishOrder[0] || null;
  }

  // ----- Caméra -----
  const _v = new THREE.Vector3();
  const _c = new THREE.Vector3();
  // (packInfo/barycentre supprimé : c'était lui qui faisait sauter la caméra à
  // chaque bille qui apparaissait ou disparaissait. On suit la bille de tête.)
  const AUTO_SEQ = ["chase", "front", "side", "chase", "top"];
  const _side = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  // ----- Caméra libre (vol ZQSD + Ctrl/Shift, look à la souris) -----
  function freeForward() {
    const f = S.free;
    return new THREE.Vector3(
      Math.cos(f.pitch) * Math.sin(f.yaw),
      Math.sin(f.pitch),
      Math.cos(f.pitch) * Math.cos(f.yaw),
    );
  }
  function updateFree() {
    const f = S.free;
    const fwd = freeForward();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const speed = 30 * (f.fast ? 3 : 1) * (f.slow ? 0.3 : 1) * S.frameDt;
    const move = new THREE.Vector3();
    if (f.keys.has("z") || f.keys.has("w")) move.add(fwd);
    if (f.keys.has("s")) move.sub(fwd);
    if (f.keys.has("q") || f.keys.has("a")) move.sub(right);
    if (f.keys.has("d")) move.add(right);
    if (f.keys.has(" ")) move.y += 1;
    if (f.keys.has("c")) move.y -= 1;
    if (move.lengthSq() > 0) f.pos.addScaledVector(move.normalize(), speed);
    camera.position.copy(f.pos);
    camera.lookAt(f.pos.clone().add(fwd));
  }
  function leadMarbleOf(pid) {
    let best = -Infinity,
      fm = null;
    for (const m of S.marbles) {
      if (m.playerId === pid) {
        const pr = progressOf(m.body.position);
        if (pr > best) {
          best = pr;
          fm = m;
        }
      }
    }
    return fm;
  }

  // Amortissement indépendant du framerate (exp(-dt/tau)) : à tau constant le
  // rendu est le même à 30 ou à 144 images/seconde.
  function damp(cur, target, tau, dt) {
    cur.lerp(target, 1 - Math.exp(-dt / Math.max(0.001, tau)));
    return cur;
  }
  const _aimTmp = new THREE.Vector3();
  // Cible paresseuse : en dessous de la zone morte on ne bouge pas, et la cible
  // ne peut pas se déplacer plus vite que CAM_AIM_MAX_SPEED — donc aucun coup
  // de fouet quand la bille suivie change ou qu'une bille disparaît.
  function updateAim(raw, dt) {
    _aimTmp.copy(raw).sub(S.camAim);
    const d = _aimTmp.length();
    if (d < CAM_DEADZONE) return S.camAim;
    _aimTmp.multiplyScalar((d - CAM_DEADZONE) / d);
    _aimTmp.multiplyScalar(1 - Math.exp(-dt / CAM_AIM_TAU));
    const maxStep = CAM_AIM_MAX_SPEED * dt;
    if (_aimTmp.length() > maxStep) _aimTmp.setLength(maxStep);
    S.camAim.add(_aimTmp);
    return S.camAim;
  }
  // Bille suivie : on ne change de leader que s'il prend une avance nette, sinon
  // la caméra oscillait entre deux billes au coude à coude.
  function stableLead() {
    let cur = null;
    let best = null;
    let bestProg = -Infinity;
    for (const m of S.marbles) {
      if (m.finished) continue;
      const prog = progressOf(m.body.position);
      if (m.playerId === S.leadId && !cur) cur = { m, prog };
      if (prog > bestProg) {
        bestProg = prog;
        best = { m, prog };
      }
    }
    if (!best) return null;
    if (cur && bestProg < cur.prog + LEAD_HYSTERESIS) return cur.m;
    S.leadId = best.m.playerId;
    return best.m;
  }

  function updateCamera(now) {
    const dt = S.frameDt;
    let mode = S.camOverride || cameraPref || "auto";
    if (mode === "free") {
      updateFree();
      S.camLastMode = mode;
      return;
    }
    if (mode === "auto") {
      if (S.phase === "racing" && now - S.camModeStart > CAM_MIN_SHOT_MS) {
        S.camMode = (S.camMode + 1) % AUTO_SEQ.length;
        S.camModeStart = now;
        S.camCut = true;
      }
      mode = AUTO_SEQ[S.camMode % AUTO_SEQ.length];
    }
    if (mode !== S.camLastMode) {
      S.camCut = true;
      S.camLastMode = mode;
    }

    const racing = S.phase === "racing" || S.phase === "intermission" || S.phase === "countdown";
    let focusM = null;
    let raw;
    if (racing && S.marbles.length) {
      if ((S.camOverride || cameraPref) === "focus" && S.focusPlayerId) {
        focusM = leadMarbleOf(S.focusPlayerId);
      }
      if (!focusM) focusM = stableLead();
      if (focusM) {
        S.camHold.set(focusM.body.position.x, focusM.body.position.y, focusM.body.position.z);
      }
      raw = S.camHold;
    } else {
      // pas de billes : on cadre le haut du circuit, sans bouger
      S.camHold.copy(S.spawnBase);
      raw = S.camHold;
    }
    const c = updateAim(raw, dt);

    // Direction suivie : vitesse horizontale de la bille suivie, fortement
    // lissée, pour que le plan ne pivote pas à chaque rebond.
    _tan.set(focusM ? focusM.body.velocity.x : 0, 0, focusM ? focusM.body.velocity.z : 0);
    if (_tan.lengthSq() < 0.6) _tan.copy(S.camDir);
    _tan.normalize();
    damp(S.camDir, _tan, 1.1, dt);
    S.camDir.y = 0;
    if (S.camDir.lengthSq() < 0.001) S.camDir.set(0, 0, 1);
    S.camDir.normalize();
    const d = S.camDir;
    _side.set(d.z, 0, -d.x).normalize();

    const camPos = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (!racing || !S.marbles.length) {
      camPos.copy(S.spawnBase).addScaledVector(S.spawnFwd, -16);
      camPos.y = S.spawnBase.y + 15;
      look.copy(S.spawnBase).addScaledVector(S.spawnFwd, 10);
    } else if (mode === "front") {
      camPos.copy(c).addScaledVector(d, 17).addScaledVector(_side, 5);
      camPos.y = c.y + 9;
      look.copy(c).addScaledVector(d, -2);
      look.y = c.y - 1;
    } else if (mode === "side") {
      camPos.copy(c).addScaledVector(_side, 26).addScaledVector(d, 2);
      camPos.y = c.y + 11;
      look.copy(c);
      look.y = c.y - 2;
    } else if (mode === "top") {
      camPos.copy(c).addScaledVector(d, -6);
      camPos.y = c.y + 46;
      look.copy(c).addScaledVector(d, 4);
      look.y = c.y - 6;
    } else if (mode === "focus") {
      camPos.copy(c).addScaledVector(d, -13).addScaledVector(_side, 7);
      camPos.y = c.y + 8;
      look.copy(c).addScaledVector(d, 6);
      look.y = c.y - 1;
    } else {
      camPos.copy(c).addScaledVector(d, -23);
      camPos.y = c.y + 19;
      look.copy(c).addScaledVector(d, 12);
      look.y = c.y - 6;
    }

    if (S.camCut) {
      S.camCut = false;
      S.camAim.copy(raw);
      camera.position.copy(camPos);
      S.camLook.copy(look);
    } else {
      damp(camera.position, camPos, CAM_POS_TAU, dt);
      damp(S.camLook, look, CAM_LOOK_TAU, dt);
    }
    camera.lookAt(S.camLook);
  }

  function computeBoard(limit) {
    const arrived = S.finishOrder.slice();
    const aset = new Set(arrived.map((p) => p.id));
    const racing = [...S.players.values()]
      .filter((p) => !aset.has(p.id))
      .map((p) => {
        let best = -Infinity;
        for (const m of S.marbles)
          if (m.playerId === p.id) {
            const pr = progressOf(m.body.position);
            if (pr > best) best = pr;
          }
        return { p, prog: best };
      })
      .sort((a, b) => b.prog - a.prog)
      .map((o) => o.p);
    return [...arrived, ...racing].slice(0, limit || 12).map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      color: p.color,
      balls: p.ballCount || p.pending,
      full: p.full,
      finished: p.finishRank != null,
      avatar: p.img && p.img.complete ? p.img.src : null,
    }));
  }
  function emitState(now) {
    const ordered = computeBoard(12);
    let timer = 0;
    if (S.phase === "racing") timer = Math.max(0, Math.ceil((RACE_MAX_MS - (now - S.raceStart)) / 1000));
    onState({
      phase: S.phase,
      timer,
      count: S.phase === "countdown" ? Math.max(1, Math.ceil((COUNTDOWN_MS - (now - S.countdownStart)) / 1000)) : 0,
      connected: S.connected,
      players: S.players.size,
      queued: queuedPlayers(),
      need: MIN_PLAYERS,
      board: ordered,
      winner: S.winner
        ? { name: S.winner.name, color: S.winner.color, avatar: S.winner.img && S.winner.img.complete ? S.winner.img.src : null }
        : null,
    });
  }

  // ----- Boucle -----
  let raf = 0;
  let last = performance.now();
  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    S.frameDt = dt;

    if (S.phase === "countdown") {
      if (now - S.countdownStart >= COUNTDOWN_MS) releaseRace(now);
    } else if (S.phase === "filling") {
      // Démarre quand assez de joueurs différents ont des billes EN ATTENTE.
      if (S.autoRace && queuedPlayers() >= MIN_PLAYERS && now - S.phaseStart > 2500) startRace(now);
    } else if (S.phase === "racing") {
      const active = S.marbles.filter((m) => !m.finished);
      if ((active.length === 0 && S.marbles.length > 0) || now - S.raceStart > RACE_MAX_MS) endRace(now);
      if (S.marbles.length === 0 && now - S.raceStart > 6000) endRace(now);
    } else if (S.phase === "intermission") {
      // Fin de la célébration : on retire les joueurs de la course écoulée,
      // puis on repasse en attente. La course suivante ne part que sur de
      // nouveaux cadeaux.
      if (now - S.phaseStart > INTERMISSION_MS) {
        purgePlayers();
        removeAllMarbles();
        S.finishOrder = [];
        S.winner = null;
        S.phase = "filling";
        S.phaseStart = now;
        S.camCut = true;
      }
    }

    // Les billes n'apparaissent qu'au moment du placement (compte à rebours) :
    // jamais pendant la course.
    if (S.phase === "countdown" || S.phase === "filling") {
      let budget = 4;
      while (budget-- > 0 && S.spawnQueue.length) spawnMarble(S.spawnQueue.shift());
    } else if (S.spawnQueue.length) {
      S.spawnQueue.length = 0;
    }

    world.step(1 / 60, dt, 3);

    const doNudge = now - S.lastNudge > 700;
    if (doNudge) S.lastNudge = now;
    for (const m of S.marbles) {
      if (m.finished) continue;
      const bp = m.body.position;
      m.mesh.position.set(bp.x, bp.y, bp.z);
      m.mesh.quaternion.set(m.body.quaternion.x, m.body.quaternion.y, m.body.quaternion.z, m.body.quaternion.w);
      // Plafond de vitesse : évite l'éjection des billes dans les virages.
      const vel = m.body.velocity;
      const sp = Math.hypot(vel.x, vel.y, vel.z);
      if (sp > 24) {
        const kk = 24 / sp;
        vel.x *= kk;
        vel.y *= kk;
        vel.z *= kk;
      }
      // Arrivée
      if (S.finishCenter) {
        const dx = bp.x - S.finishCenter.x;
        const dy = bp.y - S.finishCenter.y;
        const dz = bp.z - S.finishCenter.z;
        if (dx * dx + dy * dy + dz * dz < S.finishR * S.finishR) {
          m.finished = true;
          const p = S.players.get(m.playerId);
          if (p && p.finishRank == null) {
            p.finishRank = S.finishOrder.length + 1;
            S.finishOrder.push(p);
          }
          world.removeBody(m.body);
          scene.remove(m.mesh);
          continue;
        }
      }
      // Chute hors circuit
      if (bp.y < S.killY) {
        m.finished = true;
        world.removeBody(m.body);
        scene.remove(m.mesh);
        continue;
      }
      if (doNudge) {
        const v = m.body.velocity;
        if (Math.hypot(v.x, v.y, v.z) < 0.7) {
          v.x += (rnd() - 0.5) * 4;
          v.z += (rnd() - 0.5) * 4;
          v.y += 1;
        }
      }
    }
    S.marbles = S.marbles.filter((m) => !m.finished);

    // Avatars sur la bille de tête de chaque joueur
    const lead = new Map();
    for (const m of S.marbles) {
      const prog = progressOf(m.body.position);
      const prev = lead.get(m.playerId);
      if (!prev || prog > prev.prog) lead.set(m.playerId, { m, prog });
    }
    for (const [, entry] of avatarCache) entry.sprite.visible = false;
    for (const [pid, o] of lead) {
      const p = S.players.get(pid);
      if (!p) continue;
      let a = avatarTexture(p);
      if (a.full !== p.full || (!a.hasImg && p.img && p.img.complete)) {
        avatarCache.delete(pid);
        scene.remove(a.sprite);
        a = avatarTexture(p);
      }
      a.sprite.visible = true;
      a.sprite.position.set(o.m.body.position.x, o.m.body.position.y + 1.7, o.m.body.position.z);
    }

    updateCamera(now);
    renderer.render(scene, camera);

    if (now - S.lastState > 220) {
      S.lastState = now;
      emitState(now);
    }
  }

  // ----- API -----
  function handleEvent(e) {
    if (e && e.type === "gift") handleGift(e.userId, e.nickname, e.avatar, e.giftName, e.count);
    else if (e && e.type === "connected") S.connected = true;
    else if (e && e.type === "disconnected") S.connected = false;
  }
  function setConnected(v) {
    S.connected = v;
  }
  function getDebug() {
    let minY = Infinity,
      maxY = -Infinity;
    for (const m of S.marbles) {
      const y = m.body.position.y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {
      phase: S.phase,
      live: S.marbles.length,
      finished: S.finishOrder.length,
      killY: S.killY,
      minY: S.marbles.length ? minY : null,
      maxY: S.marbles.length ? maxY : null,
      queued: queuedPlayers(),
      cam: [camera.position.x, camera.position.y, camera.position.z].map((v) => Math.round(v * 100) / 100),
      camMode: S.camLastMode,
    };
  }

  // ----- Contrôles temps réel (app Streamer) -----
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
    if (changed) {
      S.camCut = true; // on coupe sur la bille au lieu d'y glisser
      if (id) S.leadId = id;
    }
  }
  function getBoard() {
    return computeBoard(20);
  }
  function getInfo() {
    return {
      phase: S.phase,
      players: S.players.size,
      connected: S.connected,
      autoRace: S.autoRace,
      camMode: S.camOverride || cameraPref,
      focusPlayerId: S.focusPlayerId,
      queued: queuedPlayers(),
      need: MIN_PLAYERS,
      canStart: queuedPlayers() >= MIN_FORCE_PLAYERS,
    };
  }
  // Départ manuel depuis le panneau de contrôle : ignore le seuil automatique.
  function startRaceNow() {
    if (S.phase === "countdown" || S.phase === "racing") return false;
    if (queuedPlayers() < MIN_FORCE_PLAYERS) return false;
    startRace(performance.now());
    return true;
  }
  function stopRaceNow() {
    if (S.phase === "racing") endRace(performance.now());
  }
  function setAutoRace(v) {
    S.autoRace = !!v;
  }
  function setGiftConfig(cfg) {
    if (cfg && typeof cfg === "object") S.giftConfig = Object.assign({}, S.giftConfig, cfg);
  }
  function loadLevel(lvl) {
    if (lvl && Array.isArray(lvl.platforms) && lvl.platforms.length) levelPlatforms = lvl.platforms;
    if (lvl && lvl.settings) {
      settings = lvl.settings;
      cameraPref = settings.camera || "auto";
    }
    removeAllMarbles();
    buildTrack();
    S.finishOrder = [];
    S.winner = null;
    S.spawnQueue = [];
    S.phase = "filling";
    S.phaseStart = performance.now();
    S.camCut = true;
  }

  // Entrées clavier/souris (uniquement si controls=true)
  const pickRay = new THREE.Raycaster();
  const pickNdc = new THREE.Vector2();
  function pickAt(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pickNdc.x = ((cx - rect.left) / rect.width) * 2 - 1;
    pickNdc.y = -((cy - rect.top) / rect.height) * 2 + 1;
    pickRay.setFromCamera(pickNdc, camera);
    const hit = pickRay.intersectObjects(S.marbles.map((m) => m.mesh), false)[0];
    if (hit) {
      const m = S.marbles.find((mm) => mm.mesh === hit.object);
      if (m) {
        focusPlayer(m.playerId);
        onPick(m.playerId);
      }
    }
  }
  const _mouse = { downX: 0, downY: 0, moved: false, dragging: false };
  function onKeyDown(e) {
    const tag = e.target && e.target.tagName;
    if (tag && /input|textarea|select/i.test(tag)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === " " || ["z", "q", "s", "d", "w", "a", "c"].includes(k)) S.free.keys.add(k);
    if (e.key === "Control") S.free.fast = true;
    if (e.key === "Shift") S.free.slow = true;
  }
  function onKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    S.free.keys.delete(k);
    if (e.key === "Control") S.free.fast = false;
    if (e.key === "Shift") S.free.slow = false;
  }
  function onMouseDown(e) {
    _mouse.downX = e.clientX;
    _mouse.downY = e.clientY;
    _mouse.moved = false;
    _mouse.dragging = true;
  }
  function onMouseMove(e) {
    if (!_mouse.dragging) return;
    if (Math.abs(e.clientX - _mouse.downX) + Math.abs(e.clientY - _mouse.downY) > 4) _mouse.moved = true;
    if ((S.camOverride || cameraPref) === "free") {
      S.free.yaw -= (e.movementX || 0) * 0.0035;
      S.free.pitch -= (e.movementY || 0) * 0.0035;
      S.free.pitch = Math.max(-1.45, Math.min(1.45, S.free.pitch));
    }
  }
  function onMouseUp(e) {
    _mouse.dragging = false;
    if (!_mouse.moved) pickAt(e.clientX, e.clientY);
  }

  function resize() {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
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
    removeAllMarbles();
    clearTrack();
    for (const [, a] of avatarCache) {
      scene.remove(a.sprite);
      a.tex.dispose();
    }
    avatarCache.clear();
    renderer.dispose();
  }

  buildTrack();
  S.phase = "filling";
  S.phaseStart = performance.now();
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
    startRace: startRaceNow,
    stopRace: stopRaceNow,
    setAutoRace,
    setGiftConfig,
    loadLevel,
  };
}
