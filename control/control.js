// Panneau de contrôle du streamer. Pilote la fenêtre SOURCE (via le principal)
// et se connecte au compte du site + à TikTok Live.
const S = window.stream;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  user: null,
  levels: [],
  byId: {},
  focusId: null,
  camMode: "auto",
  demoOn: false,
  gift: { byGift: {}, default: 1, maxPerPlayer: 100 },
  seen: {},
  gameType: "marble-race",
};

// Jeux disponibles (doit rester aligné avec engine/games.js).
const GAME_LABELS = { "marble-race": "🏁 Course", "team-war": "⚔️ Bagarre Rouge vs Bleu" };
const GAME_CAMS = {
  "marble-race": [["auto", "Auto"], ["chase", "Derrière"], ["front", "De face"], ["side", "Côté"], ["top", "Vue du haut"], ["free", "🎮 Libre"]],
  "team-war": [["auto", "Auto"], ["side", "Côté"], ["close", "Mêlée"], ["front", "Dans l'axe"], ["high", "Vue haute"], ["top", "Dessus"], ["free", "🎮 Libre"]],
};
function gameLabel(id) {
  return GAME_LABELS[id] || GAME_LABELS["marble-race"];
}
// Reconstruit les boutons caméra selon le jeu chargé.
function renderCamButtons() {
  const grid = document.querySelector(".cam-grid");
  if (!grid) return;
  const cams = GAME_CAMS[state.gameType] || GAME_CAMS["marble-race"];
  grid.innerHTML = "";
  for (const [v, label] of cams) {
    const b = document.createElement("button");
    b.className = "cam" + (v === state.camMode ? " active" : "");
    b.dataset.cam = v;
    b.textContent = label;
    b.addEventListener("click", () => setCam(v));
    grid.appendChild(b);
  }
}

let toastT = null;
function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + (kind || "");
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2400);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function toSource(msg) {
  S?.toSource(msg);
}

// ---------- session ----------
async function boot() {
  wire();
  const cfg = (S && (await S.getConfig())) || {};
  $("#logUrl").value = cfg.baseUrl || "http://localhost:3000";
  if (cfg.loggedIn && cfg.user) {
    state.user = cfg.user;
    showLoggedIn();
    afterLogin();
  } else {
    $("#loginModal").hidden = false;
  }
  S?.onSource(onSource);
  window.__ready = true;
}
function showLoggedIn() {
  $("#loginModal").hidden = true;
  $("#userChip").hidden = false;
  $("#userName").textContent = state.user.name || state.user.email || "Streamer";
  if (state.user.tiktokUsername) $("#ttUser").value = "@" + String(state.user.tiktokUsername).replace(/^@+/, "");
  // La démo est un outil de dev : visible seulement pour admin / support.
  const staff = state.user.role === "admin" || state.user.role === "support";
  $("#demoToggle").hidden = !staff;
}
async function doLogin() {
  const msg = $("#logMsg");
  msg.className = "cfg-msg";
  msg.textContent = "Connexion…";
  const r = await S.login($("#logUrl").value.trim(), $("#logEmail").value.trim(), $("#logPass").value);
  if (r.ok) {
    state.user = r.user;
    showLoggedIn();
    afterLogin();
  } else {
    msg.className = "cfg-msg err";
    msg.textContent = r.error || "Échec de connexion.";
  }
}
async function afterLogin() {
  loadGiftConfig();
  await loadLevels();
  pushGift(); // envoie la config des cadeaux au source
}

