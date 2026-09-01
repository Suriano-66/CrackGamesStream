// Fenêtre SOURCE : moteur du jeu + overlay minimaliste (texte seul) à capturer
// dans OBS. Compte à rebours 3·2·1·GO, classement à droite avec médailles.
import { getGame, DEFAULT_GAME } from "../engine/games.js";
import { definirCatalogue } from "../engine/assets.js";
import { CATALOGUE } from "../assets/models/catalogue.js";

// Catalogue des modèles 3D, livré avec l'application (assets/models/).
definirCatalogue(CATALOGUE);

const bridge = window.src;
const canvas = document.getElementById("c");
const DEMO = ["Lucas", "Marie", "Noah", "Sofia", "Léa", "Hugo", "Emma", "Nathan", "Chloé", "Jade", "Louis", "Ava"];

let engine = null;
let gameType = DEFAULT_GAME;
let demo = false;
let demoT = null;
let lastSent = 0;
let prevPhase = "";
let goUntil = 0;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---- Overlay juice : alertes cadeaux + combos -------------------------------
const GIFT_EMOJI = {
  Rose: "🌹", GG: "💚", "Finger Heart": "🫰", Lion: "🦁", TikTok: "🎵",
  Heart: "❤️", "Heart Me": "💖", Galaxy: "🌌", "Universe": "🪐", Rocket: "🚀",
  "Doughnut": "🍩", "Perfume": "🌸", "Sports Car": "🏎️", "Diamond": "💎", "Crown": "👑",
};
function giftEmoji(name) { return GIFT_EMOJI[name] || "🎁"; }

// Palier visuel selon la valeur du cadeau (diamants × répétitions).
function tierOf(diamonds, count) {
  const total = (diamonds || 0) * (count || 1);
  if (total >= 500) return "t3";
  if (total >= 100) return "t2";
  if (total >= 20) return "t1";
  return "t0";
}

function initialOf(name) {
  return (String(name || "").trim().charAt(0) || "?").toUpperCase();
}

// Toast d'alerte cadeau : avatar (image ou initiale) + pseudo + cadeau ×count.
function showGiftAlert(ev) {
  const box = document.getElementById("giftAlerts");
  if (!box || !ev) return;

  const el = document.createElement("div");
  el.className = "ga " + tierOf(ev.diamonds, ev.count);

  // Avatar : image si dispo, sinon pastille avec l'initiale.
  let av;
  if (ev.avatar) {
    av = document.createElement("img");
    av.className = "ga-av";
    av.src = ev.avatar;
    av.alt = "";
    av.onerror = () => {
      const s = document.createElement("span");
      s.className = "ga-av ga-init";
      s.textContent = initialOf(ev.nickname);
      av.replaceWith(s);
    };
  } else {
    av = document.createElement("span");
    av.className = "ga-av ga-init";
    av.textContent = initialOf(ev.nickname);
  }

  const body = document.createElement("div");
  body.className = "ga-body";
  const times = (ev.count || 1) > 1 ? ` <b class="ga-x">×${ev.count}</b>` : "";
  body.innerHTML =
    `<span class="ga-name">${esc(ev.nickname || "?")}</span>` +
    `<span class="ga-gift">${giftEmoji(ev.giftName)} ${esc(ev.giftName || "cadeau")}${times}</span>`;

  el.appendChild(av);
  el.appendChild(body);
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);

  const life = el.classList.contains("t3") ? 5200 : el.classList.contains("t2") ? 4600 : 4000;
  setTimeout(() => {
    el.classList.add("ga-out");
    setTimeout(() => el.remove(), 400);
  }, life);

  bumpCombo(ev.count || 1);
}

// Compteur de combos : additionne les cadeaux tant qu'ils s'enchaînent.
let comboN = 0;
let comboAt = 0;
let comboTimer = null;
const COMBO_WINDOW = 2600;
function bumpCombo(inc) {
  const now = performance.now();
  if (now - comboAt > COMBO_WINDOW) comboN = 0; // fenêtre écoulée → on repart
  comboAt = now;
  comboN += inc;

  const box = document.getElementById("combo");
  if (!box) return;
  if (comboN >= 3) {
    box.innerHTML = `<span class="combo-x">×${comboN}</span><span class="combo-lbl">COMBO</span>`;
    box.classList.add("show");
    box.classList.remove("bump");
    void box.offsetWidth; // relance l'animation de pulsation
    box.classList.add("bump");
  }
  clearTimeout(comboTimer);
  comboTimer = setTimeout(() => {
    box.classList.remove("show");
    comboN = 0;
  }, COMBO_WINDOW);
}

