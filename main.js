// Processus principal de "CrackGames Stream".
// Deux fenêtres : le PANNEAU DE CONTRÔLE (pour le streamer) et la SOURCE
// (fenêtre portrait à capturer dans OBS). Le principal gère la connexion au
// compte, la connexion TikTok Live, et relaie les commandes/évènements.
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let controlWin = null;
let sourceWin = null;
let tiktok = null;

function configPath() {
  return path.join(app.getPath("userData"), "stream-config.json");
}
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return { baseUrl: "http://localhost:3000", token: null, user: null };
  }
}
function saveConfig(patch) {
  const n = { ...loadConfig(), ...patch };
  fs.writeFileSync(configPath(), JSON.stringify(n, null, 2), "utf8");
  return n;
}

function createControl() {
  controlWin = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#0c111c",
    title: "CrackGames Stream — Contrôle",
    webPreferences: {
      preload: path.join(__dirname, "preload-control.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  controlWin.setMenuBarVisibility(false);
  controlWin.loadFile(path.join(__dirname, "control", "index.html"));
  controlWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  controlWin.on("closed", () => {
    controlWin = null;
    if (sourceWin) sourceWin.close();
  });
}
function createSource() {
  if (sourceWin) {
    sourceWin.show();
    sourceWin.focus();
    return;
  }
  sourceWin = new BrowserWindow({
    width: 450,
    height: 800,
    backgroundColor: "#000000",
    title: "CrackGames Stream — SOURCE (à capturer dans OBS)",
    webPreferences: {
      preload: path.join(__dirname, "preload-source.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  sourceWin.setMenuBarVisibility(false);
  sourceWin.setAspectRatio(9 / 16);
  sourceWin.loadFile(path.join(__dirname, "source", "index.html"));
  sourceWin.on("closed", () => {
    sourceWin = null;
    controlWin?.webContents.send("from-source", { type: "sourceClosed" });
  });
}

app.whenReady().then(() => {
  createControl();
  createSource();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function apiFetch(method, apiPath, body) {
  const cfg = loadConfig();
  if (!cfg.baseUrl) return { ok: false, status: 0, error: "URL non configurée." };
  const url = cfg.baseUrl.replace(/\/+$/, "") + apiPath;
  const headers = { "content-type": "application/json" };
  if (cfg.token) headers["authorization"] = "Bearer " + cfg.token;
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    const txt = await res.text();
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = { raw: txt };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

// ----- IPC : config / session -----
ipcMain.handle("cfg:get", () => {
  const c = loadConfig();
  return { baseUrl: c.baseUrl, user: c.user || null, loggedIn: !!c.token };
});
ipcMain.handle("auth:login", async (_e, { baseUrl, email, password }) => {
  if (baseUrl) saveConfig({ baseUrl: String(baseUrl).trim() });
  const r = await apiFetch("POST", "/api/studio/login", { email, password, app: "streamer" });
  if (r.ok && r.data && r.data.token) {
    saveConfig({ token: r.data.token, user: r.data.user });
    return { ok: true, user: r.data.user };
  }
  return { ok: false, error: (r.data && r.data.error) || r.error || "HTTP " + r.status };
});
ipcMain.handle("auth:logout", () => {
  saveConfig({ token: null, user: null });
  return { ok: true };
});
ipcMain.handle("api", (_e, { method, path: p, body }) => apiFetch(method, p, body));

// ----- relais contrôle <-> source -----
function toSource(msg) {
  sourceWin?.webContents.send("from-control", msg);
}
function toControl(msg) {
  controlWin?.webContents.send("from-source", msg);
}
ipcMain.on("to-source", (_e, msg) => toSource(msg));
ipcMain.on("to-control", (_e, msg) => toControl(msg));
ipcMain.on("source:show", () => createSource());
ipcMain.on("source:hide", () => sourceWin?.hide());
ipcMain.on("source:focus", () => {
  sourceWin?.show();
  sourceWin?.focus();
});

// ----- TikTok Live -----
function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}
function normalizeGift(data) {
  const user = data.user || {};
  const gift = data.gift || data.giftDetails || {};
  const uniqueId = pick(user.uniqueId, data.uniqueId, data.userId, "anon");
  const nickname = pick(user.nickname, data.nickname, uniqueId);
  const avatar = pick(
    user.profilePicture?.urls?.[0],
    user.profilePicture?.url?.[0],
    user.profilePictureUrl,
    data.profilePictureUrl,
    Array.isArray(data.profilePictureUrls) ? data.profilePictureUrls[0] : undefined,
    "",
  );
  const diamonds = Number(pick(gift.diamondCount, data.diamondCount, gift.diamond_count, 1));
  const count = Number(pick(data.repeatCount, data.repeat_count, gift.repeatCount, 1));
  const giftType = pick(gift.type, data.giftType, gift.giftType);
  const repeatEnd = pick(data.repeatEnd, data.repeat_end);
  return { uniqueId, nickname, avatar, diamonds, count, giftType, repeatEnd };
}
function connectTikTok(rawUser) {
  const username = String(rawUser || "").replace(/^@+/, "").trim();
  if (!username) return toControl({ type: "tiktok", status: "error", error: "Pseudo TikTok manquant." });
  let TT;
  try {
    TT = require("tiktok-live-connector");
  } catch {
    return toControl({ type: "tiktok", status: "error", error: "Module TikTok indisponible (npm install)." });
  }
  const ConnectionClass =
    TT.TikTokLiveConnection || TT.default?.TikTokLiveConnection || TT.WebcastPushConnection || TT.default?.WebcastPushConnection;
  if (!ConnectionClass) return toControl({ type: "tiktok", status: "error", error: "Version tiktok-live-connector non reconnue." });
  try {
    tiktok?.disconnect?.();
  } catch {}
  tiktok = new ConnectionClass(username);
  const on = (ev, h) => {
    try {
      tiktok.on(ev, h);
    } catch {}
  };
  on("connected", () => {
    toControl({ type: "tiktok", status: "connected", username });
    toSource({ type: "event", event: { type: "connected" } });
  });
  on("disconnected", () => {
    toControl({ type: "tiktok", status: "disconnected" });
    toSource({ type: "event", event: { type: "disconnected" } });
  });
  on("streamEnd", () => {
    toControl({ type: "tiktok", status: "disconnected" });
    toSource({ type: "event", event: { type: "disconnected" } });
  });
  on("gift", (data) => {
    const g = normalizeGift(data);
    if (g.giftType === 1 && g.repeatEnd === false) return; // série en cours
    toSource({ type: "event", event: { type: "gift", userId: g.uniqueId, nickname: g.nickname, avatar: g.avatar, diamonds: g.diamonds, count: g.count } });
    toControl({ type: "gift", nickname: g.nickname, diamonds: g.diamonds });
  });
  toControl({ type: "tiktok", status: "connecting", username });
  tiktok.connect().catch((err) => toControl({ type: "tiktok", status: "error", error: (err && err.message) || String(err) }));
}
ipcMain.on("tiktok:connect", (_e, u) => connectTikTok(u));
ipcMain.on("tiktok:disconnect", () => {
  try {
    tiktok?.disconnect?.();
  } catch {}
  tiktok = null;
  toControl({ type: "tiktok", status: "disconnected" });
  toSource({ type: "event", event: { type: "disconnected" } });
});