// ---------- config cadeaux ----------
function loadGiftConfig() {
  let cfg = null;
  try {
    if (state.user && state.user.giftConfig) cfg = JSON.parse(state.user.giftConfig);
  } catch {
    cfg = null;
  }
  state.gift = Object.assign({ byGift: {}, default: 1, maxPerPlayer: 100 }, cfg || {});
  if (!state.gift.byGift || typeof state.gift.byGift !== "object") state.gift.byGift = {};
}
function pushGift() {
  toSource({ type: "cmd", cmd: "giftconfig", config: state.gift });
}
function openGift() {
  $("#giftDefault").value = state.gift.default != null ? state.gift.default : 1;
  $("#giftCap").value = state.gift.maxPerPlayer != null ? state.gift.maxPerPlayer : 100;
  $("#giftMsg").textContent = "";
  renderGiftList();
  renderSeen();
  $("#giftModal").hidden = false;
}
function renderGiftList() {
  const box = $("#giftList");
  const names = Object.keys(state.gift.byGift);
  if (!names.length) {
    box.innerHTML = `<div class="gift-empty">Aucun cadeau configuré. Ajoute-en un ci-dessous, ou utilise la valeur par défaut.</div>`;
    return;
  }
  box.innerHTML = "";
  for (const nm of names.sort()) {
    const el = document.createElement("div");
    el.className = "gift-item";
    el.innerHTML = `<span class="gname">${esc(nm)}</span><input type="number" min="0" step="1" value="${Number(state.gift.byGift[nm])}"><span class="unit">billes</span><button class="rm" title="Retirer">✕</button>`;
    el.querySelector("input").addEventListener("input", (e) => {
      state.gift.byGift[nm] = parseInt(e.target.value, 10) || 0;
    });
    el.querySelector(".rm").addEventListener("click", () => {
      delete state.gift.byGift[nm];
      renderGiftList();
      renderSeen();
    });
    box.appendChild(el);
  }
}
function renderSeen() {
  const names = Object.keys(state.seen).filter((n) => state.gift.byGift[n] == null);
  $("#giftSeenWrap").hidden = names.length === 0;
  const box = $("#giftSeen");
  box.innerHTML = "";
  for (const nm of names.slice(0, 24)) {
    const chip = document.createElement("button");
    chip.className = "gift-chip";
    chip.textContent = nm;
    chip.addEventListener("click", () => {
      $("#giftName").value = nm;
      $("#giftBalls").focus();
    });
    box.appendChild(chip);
  }
}
function addGiftRule() {
  const nm = $("#giftName").value.trim();
  const balls = parseInt($("#giftBalls").value, 10);
  if (!nm) return;
  state.gift.byGift[nm] = isNaN(balls) ? 1 : Math.max(0, balls);
  $("#giftName").value = "";
  $("#giftBalls").value = "";
  renderGiftList();
  renderSeen();
}
async function saveGift() {
  state.gift.default = Math.max(0, parseInt($("#giftDefault").value, 10) || 0);
  state.gift.maxPerPlayer = Math.max(1, parseInt($("#giftCap").value, 10) || 100);
  const msg = $("#giftMsg");
  msg.className = "cfg-msg";
  msg.textContent = "Enregistrement…";
  const r = await S.api("POST", "/api/app/gift-config", { config: state.gift });
  if (r.ok) {
    msg.className = "cfg-msg ok";
    msg.textContent = "Enregistré ✓";
    pushGift();
    toast("Cadeaux enregistrés ✓", "ok");
  } else {
    msg.className = "cfg-msg err";
    msg.textContent = r.error || (r.data && r.data.error) || "Échec.";
  }
}

