import React from 'react'

// Catches render-time crashes so a single bad component shows a readable error
// (and the message/stack) instead of blanking the whole app to a white screen.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: '#f5f4f0', color: '#1c1c1e', fontFamily: 'system-ui, sans-serif', padding: '40px', boxSizing: 'border-box' }}>
          <div style={{ maxWidth: 720, margin: '40px auto', background: '#fff', border: '1px solid #ddd9d0', borderRadius: 12, padding: 28 }}>
            <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Something went wrong</h1>
            <p style={{ color: '#6b7280', fontSize: 14, marginTop: 0 }}>The page hit an error and stopped rendering. Your data is safe — reload to continue.</p>
            <button onClick={() => window.location.reload()} style={{ background: '#e8590c', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer', margin: '8px 0 18px' }}>Reload</button>
            <pre style={{ background: '#faf9f6', border: '1px solid #ddd9d0', borderRadius: 8, padding: 14, fontSize: 12, color: '#dc2626', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
            </pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