function startEngine(level, type) {
  if (engine) engine.dispose();
  gameType = getGame(type || gameType).id;
  const game = getGame(gameType);
  engine = game.create(canvas, {
    controls: true,
    level: level || undefined,
    onState: renderHud,
    onPick: (pid) => bridge?.toControl({ type: "pick", playerId: pid }),
  });
  document.querySelector(".title").textContent = game.title;
  document.getElementById("cta").textContent = game.cta;
  document.getElementById("tug").hidden = gameType !== "team-war";
  window.__engine = engine;
  window.__gameType = gameType;
}

function renderHud(st) {
  document.getElementById("timer").textContent = st.phase === "racing" || st.phase === "battle" ? "⏱ " + st.timer + "s" : "";
  const conn = document.getElementById("conn");
  conn.textContent = st.connected ? "● TikTok" : "● démo";
  conn.className = "conn " + (st.connected ? "on" : "off");
  document.getElementById("cta").style.opacity = st.phase === "intermission" ? "0" : "1";

  if (prevPhase === "countdown" && st.phase === "racing") goUntil = performance.now() + 900;
  prevPhase = st.phase;

  if (gameType === "team-war") renderTug(st);
  renderRank(st);
  renderCenter(st);

  const now = performance.now();
  if (engine && now - lastSent > 250) {
    lastSent = now;
    bridge?.toControl({ type: "state", board: engine.getBoard(), info: engine.getInfo() });
  }
}

// Barre de rapport de force : part des combattants encore debout par camp.
function renderTug(st) {
  const box = document.getElementById("tug");
  if (!box) return;
  const r = st.rouge?.standing ?? 0;
  const b = st.bleu?.standing ?? 0;
  let pct = r + b > 0 ? (r / (r + b)) * 100 : 50;
  if (st.winner && !st.winner.draw) pct = st.winner.team === "rouge" ? 100 : 0;
  box.querySelector(".tug-fill").style.width = pct.toFixed(1) + "%";
  box.querySelector(".tug-core").style.left = pct.toFixed(1) + "%";
  box.querySelector(".tug-r").textContent = "🔴 " + r;
  box.querySelector(".tug-b").textContent = b + " 🔵";
}

function renderRank(st) {
  const box = document.getElementById("rank");
  if (st.phase !== "racing" && st.phase !== "battle" && st.phase !== "intermission") {
    if (box.__k !== "") {
      box.__k = "";
      box.innerHTML = "";
    }
    return;
  }
  const top = st.board.slice(0, 8);
  const key = top.map((r) => r.id + r.rank + (r.finished ? "F" : "") + (r.kills ?? "")).join("|");
  if (box.__k === key) return; // ne rejoue pas l'anim à chaque frame
  box.__k = key;
  box.innerHTML = "";
  for (const r of top) {
    const el = document.createElement("div");
    el.className = "rrow" + (r.finished ? " done" : "");
    const mark =
      gameType === "team-war"
        ? `<span class="rnum" style="color:${r.teamColor}">${r.kills ?? 0} 👊</span>`
        : r.rank <= 3
          ? `<span class="medal">${["🥇", "🥈", "🥉"][r.rank - 1]}</span>`
          : `<span class="rnum">${r.rank}</span>`;
    el.innerHTML = `<span class="rname" style="color:${r.color}">${esc(r.name)}</span>${mark}`;
    box.appendChild(el);
  }
}