// ---------- niveaux / maps ----------
async function loadLevels() {
  const r = await S.api("GET", "/api/app/levels");
  if (!r.ok) {
    toast("Impossible de charger les circuits.", "err");
    return;
  }
  state.levels = (r.data && r.data.levels) || [];
  state.byId = {};
  const sel = $("#mapSel");
  sel.innerHTML = "";
  let activeId = null;
  for (const l of state.levels) {
    state.byId[l.id] = l;
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = gameLabel(l.gameType) + " — " + l.name + (l.active ? " ● (live)" : "");
    sel.appendChild(o);
    if (l.active && !activeId) activeId = l.id;
  }
  if (activeId) {
    sel.value = activeId;
    sendLevel(activeId);
  } else if (state.levels[0]) {
    sendLevel(state.levels[0].id);
  }
}
function parseData(str) {
  try {
    const d = JSON.parse(str || "{}");
    return { platforms: Array.isArray(d.platforms) ? d.platforms : [], settings: d.settings || {} };
  } catch {
    return { platforms: [], settings: {} };
  }
}
function sendLevel(id) {
  const l = state.byId[id];
  if (!l) return;
  const { platforms, settings } = parseData(l.data);
  const gt = l.gameType || "marble-race";
  const changed = gt !== state.gameType;
  state.gameType = gt;
  toSource({ type: "cmd", cmd: "level", gameType: gt, level: { platforms, settings } });
  pushGift(); // ré-applique la config cadeaux au moteur (re)chargé
  if (changed) {
    state.camMode = "auto";
    renderCamButtons();
    setCam("auto");
  }
  toast(gameLabel(gt) + " — " + l.name, "ok");
}

// ---------- caméra ----------
function setCam(mode) {
  state.camMode = mode;
  $$(".cam").forEach((b) => b.classList.toggle("active", b.dataset.cam === mode));
  toSource({ type: "cmd", cmd: "camera", mode });
  if (mode !== "focus") {
    state.focusId = null;
    $("#focusInfo").hidden = true;
    renderFocusHighlight();
  }
}
function focusPlayer(id, name) {
  state.focusId = id;
  state.camMode = "focus";
  $$(".cam").forEach((b) => b.classList.remove("active"));
  toSource({ type: "cmd", cmd: "focus", playerId: id });
  const fi = $("#focusInfo");
  fi.hidden = false;
  fi.innerHTML = `🎯 Caméra sur <b>${esc(name || id)}</b> <button id="clearFocus">Libérer</button>`;
  $("#clearFocus").addEventListener("click", () => setCam("auto"));
  renderFocusHighlight();
}
function renderFocusHighlight() {
  $$(".brow").forEach((el) => el.classList.toggle("focus", el.dataset.id === state.focusId));
}

// ---------- leaderboard ----------
function renderBoard(board) {
  const box = $("#board");
  $("#boardEmpty").hidden = board.length > 0;
  box.innerHTML = "";
  for (const r of board) {
    const el = document.createElement("div");
    el.className = "brow" + (r.id === state.focusId ? " focus" : "");
    el.dataset.id = r.id;
    const medal = r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank;
    el.innerHTML =
      `<span class="rk">${medal}</span>` +
      `<span class="av" style="background:${r.color}">${r.avatar ? `<img src="${r.avatar}" alt="">` : esc((r.name[0] || "?").toUpperCase())}</span>` +
      `<span class="nm">${esc(r.name)}</span>` +
      (r.finished ? `<span class="fin">ARRIVÉ</span>` : "") +
      `<span class="ba">${r.balls}🔴</span>`;
    el.addEventListener("click", () => focusPlayer(r.id, r.name));
    box.appendChild(el);
  }
}

