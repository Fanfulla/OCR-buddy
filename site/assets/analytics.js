// Vercel Web Analytics (cookieless) + a small opt-out notice.
//
// This is a plain static HTML site, so we load the script Vercel serves at
// /_vercel/insights/script.js — NOT the Next.js React component. Enable "Web
// Analytics" for the project in the Vercel dashboard and that path is served
// automatically (it 404s on localhost, which is fine).
//
// The analytics are cookieless: no cookies, no tracking storage, no personal
// data — so they run by default. Visitors can opt out from the notice; the
// ONLY thing kept in localStorage is that choice (and that the notice was
// dismissed). When opted out, the analytics script is simply never loaded on
// the pages visited afterwards.
(function () {
  var KEY = 'ocrbuddy.analytics'          // 'off' = opted out; otherwise on
  var NOTICE = 'ocrbuddy.analytics-notice' // 'dismissed' = don't show the notice again

  function optedOut() {
    try { return localStorage.getItem(KEY) === 'off' } catch (e) { return false }
  }

  // 1. Load Vercel Web Analytics unless the visitor has opted out.
  if (!optedOut()) {
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments) }
    var s = document.createElement('script')
    s.defer = true
    s.src = '/_vercel/insights/script.js'
    document.head.appendChild(s)
  }

  // 2. Show the notice once — until dismissed, or a choice has been made.
  var seen = false
  try { seen = localStorage.getItem(NOTICE) === 'dismissed' || optedOut() } catch (e) {}
  if (seen) return

  function build() {
    var style = document.createElement('style')
    style.textContent =
      '.ab-bar{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;margin:0 auto;max-width:600px;' +
      'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 16px;' +
      'background:var(--surface,#1c1c22);color:var(--fg,#f0f0f3);' +
      'border:1px solid var(--border,#2c2c34);border-radius:12px;' +
      'box-shadow:0 12px 34px rgba(0,0,0,.4);' +
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'opacity:0;transform:translateY(10px);transition:opacity .25s,transform .25s}' +
      '.ab-bar.in{opacity:1;transform:none}' +
      '.ab-bar p{margin:0;flex:1 1 240px;color:var(--muted,#9c9ca6)}' +
      '.ab-bar a{color:var(--accent,#4f9cff);text-decoration:none}' +
      '.ab-bar a:hover{text-decoration:underline}' +
      '.ab-bar .ab-btns{display:flex;gap:8px;flex:none;margin-left:auto}' +
      '.ab-bar button{appearance:none;border:1px solid var(--border,#2c2c34);cursor:pointer;' +
      'padding:7px 14px;border-radius:8px;font:inherit;font-weight:600;' +
      'background:transparent;color:var(--fg,#f0f0f3)}' +
      '.ab-bar button.ab-primary{border-color:transparent;background:var(--accent,#4f9cff);color:#06203f}' +
      '.ab-bar button:hover{border-color:var(--muted,#9c9ca6)}' +
      '.ab-bar button.ab-primary:hover{border-color:transparent;filter:brightness(1.06)}'
    document.head.appendChild(style)

    var bar = document.createElement('div')
    bar.className = 'ab-bar'
    bar.setAttribute('role', 'note')
    bar.innerHTML =
      '<p>This site uses Vercel’s cookieless, privacy-friendly analytics — no cookies, no personal data. ' +
      '<a href="/privacy#analytics">Learn more</a>.</p>' +
      '<span class="ab-btns">' +
      '<button type="button" class="ab-out">Opt out</button>' +
      '<button type="button" class="ab-primary ab-ok">Got it</button>' +
      '</span>'
    document.body.appendChild(bar)
    requestAnimationFrame(function () { bar.classList.add('in') })

    function close() {
      bar.classList.remove('in')
      setTimeout(function () { bar.remove() }, 250)
    }
    bar.querySelector('.ab-ok').addEventListener('click', function () {
      try { localStorage.setItem(NOTICE, 'dismissed') } catch (e) {}
      close()
    })
    bar.querySelector('.ab-out').addEventListener('click', function () {
      // Forward-looking opt-out: remember the choice, and analytics won't load
      // on the pages visited from here on.
      try {
        localStorage.setItem(KEY, 'off')
        localStorage.setItem(NOTICE, 'dismissed')
      } catch (e) {}
      close()
    })
  }

  if (document.body) build()
  else document.addEventListener('DOMContentLoaded', build)
})()
