import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * A crash on one screen must not take the whole application with it.
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * On a phone that is a white screen with no way back except reloading the app
 * and hoping - and the thing that threw is usually a small mistake on one
 * page, not a broken application.
 *
 * This catches it, says what happened, and offers the two ways out that always
 * work: back to the previous screen, or a full reload. The error message is
 * shown, not swallowed: a blank page is worse than an ugly one, because a blank
 * page tells nobody anything.
 */
type Props = {
  children: ReactNode
  /** What the screen was for, shown in the message. */
  label?: string
}

type State = { error: Error | null }

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is the only place the stack can go in a browser app. It is
    // not swallowed: the message on the screen says the same thing.
    console.error('This screen failed to render', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="content">
        <div className="card access-card">
          <h1>This screen could not be shown</h1>
          <p>
            {this.props.label ? `The ${this.props.label} screen ` : 'This screen '}
            ran into a problem and was stopped rather than left half drawn.
          </p>
          <p className="muted" style={{ overflowWrap: 'anywhere' }}>{error.message}</p>
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="button button-secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button type="button" className="button button-primary" onClick={() => { window.location.href = '/billing-dashboard' }}>
              Back to the overview
            </button>
          </div>
        </div>
      </div>
    )
  }
}