function renderCenter(st) {
  const box = document.getElementById("center");
  let html = "";
  let key = "";
  if (st.phase === "filling") {
    if (gameType === "team-war") {
      const r = st.rouge?.queued ?? 0;
      const b = st.bleu?.queued ?? 0;
      const need = st.needPerTeam ?? 3;
      key = "wait" + r + "/" + b;
      html =
        `<div class="wait sh">Prochaine bataille` +
        `<span class="queue"><b style="color:#ff5f79">🔴 ${r}/${need}</b> <b style="color:#63b6ff">${b}/${need} 🔵</b></span>` +
        `<small>Offre un cadeau pour rejoindre un camp</small></div>`;
    } else {
      const q = st.queued ?? 0;
      const need = st.need ?? 4;
      key = "wait" + q;
      html =
        `<div class="wait sh">Prochaine course` +
        `<span class="queue"><b>${q}/${need} joueurs prêts</b></span>` +
        `<small>Offre un cadeau pour lâcher tes billes</small></div>`;
    }
  } else if (st.phase === "countdown") {
    key = "cd" + st.count;
    html = `<div class="cd">${st.count}</div>`;
  } else if (st.phase === "racing" || st.phase === "battle") {
    if (performance.now() < goUntil) {
      key = "go";
      html = `<div class="cd go">GO !</div>`;
    } else {
      key = "race";
      html = "";
    }
  } else if (st.phase === "intermission") {
    if (st.winner) {
      const wname = st.winner.name || st.winner.label || "";
      key = "win" + wname;
      const sub =
        gameType === "team-war"
          ? st.winner.draw
            ? "Aucun camp éliminé — nouvelle manche…"
            : st.winner.mvp
            ? `MVP : ${esc(st.winner.mvp.name)} — ${st.winner.mvp.kills} KO`
            : "Nouvelle manche imminente…"
          : "Nouvelle course imminente…";
      const cap = gameType === "team-war" ? (st.winner.draw ? "🤝 Match nul" : "🏆 Camp vainqueur") : "🏆 Vainqueur";
      html = `<div class="win sh"><span class="cap">${cap}</span><span class="wname" style="color:${st.winner.color}">${esc(wname)}</span><small>${sub}</small></div>`;
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
    const GIFTS = [
      { name: "Rose", diamonds: 1 },
      { name: "Rose", diamonds: 1 },
      { name: "GG", diamonds: 1 },
      { name: "Finger Heart", diamonds: 5 },
      { name: "TikTok", diamonds: 1 },
      { name: "Lion", diamonds: 29 },
      { name: "Galaxy", diamonds: 1000 },
    ];
    demoT = setInterval(() => {
      if (!engine) return;
      const idx = Math.floor(Math.random() * DEMO.length);
      const g = GIFTS[Math.floor(Math.random() * GIFTS.length)];
      const count = g.diamonds >= 500 ? 1 : 1 + Math.floor(Math.random() * 4);
      const ev = { type: "gift", userId: "demo_" + idx, nickname: DEMO[idx], avatar: "", giftName: g.name, diamonds: g.diamonds, count };
      engine.handleEvent(ev);
      showGiftAlert(ev);
      i++;
    }, 700);
  }
}

bridge?.onControl((msg) => {
  if (!msg) return;
  if (msg.type === "event") {
    engine?.handleEvent(msg.event);
    if (msg.event?.type === "gift") showGiftAlert(msg.event);
    if (msg.event?.type === "connected") setDemo(false);
  } else if (msg.type === "cmd") {
    const c = msg.cmd;
    if (c === "camera") engine?.setCameraMode(msg.mode);
    else if (c === "focus") engine?.focusPlayer(msg.playerId);
    else if (c === "start") engine?.startRace();
    else if (c === "stop") engine?.stopRace();
    else if (c === "autorace") engine?.setAutoRace(msg.value);
    else if (c === "giftconfig") engine?.setGiftConfig?.(msg.config);
    else if (c === "level") {
      // Bascule de jeu si le niveau chargé n'est pas du même type.
      const t = getGame(msg.gameType || gameType).id;
      if (!engine || t !== gameType) startEngine(msg.level, t);
      else engine.loadLevel(msg.level);
    }
    else if (c === "demo") setDemo(msg.value);
  }
});

startEngine();
// En production : pas de démo automatique. Les billes viennent des vrais cadeaux TikTok.
window.__ready = true;
