const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wursterAuth', Object.freeze({
  context: () => ipcRenderer.invoke('wurster:auth:context'),
  submitManual: (value) => ipcRenderer.invoke('wurster:auth:manual', String(value ?? '')),
  beginIdentity: (identityId) => ipcRenderer.invoke('wurster:auth:identity', String(identityId ?? '')),
  submitTotp: (code) => ipcRenderer.invoke('wurster:auth:totp', String(code ?? '')),
  setExpanded: (expanded) => ipcRenderer.invoke('wurster:auth:expanded', Boolean(expanded)),
  onLayout: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, layout) => callback(layout);
    ipcRenderer.on('wurster:auth:layout', listener);
    return () => ipcRenderer.removeListener('wurster:auth:layout', listener);
  },
  manageIdentities: () => ipcRenderer.invoke('wurster:auth:manage-identities')
}));
