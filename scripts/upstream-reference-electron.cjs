const { app, BrowserWindow, net, protocol } = require('electron')
const { join } = require('node:path')

let referenceWindow

const serverPort = Number('__REFERENCE_SERVER_PORT__')
const debuggingPort = Number('__REFERENCE_DEBUG_PORT__')

app.commandLine.appendSwitch('remote-debugging-port', String(debuggingPort))
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'reference',
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true
    }
  }
])

app.whenReady().then(() => {
  protocol.handle('reference', (request) => {
    const url = new URL(request.url)
    return net.fetch(`http://127.0.0.1:${serverPort}${url.pathname}${url.search}`)
  })
  referenceWindow = new BrowserWindow({
    show: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
      sandbox: false
    }
  })
  referenceWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  referenceWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('reference://app/')) return
    event.preventDefault()
  })
  referenceWindow.loadURL('reference://app/')
})
