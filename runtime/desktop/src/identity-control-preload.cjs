const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wursterIdentity', Object.freeze({
  context: () => ipcRenderer.invoke('wurster:identity-control:context'),
  verify: () => ipcRenderer.invoke('wurster:identity-control:verify')
}));
