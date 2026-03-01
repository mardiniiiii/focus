const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  saveHTML: () => ipcRenderer.invoke('save-html'),
})
