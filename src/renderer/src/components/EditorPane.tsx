import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import type { ThemeName } from '@shared/theme'

export interface EditorHandle {
  /** Opens a worktree-absolute path in the embedded VS Code. */
  openFile: (absolutePath: string) => void
  /** Focuses the embed and asks VS Code for its SCM view. */
  openScm: () => void
  /** Focuses the embed and opens the command palette primed for the commit graph. */
  openGraph: () => void
}

interface EditorPaneProps {
  sessionId: string
  worktreePath: string
  /** Mounted-but-hidden so the workbench does not reload on every tab switch. */
  hidden: boolean
  /**
   * False when this pane is on screen but is not the one the keyboard belongs to — beside a Claude
   * that was just clicked, say. Only the focused pane may take focus, or every pane in an
   * arrangement would grab it as it appeared and the last one drawn would win.
   */
  autoFocus: boolean
  /** Bumped when the session hands the keyboard over, so a pane that moved takes it back. */
  focusToken: number
  /**
   * The resolved theme. The embed's colours come from a settings file main rewrites, which a
   * running workbench does not notice — so a change here is what makes this pane go and fetch it.
   */
  theme: ThemeName
  onNotice: (message: string) => void
}

interface ServerState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  folderUrl: string | null
  reason: string
}

function payloadUrl(folderUrl: string, absolutePath: string): string {
  const payload = JSON.stringify([['openFile', `vscode-remote://localhost${absolutePath}`]])
  return `${folderUrl}&payload=${encodeURIComponent(payload)}`
}

