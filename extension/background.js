const ws = new WebSocket('ws://localhost:3000')

ws.addEventListener('message', async (event) => {
  const { type } = JSON.parse(event.data)

  if (type === 'get-html') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const [{ result: html }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    })
    ws.send(JSON.stringify({ html }))
  }
})
