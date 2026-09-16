import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: string
}

/**
 * Keeps a render or lifecycle failure from blanking the window.
 *
 * React unmounts the entire tree when an error escapes, which is what turned a throw in terminal
 * teardown into an empty window with nothing to go on. The failure is now shown and logged, and
 * the terminals themselves are unaffected — they live in the main process, so a reload reattaches
 * to them rather than losing them.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? '' })
    window.maestro.app.reportError(
      `render error: ${error.message}\n${error.stack ?? ''}\ncomponent stack:${info.componentStack ?? ''}`
    )
  }

  render(): ReactNode {
    const { error, info } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <div className="crash__card">
          <div className="launcher__head">
            <i className="ph ph-warning-circle" />
            <div>
              <div className="launcher__title">Something broke in the interface</div>
              <div className="launcher__sub">
                Your terminals are still running; reloading reattaches to them. Written to crash.log
                in the app’s data directory.
              </div>
            </div>
          </div>

          <pre className="cmd-block">
            {error.message}
            {error.stack ? `\n\n${error.stack.split('\n').slice(1, 6).join('\n')}` : ''}
            {info ? `\n${info.split('\n').slice(0, 6).join('\n')}` : ''}
          </pre>

          <div className="modal__actions">
            <button className="btn" onClick={() => this.setState({ error: null, info: '' })}>
              Try again
            </button>
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              <i className="ph ph-arrow-clockwise" style={{ fontSize: 15 }} />
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
