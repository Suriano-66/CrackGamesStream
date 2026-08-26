// Fenêtre SOURCE : moteur du jeu + overlay minimaliste (texte seul) à capturer
// dans OBS. Compte à rebours 3·2·1·GO, classement à droite avec médailles.
import { createMarbleRace3D } from "../engine/marbleRaceEngine.js";

const bridge = window.src;
const canvas = document.getElementById("c");
const DEMO = ["Lucas", "Marie", "Noah", "Sofia", "Léa", "Hugo", "Emma", "Nathan", "Chloé", "Jade", "Louis", "Ava"];

let engine = null;
let demo = false;
let demoT = null;
let lastSent = 0;
let prevPhase = "";
let goUntil = 0;

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
  document.getElementById("timer").textContent = st.phase === "racing" ? "⏱ " + st.timer + "s" : "";
  const conn = document.getElementById("conn");
  conn.textContent = st.connected ? "● TikTok" : "● démo";
  conn.className = "conn " + (st.connected ? "on" : "off");
  document.getElementById("cta").style.opacity = st.phase === "intermission" ? "0" : "1";

  if (prevPhase === "countdown" && st.phase === "racing") goUntil = performance.now() + 900;
  prevPhase = st.phase;

  renderRank(st);
  renderCenter(st);

  const now = performance.now();
  if (engine && now - lastSent > 250) {
    lastSent = now;
    bridge?.toControl({ type: "state", board: engine.getBoard(), info: engine.getInfo() });
  }
}

function renderRank(st) {
  const box = document.getElementById("rank");
  if (st.phase !== "racing" && st.phase !== "intermission") {
    if (box.__k !== "") {
      box.__k = "";
      box.innerHTML = "";
    }
    return;
  }
  const top = st.board.slice(0, 8);
  const key = top.map((r) => r.id + r.rank + (r.finished ? "F" : "")).join("|");
  if (box.__k === key) return; // ne rejoue pas l'anim à chaque frame
  box.__k = key;
  box.innerHTML = "";
  for (const r of top) {
    const el = document.createElement("div");
    el.className = "rrow" + (r.finished ? " done" : "");
    const mark = r.rank <= 3 ? `<span class="medal">${["🥇", "🥈", "🥉"][r.rank - 1]}</span>` : `<span class="rnum">${r.rank}</span>`;
    el.innerHTML = `<span class="rname" style="color:${r.color}">${esc(r.name)}</span>${mark}`;
    box.appendChild(el);
  }
}

function renderCenter(st) {
  const box = document.getElementById("center");
  let html = "";
  let key = "";
  if (st.phase === "filling") {
    key = "wait";
    html = `<div class="wait sh">En attente de joueurs…<small>2 joueurs différents minimum</small></div>`;
  } else if (st.phase === "countdown") {
    key = "cd" + st.count;
    html = `<div class="cd">${st.count}</div>`;
  } else if (st.phase === "racing") {
    if (performance.now() < goUntil) {
      key = "go";
      html = `<div class="cd go">GO !</div>`;
    } else {
      key = "race";
      html = "";
    }
  } else if (st.phase === "intermission") {
    if (st.winner) {
      key = "win" + st.winner.name;
      html = `<div class="win sh"><span class="cap">🏆 Vainqueur</span><span style="color:${st.winner.color}">${esc(st.winner.name)}</span><small>Nouvelle course imminente…</small></div>`;
    } else {
      key = "win-none";
      html = "";
    }
  }
  if (box.__k !== key) {
    box.__k = key;
    box.innerHTML = html;
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
  } else if (msg.type === "cmd") {
    const c = msg.cmd;
    if (c === "camera") engine?.setCameraMode(msg.mode);
    else if (c === "focus") engine?.focusPlayer(msg.playerId);
    else if (c === "start") engine?.startRace();
    else if (c === "stop") engine?.stopRace();
    else if (c === "autorace") engine?.setAutoRace(msg.value);
    else if (c === "level") (engine ? engine.loadLevel(msg.level) : startEngine(msg.level));
    else if (c === "demo") setDemo(msg.value);
  }
});

startEngine();
// En production : pas de démo automatique. Les billes viennent des vrais cadeaux TikTok.
window.__ready = true;
