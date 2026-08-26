// Fenêtre SOURCE : fait tourner le moteur du jeu (contrôlé à distance par le
// panneau) et affiche l'overlay portrait à capturer dans OBS.
import { createMarbleRace3D } from "../engine/marbleRaceEngine.js";

const bridge = window.src; // pont Electron (peut être remplacé par un stub en test)
const canvas = document.getElementById("c");
const DEMO = ["Lucas", "Marie", "Noah", "Sofia", "Léa", "Hugo", "Emma", "Nathan", "Chloé", "Jade", "Louis", "Ava"];

let engine = null;
let demo = false;
let demoT = null;
let lastSent = 0;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function startEngine(level) {
  if (engine) engine.dispose();
  engine = createMarbleRace3D(canvas, {
    controls: true,
    level: level || undefined,
    onState: renderHud,
    onPick: (pid) => bridge?.toControl({ type: "pick", playerId: pid }),
  });
  window.__engine = engine;
}

function renderHud(st) {
  document.getElementById("status").textContent =
    st.phase === "racing" ? "⏱ " + st.timer + "s" : st.phase === "filling" ? "En attente de billes…" : "Résultats…";
  const conn = document.getElementById("conn");
  conn.textContent = st.connected ? "● TikTok connecté" : "● Mode démo";
  conn.className = "conn " + (st.connected ? "on" : "off");

  const rows = document.getElementById("rows");
  document.getElementById("empty").hidden = st.board.length > 0;
  rows.innerHTML = "";
  for (const r of st.board) {
    const medal = r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank;
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML =
      `<span class="rk">${medal}</span>` +
      `<span class="av" style="background:${r.color}">${r.avatar ? `<img src="${r.avatar}" alt="">` : esc((r.name[0] || "?").toUpperCase())}</span>` +
      `<span class="nm">${esc(r.name)}</span><span class="ba">${r.balls}</span>`;
    rows.appendChild(el);
  }

  const w = document.getElementById("winner");
  if (st.phase === "intermission" && st.winner) {
    w.hidden = false;
    document.getElementById("wn").textContent = st.winner.name;
    const wav = document.getElementById("wav");
    wav.style.background = st.winner.color;
    wav.innerHTML = st.winner.avatar ? `<img src="${st.winner.avatar}" alt="">` : esc((st.winner.name[0] || "?").toUpperCase());
  } else w.hidden = true;

  // remonte l'état au panneau de contrôle (throttlé)
  const now = performance.now();
  if (engine && now - lastSent > 250) {
    lastSent = now;
    bridge?.toControl({ type: "state", board: engine.getBoard(), info: engine.getInfo() });
  }
}

function setDemo(on) {
  demo = on;
  clearInterval(demoT);
  demoT = null;
  if (on) {
    let i = 0;
    demoT = setInterval(() => {
      if (!engine) return;
      const idx = Math.floor(Math.random() * DEMO.length);
      engine.handleEvent({ type: "gift", userId: "demo_" + idx, nickname: DEMO[idx], avatar: "", diamonds: [1, 5, 10, 20, 50][Math.floor(Math.random() * 5)], count: 1 + (i++ % 2) });
    }, 700);
  }
}

bridge?.onControl((msg) => {
  if (!msg) return;
  if (msg.type === "event") {
    engine?.handleEvent(msg.event);
    if (msg.event?.type === "connected") setDemo(false);
    if (msg.event?.type === "disconnected") setDemo(true);
  } else if (msg.type === "cmd") {
    const c = msg.cmd;
    if (c === "camera") engine?.setCameraMode(msg.mode);
    else if (c === "focus") engine?.focusPlayer(msg.playerId);
    else if (c === "start") engine?.startRace();
    else if (c === "stop") engine?.stopRace();
    else if (c === "autorace") engine?.setAutoRace(msg.value);
    else if (c === "level") engine ? engine.loadLevel(msg.level) : startEngine(msg.level);
    else if (c === "demo") setDemo(msg.value);
  }
});

startEngine();
setDemo(true); // évite un écran vide au lancement
window.__ready = true;
