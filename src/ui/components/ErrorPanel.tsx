import React from 'react'

type ErrorShape = { error: string; stage?: string; symbol?: string | null; stack?: string[] }

type Props = { payload: ErrorShape | null }

export const ErrorPanel: React.FC<Props> = ({ payload }) => {
  if (!payload) return null
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)) } catch { console.info('Clipboard skipped: document not focused') }
  }
  return (
    <div className="error mt-12">
      <div className="row gap-12" style={{ justifyContent: 'space-between' }}>
        <div className="row gap-12">
          <strong>Server error</strong>
          <span className="pill err">{payload.stage ?? 'unknown'}</span>
          <span className="pill">{payload.symbol ?? '—'}</span>
        </div>
        <button className="btn" onClick={onCopy}>Copy error JSON</button>
      </div>
      <div className="monospace mt-8" style={{ whiteSpace: 'pre-wrap' }}>{payload.error}</div>
      {Array.isArray(payload.stack) && payload.stack.length > 0 && (
        <details className="mt-8">
          <summary>Stack</summary>
          <pre className="monospace" style={{ whiteSpace: 'pre-wrap' }}>{payload.stack.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}


