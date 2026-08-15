const { contextBridge, ipcRenderer, webUtils } = require('electron');

function filePath(file) {
  return webUtils.getPathForFile(file);
}

contextBridge.exposeInMainWorld('wursterLauncher', Object.freeze({
  choose: () => ipcRenderer.invoke('wurster:launcher:choose'),
  openFile: (file) => ipcRenderer.invoke('wurster:launcher:open', filePath(file)),
  identities: () => ipcRenderer.invoke('wurster:launcher:identities'),
  back: () => ipcRenderer.invoke('wurster:launcher:back'),
  minimize: () => ipcRenderer.send('wurster:launcher:minimize'),
  close: () => ipcRenderer.send('wurster:launcher:close')
}));

contextBridge.exposeInMainWorld('meatGrinder', Object.freeze({
  chooseSource: () => ipcRenderer.invoke('wurster:grinder:choose-source'),
  chooseCarrier: () => ipcRenderer.invoke('wurster:grinder:choose-carrier'),
  useDroppedSource: (file) => ipcRenderer.invoke('wurster:grinder:set-source', filePath(file)),
  useDroppedCarrier: (file) => ipcRenderer.invoke('wurster:grinder:set-carrier', filePath(file)),
  build: () => ipcRenderer.invoke('wurster:grinder:build'),
  reveal: () => ipcRenderer.invoke('wurster:grinder:reveal'),
  signers: () => ipcRenderer.invoke('wurster:grinder:signers'),
  selectSigner: (id) => ipcRenderer.invoke('wurster:grinder:signer-select', id),
  addSigner: (payload) => ipcRenderer.invoke('wurster:grinder:signer-add', payload),
  verifySigner: (id) => ipcRenderer.invoke('wurster:grinder:signer-verify', id),
  beginAuthorityDomain: (id) => ipcRenderer.invoke('wurster:grinder:authority-domain-begin', id),
  completeAuthorityDomain: (id) => ipcRenderer.invoke('wurster:grinder:authority-domain-complete', id),
  beginAuthorityEmail: (id) => ipcRenderer.invoke('wurster:grinder:authority-email-begin', id),
  completeAuthorityEmail: (id, code) => ipcRenderer.invoke('wurster:grinder:authority-email-complete', id, code),
  onState: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('wurster:grinder:state', (_event, state) => callback(state));
  }
}));

contextBridge.exposeInMainWorld('wursterSettings', Object.freeze({
  context: () => ipcRenderer.invoke('wurster:settings:context'),
  generateMeatphrase: () => ipcRenderer.invoke('wurster:settings:generate-meatphrase'),
  addIdentity: (payload) => ipcRenderer.invoke('wurster:settings:identity:add', payload),
  updateIdentity: (id, payload) => ipcRenderer.invoke('wurster:settings:identity:update', id, payload),
  deleteIdentity: (id) => ipcRenderer.invoke('wurster:settings:identity:delete', id),
  revealIdentity: (id, totp) => ipcRenderer.invoke('wurster:settings:identity:reveal', id, { totp }),
  copyPublicIdentity: (id) => ipcRenderer.invoke('wurster:settings:identity:public-copy', id),
  savePublicIdentity: (id) => ipcRenderer.invoke('wurster:settings:identity:public-save', id),
  addPublisherSigner: (payload) => ipcRenderer.invoke('wurster:settings:publisher:add', payload),
  verifyPublisherSigner: (id) => ipcRenderer.invoke('wurster:settings:publisher:verify', id),
  beginPublisherAuthorityDomain: (id) => ipcRenderer.invoke('wurster:settings:publisher:authority-domain-begin', id),
  completePublisherAuthorityDomain: (id) => ipcRenderer.invoke('wurster:settings:publisher:authority-domain-complete', id),
  beginPublisherAuthorityEmail: (id) => ipcRenderer.invoke('wurster:settings:publisher:authority-email-begin', id),
  completePublisherAuthorityEmail: (id, code) => ipcRenderer.invoke('wurster:settings:publisher:authority-email-complete', id, code),
  revealPublisherSigner: (id) => ipcRenderer.invoke('wurster:settings:publisher:reveal', id),
  importPublisherSigner: (meatphrase) => ipcRenderer.invoke('wurster:settings:publisher:import', meatphrase),
  exportPublisherSigner: (id) => ipcRenderer.invoke('wurster:settings:publisher:export', id),
  deletePublisherSigner: (id) => ipcRenderer.invoke('wurster:settings:publisher:delete', id),
  beginTotp: () => ipcRenderer.invoke('wurster:settings:totp:begin'),
  confirmTotp: (code) => ipcRenderer.invoke('wurster:settings:totp:confirm', code),
  disableTotp: (code) => ipcRenderer.invoke('wurster:settings:totp:disable', code),
  setAutoUpdate: (enabled) => ipcRenderer.invoke('wurster:settings:update:auto', Boolean(enabled))
}));

contextBridge.exposeInMainWorld('wursterUpdate', Object.freeze({
  onState: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('wurster:update:state', (_event, state) => callback(state));
  }
}));

contextBridge.exposeInMainWorld('wursterVerification', Object.freeze({
  context: () => ipcRenderer.invoke('wurster:verification:context'),
  close: () => ipcRenderer.invoke('wurster:verification:close')
}));
