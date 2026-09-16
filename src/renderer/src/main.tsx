import { createRoot } from 'react-dom/client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@phosphor-icons/web/regular'
import '@xterm/xterm/css/xterm.css'

import './styles/theme.css'
import './styles/app.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { initialTheme } from './theme'

// Before the first render, not in an effect after it: an effect runs after the browser has already
// had a chance to paint, which is a white window appearing dark for a frame, or the reverse.
document.documentElement.dataset.theme = initialTheme()

// Deliberately not wrapped in StrictMode: its double-invoked mount effects would spawn and
// immediately kill a real `claude` PTY for every terminal on every mount.
/*
 * Uncaught errors are forwarded to main, which writes them to crash.log. Without this a failure in
 * the renderer is silent — the window simply stops working, which is what made a crash on session
 * delete undiagnosable.
 */
window.addEventListener('error', (event) => {
  window.maestro.app.reportError(
    `${event.message}\n  at ${event.filename}:${event.lineno}:${event.colno}\n${event.error?.stack ?? ''}`
  )
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { stack?: string; message?: string } | undefined
  window.maestro.app.reportError(
    `unhandled rejection: ${reason?.message ?? String(event.reason)}\n${reason?.stack ?? ''}`
  )
})

/*
 * Set before the first render, so the stylesheet can reserve the macOS traffic-light gutter — and
 * only reserve it there. On Linux the window keeps its native title bar, and an 80px hole in the
 * sidebar for controls that live somewhere else reads as a bug.
 */
document.documentElement.dataset.platform = window.maestro.platform

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
