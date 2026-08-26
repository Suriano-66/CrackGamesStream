const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("src", {
  onControl: (cb) => ipcRenderer.on("from-control", (_e, msg) => cb(msg)),
  toControl: (msg) => ipcRenderer.send("to-control", msg),
});