// ---------- messages de la source ----------
function onSource(msg) {
  if (!msg) return;
  if (msg.type === "state") {
    renderBoard(msg.board || []);
    const info = msg.info || {};
    const enCours = info.phase === "racing" || info.phase === "battle" || info.phase === "countdown";
    const pill = $("#phasePill");
    if (enCours) {
      pill.className = "phase is-live";
      pill.textContent = "Manche en cours";
    } else if (info.phase === "intermission") {
      pill.className = "phase is-result";
      pill.textContent = "Résultats";
    } else {
      pill.className = "phase is-wait";
      pill.textContent = "En attente";
    }
    // File d'attente : combien de joueurs ont offert pour la PROCHAINE manche.
    let attente;
    if (state.gameType === "team-war") {
      const need = info.needPerTeam ?? 3;
      attente = `🔴 ${info.rouge?.queued ?? 0}/${need} · ${info.bleu?.queued ?? 0}/${need} 🔵 en attente`;
    } else {
      attente = `${info.queued ?? 0}/${info.need ?? 4} joueurs en attente`;
    }
    $("#playersInfo").textContent = attente;
    // Le bouton Démarrer n'a de sens que hors manche et avec assez de monde.
    const btn = $("#raceStart");
    if (btn) {
      btn.disabled = enCours || !info.canStart;
      btn.title = enCours
        ? "Une manche est déjà en cours"
        : info.canStart
          ? "Lancer la manche maintenant"
          : "Pas encore assez de joueurs";
    }
  } else if (msg.type === "pick") {
    // récupère le nom via le board courant si dispo
    const el = document.querySelector(`.brow[data-id="${CSS.escape(msg.playerId)}"]`);
    focusPlayer(msg.playerId, el ? el.querySelector(".nm").textContent : msg.playerId);
  } else if (msg.type === "tiktok") {
    const st = $("#ttStatus");
    const live = $("#liveBadge");
    if (msg.status === "connected") {
      st.className = "status on";
      st.textContent = "Connecté @" + (msg.username || "");
      if (live) live.hidden = false;
    } else if (msg.status === "connecting") {
      st.className = "status warn";
      st.textContent = "Connexion…";
      if (live) live.hidden = true;
    } else if (msg.status === "error") {
      st.className = "status err";
      st.textContent = "Erreur";
      if (live) live.hidden = true;
      toast(msg.error || "Erreur de connexion TikTok", "err");
    } else {
      st.className = "status off";
      st.textContent = "Non connecté";
      if (live) live.hidden = true;
    }
  } else if (msg.type === "gift") {
    if (msg.giftName) {
      state.seen[msg.giftName] = true;
      if (!$("#giftModal").hidden) renderSeen();
    }
  } else if (msg.type === "sourceClosed") {
    toast("Fenêtre source fermée — clique « Afficher ».", "err");
  }
}

// ---------- câblage ----------
function wire() {
  $("#logBtn").addEventListener("click", doLogin);
  $("#logPass").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
  $("#btnLogout").addEventListener("click", async () => {
    await S.logout();
    location.reload();
  });

  $("#ttConnect").addEventListener("click", () => S.tiktokConnect($("#ttUser").value));
  $("#ttDisconnect").addEventListener("click", () => S.tiktokDisconnect());
  $("#srcShow").addEventListener("click", () => S.showSource());
  $("#srcHide").addEventListener("click", () => S.hideSource());
  $("#srcFocus").addEventListener("click", () => S.focusSource());

  $("#raceStart").addEventListener("click", () => toSource({ type: "cmd", cmd: "start" }));
  $("#raceStop").addEventListener("click", () => toSource({ type: "cmd", cmd: "stop" }));
  $("#autoRace").addEventListener("change", (e) => toSource({ type: "cmd", cmd: "autorace", value: e.target.checked }));
  renderCamButtons();
  $("#mapLoad").addEventListener("click", () => sendLevel($("#mapSel").value));
  $("#giftOpen").addEventListener("click", openGift);
  $("#giftClose").addEventListener("click", () => ($("#giftModal").hidden = true));
  $("#giftAdd").addEventListener("click", addGiftRule);
  $("#giftBalls").addEventListener("keydown", (e) => e.key === "Enter" && addGiftRule());
  $("#giftSave").addEventListener("click", saveGift);
  $("#demoToggle").addEventListener("click", () => {
    state.demoOn = !state.demoOn;
    $("#demoToggle").textContent = "🧪 Démo (dev) : " + (state.demoOn ? "ON" : "OFF");
    $("#demoToggle").classList.toggle("primary", state.demoOn);
    toSource({ type: "cmd", cmd: "demo", value: state.demoOn });
  });
}

boot();
window.__ctrl = { state };
