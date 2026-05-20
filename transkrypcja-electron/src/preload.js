const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveBinary: (opts) => ipcRenderer.invoke('save-binary', opts),
  transcribe: (opts) => ipcRenderer.invoke('transcribe', opts),
  onProgress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
});
