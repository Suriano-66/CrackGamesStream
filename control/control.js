// Panneau de contrôle du streamer. Pilote la fenêtre SOURCE (via le principal)
// et se connecte au compte du site + à TikTok Live.
const S = window.stream;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = { user: null, levels: [], byId: {}, focusId: null, camMode: "auto" };

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
  await loadLevels();
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
    o.textContent = l.name + (l.active ? " ● (live)" : "");
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
  toSource({ type: "cmd", cmd: "level", level: { platforms, settings } });
  toast("Circuit chargé : " + l.name, "ok");
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
    $("#phasePill").textContent =
      info.phase === "racing" ? "● Course en cours" : info.phase === "intermission" ? "Résultats…" : "En attente";
    $("#playersInfo").textContent = (info.players || 0) + " joueur" + ((info.players || 0) > 1 ? "s" : "");
  } else if (msg.type === "pick") {
    // récupère le nom via le board courant si dispo
    const el = document.querySelector(`.brow[data-id="${CSS.escape(msg.playerId)}"]`);
    focusPlayer(msg.playerId, el ? el.querySelector(".nm").textContent : msg.playerId);
  } else if (msg.type === "tiktok") {
    const st = $("#ttStatus");
    if (msg.status === "connected") {
      st.className = "status on";
      st.textContent = "● connecté @" + (msg.username || "");
    } else if (msg.status === "connecting") {
      st.className = "status warn";
      st.textContent = "● connexion…";
    } else if (msg.status === "error") {
      st.className = "status err";
      st.textContent = "● " + (msg.error || "erreur");
    } else {
      st.className = "status off";
      st.textContent = "● non connecté";
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
  $$(".cam").forEach((b) => b.addEventListener("click", () => setCam(b.dataset.cam)));
  $("#mapLoad").addEventListener("click", () => sendLevel($("#mapSel").value));
}

boot();
window.__ctrl = { state };
