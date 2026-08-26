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

function marblesForGift(diamonds, count) {
  const v = Math.max(0, diamonds) * Math.max(1, count || 1);
  if (v < 5) return 1;
  if (v < 20) return 2;
  if (v < 50) return 3;
  if (v < 100) return 5;
  if (v < 300) return 7;
  return 10;
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
    // Contrôles temps réel
    camOverride: null, // null = suit `cameraPref` ; sinon force un mode
    focusPlayerId: null,
    autoRace: opts.autoRace !== false, // true = les courses s'enchaînent seules
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
      p = { id, name: name || "Viewer", color: `hsl(${hue}, 85%, 60%)`, ballCount: 0, full: false, finishRank: null, img: null };
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
  function handleGift(userId, nickname, avatar, diamonds, count) {
    const p = ensurePlayer(userId, nickname, avatar);
    if (p.ballCount >= MAX_BALLS) {
      p.full = true;
      return;
    }
    const before = p.ballCount;
    p.ballCount = Math.min(MAX_BALLS, p.ballCount + marblesForGift(diamonds, count));
    if (p.ballCount >= MAX_BALLS) p.full = true;
    const gained = p.ballCount - before;
    if (S.phase !== "intermission" && gained > 0) queueSpawns(p, gained);
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
    for (const p of S.players.values()) queueSpawns(p, p.ballCount);
    S.phase = S.players.size === 0 ? "filling" : "racing";
    S.phaseStart = now;
    S.raceStart = now;
    S.camMode = 0;
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
  function packInfo() {
    let n = 0;
    _c.set(0, 0, 0);
    _v.set(0, 0, 0);
    let lead = null,
      leadProg = -Infinity;
    for (const m of S.marbles) {
      if (m.finished) continue;
      _c.add(m.body.position);
      _v.x += m.body.velocity.x;
      _v.y += m.body.velocity.y;
      _v.z += m.body.velocity.z;
      n++;
      const prog = progressOf(m.body.position);
      if (prog > leadProg) {
        leadProg = prog;
        lead = m;
      }
    }
    if (!n) return null;
    _c.multiplyScalar(1 / n);
    return { c: _c.clone(), v: _v.clone(), lead, n };
  }
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

  function updateCamera(now) {
    const baseMode = S.camOverride || cameraPref;
    if (baseMode === "free") {
      updateFree();
      return;
    }
    let camPos = new THREE.Vector3(0, 70, -40);
    let look = new THREE.Vector3(0, 40, 6);
    const info = packInfo();
    if (info && (S.phase === "racing" || S.phase === "intermission")) {
      let focusM = info.lead || null;
      let center = info.c;
      if (baseMode === "focus" && S.focusPlayerId) {
        const fm = leadMarbleOf(S.focusPlayerId);
        if (fm) {
          focusM = fm;
          center = new THREE.Vector3(fm.body.position.x, fm.body.position.y, fm.body.position.z);
        }
      }
      // direction = vitesse horizontale de la bille suivie (lissée → pas de secousse)
      _tan.set(
        focusM ? focusM.body.velocity.x : info.v.x,
        0,
        focusM ? focusM.body.velocity.z : info.v.z,
      );
      if (_tan.lengthSq() < 0.6) _tan.copy(S.camDir);
      _tan.normalize();
      S.camDir.lerp(_tan, 0.045);
      S.camDir.y = 0;
      if (S.camDir.lengthSq() < 0.001) S.camDir.set(0, 0, 1);
      S.camDir.normalize();
      const d = S.camDir;
      _side.set(d.z, 0, -d.x).normalize();
      const c = center;

      let mode = baseMode;
      if (mode === "auto") {
        if (S.phase === "racing" && now - S.camModeStart > CAM_SWITCH_MS) {
          S.camMode = (S.camMode + 1) % AUTO_SEQ.length;
          S.camModeStart = now;
        }
        mode = AUTO_SEQ[S.camMode % AUTO_SEQ.length];
      } else if (mode === "focus") {
        mode = "chase";
      }

      if (mode === "front") {
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
      } else {
        camPos.copy(c).addScaledVector(d, -23);
        camPos.y = c.y + 19;
        look.copy(c).addScaledVector(d, 12);
        look.y = c.y - 6;
      }
    } else {
      // pas de billes : cadre le haut du circuit
      camPos.copy(S.spawnBase).addScaledVector(S.spawnFwd, -14);
      camPos.y = S.spawnBase.y + 16;
      look.copy(S.spawnBase).addScaledVector(S.spawnFwd, 10);
    }
    camera.position.lerp(camPos, 0.05);
    S.camLook.lerp(look, 0.06);
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
      balls: p.ballCount,
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
      connected: S.connected,
      players: S.players.size,
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

    if (S.phase === "filling") {
      if (S.autoRace && S.players.size > 0 && now - S.phaseStart > 2500) startRace(now);
    } else if (S.phase === "racing") {
      const active = S.marbles.filter((m) => !m.finished);
      if ((active.length === 0 && S.marbles.length > 0) || now - S.raceStart > RACE_MAX_MS) endRace(now);
      if (S.marbles.length === 0 && now - S.raceStart > 6000) endRace(now);
    } else if (S.phase === "intermission") {
      if (S.autoRace && now - S.phaseStart > INTERMISSION_MS) startRace(now);
    }

    let budget = 3;
    while (budget-- > 0 && S.spawnQueue.length) spawnMarble(S.spawnQueue.shift());

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
    if (e && e.type === "gift") handleGift(e.userId, e.nickname, e.avatar, e.diamonds, e.count);
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
    S.focusPlayerId = id || null;
    S.camOverride = id ? "focus" : null;
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
    };
  }
  function startRaceNow() {
    startRace(performance.now());
  }
  function stopRaceNow() {
    if (S.phase === "racing") endRace(performance.now());
  }
  function setAutoRace(v) {
    S.autoRace = !!v;
  }
  function loadLevel(lvl) {
    if (lvl && Array.isArray(lvl.platforms) && lvl.platforms.length) levelPlatforms = lvl.platforms;
    if (lvl && lvl.settings) {
      settings = lvl.settings;
      cameraPref = settings.camera || "auto";
    }
    startRace(performance.now());
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
    loadLevel,
  };
}