const EditorPane = forwardRef<EditorHandle, EditorPaneProps>(function EditorPane(
  { sessionId, worktreePath, hidden, autoFocus, focusToken, theme, onNotice },
  ref
) {
  const [server, setServer] = useState<ServerState>({
    status: 'idle',
    folderUrl: null,
    reason: ''
  })
  const webviewRef = useRef<WebviewTag | null>(null)
  /**
   * A file asked for before there was a workbench to open it in.
   *
   * code-server starts the first time this tab is looked at, so a session's first `openFile` arrives
   * with no webview and no folder URL — and was silently dropped, which from outside looked like the
   * Editor tab opening on nothing in particular. It cannot be applied the moment the element mounts
   * either: `loadURL` on a webview that has not emitted `dom-ready` throws, which took the whole
   * renderer down with it.
   */
  const pendingFileRef = useRef<string | null>(null)
  /** Readable from the `dom-ready` listener, which is wired once and never sees a later render. */
  const folderUrlRef = useRef<string | null>(null)
  /** The file tree is only the right target the first time; after that VS Code knows better. */
  const focusedOnceRef = useRef(false)
  /**
   * Whether the workbench should take focus once it has loaded. True for a load the user asked for
   * — opening the tab, opening a file — and false for one we imposed on them, which is what a
   * reload for a theme change is.
   */
  const takeFocusRef = useRef(true)
  /** The theme the loaded workbench was built with, so only a real change costs a reload. */
  const loadedThemeRef = useRef(theme)
  /** Set when the workbench is on a theme the app has moved off; cleared by reloading it. */
  const [staleTheme, setStaleTheme] = useState<ThemeName | null>(null)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  folderUrlRef.current = server.folderUrl

  // Start code-server lazily — the first time this session's editor is actually looked at.
  useEffect(() => {
    if (hidden || server.status !== 'idle') return
    setServer((s) => ({ ...s, status: 'loading' }))
    void window.maestro.editor.codeServer(sessionId).then((info) => {
      if (info.available && info.folderUrl) {
        setServer({ status: 'ready', folderUrl: info.folderUrl, reason: '' })
      } else {
        setServer({ status: 'unavailable', folderUrl: null, reason: info.reason })
      }
    })
  }, [hidden, sessionId, server.status])

  /**
   * The embedded workbench has no external command API, so shortcuts are delivered as real
   * key events to the guest — the same thing the user pressing them would produce.
   */
  const sendKey = useCallback((keyCode: string, modifiers: string[], view?: WebviewTag) => {
    view = view ?? webviewRef.current ?? undefined
    if (!view) return
    view.focus()
    view.sendInputEvent({ type: 'keyDown', keyCode, modifiers } as Parameters<
      WebviewTag['sendInputEvent']
    >[0])
    view.sendInputEvent({ type: 'keyUp', keyCode, modifiers } as Parameters<
      WebviewTag['sendInputEvent']
    >[0])
  }, [])

  /**
   * There is no setting for side-bar visibility, so it is opened by toggling it — but only after
   * measuring. VS Code persists layout per origin, so a blind toggle would close it again on the
   * next launch.
   */
  const ensureSideBarVisible = useCallback(
    async (view: WebviewTag) => {
      /*
       * Consumed here rather than read at the end, so it applies to exactly one load. Left to be
       * cleared further down it would survive a probe that gives up before the workbench appears,
       * and this pane would then never focus itself again.
       */
      const takeFocus = takeFocusRef.current
      takeFocusRef.current = true

      // Reports visibility and which keymap the workbench is using, since the toggle chord
      // differs: Cmd+B on macOS, Ctrl+B elsewhere. Ctrl+B is inert on a mac workbench.
      const probe = `(() => {
        const wb = document.querySelector('.monaco-workbench');
        if (!wb) return 'notready';
        const keymap = wb.classList.contains('mac') ? 'mac' : 'other';
        const sb = wb.querySelector('.part.sidebar');
        const shown = sb ? sb.getBoundingClientRect().width > 1 : false;
        return (shown ? 'visible:' : 'hidden:') + keymap;
      })()`

      for (let attempt = 0; attempt < 12; attempt++) {
        let state = 'notready'
        try {
          state = (await view.executeJavaScript(probe)) as string
        } catch {
          // Guest still navigating.
        }
        const mac = state.endsWith(':mac')
        if (state.startsWith('hidden')) sendKey('B', [mac ? 'meta' : 'control'], view)
        if (state.startsWith('visible') || state.startsWith('hidden')) {
          /*
           * On the first load there is nothing for the workbench to restore focus to, and it
           * lands nowhere useful — so put the caret in the file tree, which is where you start.
           * Later visits skip this and let VS Code restore whatever was focused last: an editor,
           * a terminal, the SCM view.
           */
          if (!focusedOnceRef.current) {
            focusedOnceRef.current = true
            sendKey('E', ['shift', mac ? 'meta' : 'control'], view)
          } else if (takeFocus) {
            view.focus()
          }
          return
        }
        await new Promise((r) => setTimeout(r, 300))
      }
    },
    [sendKey]
  )

  const attachWebview = useCallback(
    (el: HTMLElement | null) => {
      const view = el as WebviewTag | null
      webviewRef.current = view
      if (!view || view.dataset.maestroWired === '1') return
      view.dataset.maestroWired = '1'
      view.addEventListener('dom-ready', () => {
        /*
         * A held file is navigated to first, and the sidebar left to the `dom-ready` that navigation
         * itself produces — the workbench about to be replaced is not the one worth measuring.
         */
        const pending = pendingFileRef.current
        if (pending && folderUrlRef.current) {
          pendingFileRef.current = null
          void view.loadURL(payloadUrl(folderUrlRef.current, pending))
          return
        }
        void ensureSideBarVisible(view)
      })
      // The server can die from outside the app; recover rather than showing a dead page.
      view.addEventListener('did-fail-load', (event) => {
        const e = event as unknown as { errorCode?: number }
        // -3 is an aborted navigation, which happens routinely when loading a payload URL.
        if (e.errorCode === -3) return
        setServer({ status: 'idle', folderUrl: null, reason: '' })
      })
    },
    [ensureSideBarVisible]
  )

  /*
   * Hand keyboard focus to the workbench whenever the tab becomes visible. Without this, clicking
   * the Editor tab leaves focus on the tab button and nothing typed reaches VS Code.
   *
   * Two frames, not one: the pane goes from display:none to visible in the same commit, and an
   * element that has not been laid out yet cannot take focus.
   */
  useEffect(() => {
    if (hidden || !autoFocus || server.status !== 'ready') return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => webviewRef.current?.focus())
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [hidden, autoFocus, focusToken, server.status])

  /*
   * Recolouring the embed.
   *
   * The workbench reads its colours from a settings file once, when it loads, and goes on ignoring
   * that file for the rest of its life — so unlike the shell and the terminal, which repaint where
   * they stand, this one has to be loaded again. Noting it and reloading it are separate steps
   * because the moment the theme changes is usually the wrong moment to do it.
   */
  useEffect(() => {
    if (loadedThemeRef.current === theme) return
    loadedThemeRef.current = theme
    setStaleTheme(theme)
  }, [theme])

  useEffect(() => {
    if (staleTheme === null) return

    // Nothing is loaded, so nothing is stale: whatever loads next reads the new settings itself.
    if (server.status !== 'ready' || !webviewRef.current) {
      setStaleTheme(null)
      return
    }

    /*
     * Held until this editor is actually on screen. Reloading a hidden one would spend a workbench
     * startup per open session for a tab nobody is looking at, and would pull the caret out of
     * whatever the user was typing into and drop it inside an invisible webview.
     */
    if (hidden) return

    setStaleTheme(null)
    // A reload the user did not ask for should not move the caret; it only puts it back.
    takeFocusRef.current = document.activeElement === webviewRef.current
    webviewRef.current.reload()
  }, [staleTheme, hidden, server.status])

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      openFile: (absolutePath: string) => {
        const view = webviewRef.current
        if (!view || !server.folderUrl) {
          // Held for the first `dom-ready` — see {@link pendingFileRef}.
          pendingFileRef.current = absolutePath
          return
        }
        void view.loadURL(payloadUrl(server.folderUrl, absolutePath))
      },
      openScm: () => {
        if (!webviewRef.current) {
          noticeRef.current('The editor is not running yet.')
          return
        }
        sendKey('G', ['control', 'shift'])
      },
      openGraph: () => {
        if (!webviewRef.current) {
          noticeRef.current('The editor is not running yet.')
          return
        }
        sendKey('F1', [])
        noticeRef.current('Command palette open in the editor — type “Git Graph”.')
      }
    }),
    [sendKey, server.folderUrl]
  )

  return (
    <div className="editor__surface">
      {server.status === 'ready' && server.folderUrl ? (
        <webview
          ref={attachWebview}
          src={server.folderUrl}
          // eslint-disable-next-line react/no-unknown-property
          partition="persist:maestro-editor"
          // Links VS Code opens (a terminal Cmd+click, say) are popups; main sends them to the browser.
          // A string, because React drops a boolean here and the attribute only counts if present.
          // eslint-disable-next-line react/no-unknown-property
          allowpopups={'true' as unknown as boolean}
        />
      ) : (
        <div className="embed-placeholder">
          <i className="ph ph-code" />
          <div className="embed-placeholder__title">⟨ embed: code-server · full VS Code ⟩</div>
          <div className="embed-placeholder__note">
            {server.status === 'loading'
              ? 'starting code-server…'
              : server.status === 'idle' && server.reason === ''
                ? 'the editor server stopped — retry to start it again'
              : server.status === 'unavailable'
                ? server.reason
                : 'editing, search, go-to-definition, linting, diff editor, SCM staging & commit graph'}
          </div>
          {server.status === 'unavailable' && (
            <>
              {/*
               * The way back out. `unavailable` is otherwise terminal — the startup effect only
               * fires from `idle` — so a server that failed to come up once left this tab dead for
               * the rest of the session, even after the server was healthy again.
               */}
              <button
                className="btn btn--small"
                onClick={() => setServer({ status: 'idle', folderUrl: null, reason: '' })}
              >
                <i className="ph ph-arrow-clockwise" style={{ fontSize: 14 }} />
                Retry
              </button>
              <button
                className="btn btn--small"
                onClick={() => void window.maestro.editor.openExternal(worktreePath)}
              >
                <i className="ph ph-arrow-square-out" style={{ fontSize: 14 }} />
                Open in VS Code instead
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
})

export default EditorPane
