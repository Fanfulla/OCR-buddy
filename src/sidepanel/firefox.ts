import './sidepanel'

const ocrHost = document.createElement('iframe')
ocrHost.src = chrome.runtime.getURL('src/offscreen/offscreen.html')
ocrHost.title = 'OCR engine'
ocrHost.tabIndex = -1
ocrHost.hidden = true
ocrHost.setAttribute('aria-hidden', 'true')
document.body.append(ocrHost)