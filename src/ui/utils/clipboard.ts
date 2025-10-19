export type WriteClipboardOptions = {
  requireFocusForAuto?: boolean
}

// Safe, no-fallback clipboard write. Throws explicit error codes.
export async function writeClipboard(text: string, options: WriteClipboardOptions = {}): Promise<void> {
  const { requireFocusForAuto = true } = options

  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    const err: any = new Error('Clipboard API unavailable')
    err.code = 'clipboard_api_unavailable'
    throw err
  }
  if (typeof window !== 'undefined') {
    try {
      if ((window as any).isSecureContext === false) {
        const err: any = new Error('Insecure context: clipboard requires HTTPS/localhost')
        err.code = 'insecure_context'
        throw err
      }
    } catch {}
  }

  const hasFocus = (() => { try { return typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true } catch { return true } })()
  const isVisible = (() => { try { return typeof document !== 'undefined' ? (document.visibilityState === 'visible') : true } catch { return true } })()
  if (requireFocusForAuto && (!hasFocus || !isVisible)) {
    try { window.focus() } catch {}
    await new Promise(res => setTimeout(res, 120))
    const focusedNow = (() => { try { return typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true } catch { return true } })()
    const visibleNow = (() => { try { return typeof document !== 'undefined' ? (document.visibilityState === 'visible') : true } catch { return true } })()
    if (!(focusedNow && visibleNow)) {
      const err: any = new Error('document_not_focused')
      err.code = 'document_not_focused'
      throw err
    }
  }

  try {
    await navigator.clipboard.writeText(text)
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    if (msg.toLowerCase().includes('not allowed') || msg.toLowerCase().includes('permission')) {
      const err: any = new Error('Clipboard not allowed (needs user gesture / permission)')
      err.code = 'not_allowed'
      throw err
    }
    throw e
  }
}


