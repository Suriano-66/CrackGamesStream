const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stream", {
  getConfig: () => ipcRenderer.invoke("cfg:get"),
  login: (baseUrl, email, password) => ipcRenderer.invoke("auth:login", { baseUrl, email, password }),
  logout: () => ipcRenderer.invoke("auth:logout"),
  api: (method, path, body) => ipcRenderer.invoke("api", { method, path, body }),
  toSource: (msg) => ipcRenderer.send("to-source", msg),
  onSource: (cb) => ipcRenderer.on("from-source", (_e, msg) => cb(msg)),
  showSource: () => ipcRenderer.send("source:show"),
  hideSource: () => ipcRenderer.send("source:hide"),
  focusSource: () => ipcRenderer.send("source:focus"),
  tiktokConnect: (u) => ipcRenderer.send("tiktok:connect", u),
  tiktokDisconnect: () => ipcRenderer.send("tiktok:disconnect"),
});
