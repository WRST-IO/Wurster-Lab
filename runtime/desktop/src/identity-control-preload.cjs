const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('wurster:identity:layout', (_event, layout = {}) => {
  try {
    window.dispatchEvent(new CustomEvent('wurster-identity-layout', { detail: layout }));
  } catch {}
});

contextBridge.exposeInMainWorld('wursterIdentity', Object.freeze({
  context: () => ipcRenderer.invoke('wurster:identity-control:context'),
  verify: () => ipcRenderer.invoke('wurster:identity-control:verify')
}));
