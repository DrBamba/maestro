import type { MaestroApi } from '../../preload/index'
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
  interface Window {
    maestro: MaestroApi
  }

  namespace React.JSX {
    interface IntrinsicElements {
      /** Electron's <webview>, used for the embedded code-server. */
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: boolean
          preload?: string
          useragent?: string
        },
        HTMLElement
      >
    }
  }
}

export {}
