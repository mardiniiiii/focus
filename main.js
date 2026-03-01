const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { WebSocketServer } = require('ws')

let extensionSocket = null

const wss = new WebSocketServer({ port: 3000 })
wss.on('connection', (ws) => {
  extensionSocket = ws
  ws.on('close', () => { extensionSocket = null })
})

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.loadFile('index.html')
}

ipcMain.handle('save-html', () => {
  return new Promise((resolve, reject) => {
    if (!extensionSocket) {
      return reject(new Error('Extension not connected.\nMake sure the extension is loaded in Chromium.'))
    }

    extensionSocket.once('message', (data) => {
      const { html } = JSON.parse(data)
      const savePath = path.join(__dirname, 'saved.html')
      fs.writeFileSync(savePath, html, 'utf-8')
      resolve(savePath)
    })

    extensionSocket.send(JSON.stringify({ type: 'get-html' }))
  })
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
