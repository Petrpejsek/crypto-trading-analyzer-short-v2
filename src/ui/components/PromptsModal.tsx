/**
 * PromptsModal - Dev-only editor pro prompty asistentů
 * 
 * Umožňuje editaci promptů s:
 * - SHA-256 verifikací
 * - Lint kontrolami
 * - Atomic save flow
 * - Read-after-write attestací
 */

import React, { useEffect, useState } from 'react'

type Assistant = {
  assistantKey: string
  hasOverlay: boolean
  sha256?: string
  updatedAt?: string
  revision?: string
}

type PromptDetail = {
  text: string
  sha256: string
  revision: string
  updatedAt: string
}

type PromptsModalProps = {
  isOpen: boolean
  onClose: () => void
}

// Pomocná funkce pro výpočet SHA-256 hash pomocí Web Crypto API
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return hashHex
}

// Dev auth token z localStorage
function getDevToken(): string {
  try {
    let token = localStorage.getItem('dev_auth_token')
    if (!token) {
      token = 'dev-secret-token' // default
      localStorage.setItem('dev_auth_token', token)
    }
    return token
  } catch {
    return 'dev-secret-token'
  }
}

export const PromptsModal: React.FC<PromptsModalProps> = ({ isOpen, onClose }) => {
  const [assistants, setAssistants] = useState<Assistant[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [promptDetail, setPromptDetail] = useState<PromptDetail | null>(null)
  const [editedText, setEditedText] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  
  // Confirm dialog state
  const [showConfirm, setShowConfirm] = useState(false)
  const [confirmChecked, setConfirmChecked] = useState(false)
  
  // Export state
  const [showExportConfirm, setShowExportConfirm] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [exportResults, setExportResults] = useState<any>(null)
  
  // Current hash (computed async)
  const [currentHash, setCurrentHash] = useState<string>('—')

  // Load seznam asistentů
  useEffect(() => {
    if (!isOpen) return
    
    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        
        const res = await fetch('/dev/prompts', {
          headers: {
            'X-Dev-Auth': getDevToken()
          }
        })
        
        if (!res.ok) {
          if (res.status === 401) {
            throw new Error('Unauthorized - zkontroluj DEV_AUTH_TOKEN')
          }
          throw new Error(`HTTP ${res.status}`)
        }
        
        const data = await res.json()
        setAssistants(data.assistants || [])
      } catch (e: any) {
        setError(e?.message || 'Chyba při načítání asistentů')
      } finally {
        setLoading(false)
      }
    }
    
    load()
  }, [isOpen])
  
  // Load detail vybraného promptu
  useEffect(() => {
    if (!selectedKey) {
      setPromptDetail(null)
      setEditedText('')
      return
    }
    
    const loadDetail = async () => {
      try {
        setLoading(true)
        setError(null)
        setSaveStatus(null)
        
        // Zkus načíst overlay
        const res = await fetch(`/dev/prompts/${selectedKey}`, {
          headers: {
            'X-Dev-Auth': getDevToken()
          }
        })
        
        if (res.status === 404) {
          // Overlay neexistuje - načti z registry
          const registryPath = `/prompts/short/${selectedKey}.md`
          try {
            const regRes = await fetch(registryPath)
            if (regRes.ok) {
              const text = await regRes.text()
              setEditedText(text)
              setPromptDetail(null)
            } else {
              throw new Error('Registry prompt nenalezen')
            }
          } catch (e: any) {
            setError(`Prompt nenalezen ani v overlay ani v registry: ${e?.message}`)
          }
        } else if (res.ok) {
          const data: PromptDetail = await res.json()
          setPromptDetail(data)
          setEditedText(data.text)
        } else {
          throw new Error(`HTTP ${res.status}`)
        }
      } catch (e: any) {
        setError(e?.message || 'Chyba při načítání promptu')
      } finally {
        setLoading(false)
      }
    }
    
    loadDetail()
  }, [selectedKey])
  
  // Compute current hash when text changes
  useEffect(() => {
    if (!editedText) {
      setCurrentHash('—')
      return
    }
    
    sha256(editedText).then(hash => {
      setCurrentHash(hash.slice(0, 16))
    }).catch(() => {
      setCurrentHash('error')
    })
  }, [editedText])
  
  // Uložení promptu
  const handleSave = async () => {
    if (!selectedKey || !editedText) return
    
    try {
      setLoading(true)
      setError(null)
      setSaveStatus('Počítám hash...')
      
      // Spočítej clientSha256
      const clientSha256 = await sha256(editedText)
      
      setSaveStatus('Ukládám...')
      
      const res = await fetch(`/dev/prompts/${selectedKey}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Dev-Auth': getDevToken()
        },
        body: JSON.stringify({
          text: editedText,
          clientSha256,
          ifMatchRevision: promptDetail?.revision
        })
      })
      
      const data = await res.json()
      
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error('Revision conflict - někdo jiný upravil prompt, reload stránky')
        } else if (res.status === 422) {
          throw new Error(`Lint failed:\n${data.message || 'Neznámá chyba'}`)
        } else if (res.status === 400) {
          throw new Error(`SHA-256 mismatch:\n${data.message || 'Hash nesedí'}`)
        }
        throw new Error(data.message || `HTTP ${res.status}`)
      }
      
      setSaveStatus('Verifikuji...')
      
      // Read-after-write verifikace
      const verifyRes = await fetch(`/dev/prompts/${selectedKey}`, {
        headers: {
          'X-Dev-Auth': getDevToken()
        }
      })
      
      if (!verifyRes.ok) {
        throw new Error('Verifikace selhala - prompt se neuložil')
      }
      
      const verifyData: PromptDetail = await verifyRes.json()
      
      if (verifyData.sha256 !== clientSha256) {
        throw new Error(
          `Verifikace selhala: stored=${verifyData.sha256.slice(0, 16)}, expected=${clientSha256.slice(0, 16)}`
        )
      }
      
      // Success
      setSaveStatus(`✓ Uloženo (${verifyData.sha256.slice(0, 16)}...)`)
      setPromptDetail(verifyData)
      setShowConfirm(false)
      setConfirmChecked(false)
      
      // Reload seznam asistentů
      const listRes = await fetch('/dev/prompts', {
        headers: {
          'X-Dev-Auth': getDevToken()
        }
      })
      if (listRes.ok) {
        const listData = await listRes.json()
        setAssistants(listData.assistants || [])
      }
      
      setTimeout(() => setSaveStatus(null), 3000)
    } catch (e: any) {
      setError(e?.message || 'Chyba při ukládání')
    } finally {
      setLoading(false)
    }
  }
  
  const handleSaveClick = () => {
    setShowConfirm(true)
    setConfirmChecked(false)
  }
  
  const handleConfirmSave = () => {
    if (!confirmChecked) {
      setError('Musíš potvrdit checkbox')
      return
    }
    handleSave()
  }
  
  const handleExportAll = async () => {
    try {
      setLoading(true)
      setError(null)
      setExportStatus('Exportuji...')
      
      const res = await fetch('/dev/prompts/export-all', {
        method: 'POST',
        headers: {
          'X-Dev-Auth': getDevToken()
        }
      })
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      
      const data = await res.json()
      setExportResults(data)
      
      if (data.success > 0) {
        setExportStatus(`✓ Exportováno ${data.success}/${data.total} promptů`)
      } else {
        setExportStatus(`⚠️ Žádné prompty k exportu`)
      }
      
      setTimeout(() => {
        setExportStatus(null)
        setShowExportConfirm(false)
      }, 5000)
    } catch (e: any) {
      setError(e?.message || 'Chyba při exportu')
    } finally {
      setLoading(false)
    }
  }
  
  if (!isOpen) return null
  
  const storedHash = promptDetail?.sha256?.slice(0, 16) || '—'
  const isDirty = promptDetail && editedText !== promptDetail.text
  
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.8)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
      padding: 20
    }}>
      <div style={{
        background: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: 8,
        width: '90%',
        maxWidth: 1400,
        height: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #333',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Prompt Management (DEV)</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn"
              onClick={() => setShowExportConfirm(true)}
              disabled={loading}
              style={{
                padding: '4px 12px',
                background: '#16a34a',
                color: 'white',
                border: 'none',
                fontWeight: 600
              }}
              title="Export overlay → prompts/*.md"
            >
              📤 Export do Registry
            </button>
            <button
              className="btn"
              onClick={onClose}
              style={{ padding: '4px 12px' }}
            >
              ✕ Zavřít
            </button>
          </div>
        </div>
        
        {/* Content */}
        <div style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden'
        }}>
          {/* Sidebar - seznam asistentů */}
          <div style={{
            width: 280,
            borderRight: '1px solid #333',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div style={{ padding: 12, borderBottom: '1px solid #333', fontSize: 14, fontWeight: 600 }}>
              Asistenti ({assistants.length})
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              {assistants.map(a => (
                <div
                  key={a.assistantKey}
                  onClick={() => setSelectedKey(a.assistantKey)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    background: selectedKey === a.assistantKey ? '#2a2a2a' : 'transparent',
                    borderBottom: '1px solid #222',
                    fontSize: 13
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{a.assistantKey}</div>
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                    {a.hasOverlay ? (
                      <>✓ Overlay ({a.sha256?.slice(0, 8)})</>
                    ) : (
                      <>Registry only</>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Editor panel */}
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            {loading && (
              <div style={{ padding: 20, textAlign: 'center' }}>Načítám...</div>
            )}
            
            {error && (
              <div style={{
                padding: 12,
                background: '#3a1a1a',
                color: '#ff6b6b',
                fontSize: 12,
                borderBottom: '1px solid #333',
                whiteSpace: 'pre-wrap'
              }}>
                {error}
              </div>
            )}
            
            {saveStatus && (
              <div style={{
                padding: 12,
                background: '#1a3a1a',
                color: '#6bff6b',
                fontSize: 12,
                borderBottom: '1px solid #333'
              }}>
                {saveStatus}
              </div>
            )}
            
            {exportStatus && (
              <div style={{
                padding: 12,
                background: exportStatus.startsWith('✓') ? '#1a3a1a' : '#3a3a1a',
                color: exportStatus.startsWith('✓') ? '#6bff6b' : '#ffa500',
                fontSize: 12,
                borderBottom: '1px solid #333'
              }}>
                {exportStatus}
                {exportResults && exportResults.failed > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11 }}>
                    Failed: {exportResults.results.filter((r: any) => !r.exported).map((r: any) => r.assistantKey).join(', ')}
                  </div>
                )}
              </div>
            )}
            
            {selectedKey && !loading && (
              <>
                {/* Info bar */}
                <div style={{
                  padding: '8px 12px',
                  background: '#0a0a0a',
                  borderBottom: '1px solid #333',
                  fontSize: 11,
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap'
                }}>
                  <div>
                    <strong>Key:</strong> {selectedKey}
                  </div>
                  <div>
                    <strong>Current hash:</strong> {currentHash}
                  </div>
                  <div>
                    <strong>Stored hash:</strong> {storedHash}
                  </div>
                  {promptDetail && (
                    <>
                      <div>
                        <strong>Revision:</strong> {promptDetail.revision}
                      </div>
                      <div>
                        <strong>Updated:</strong> {new Date(promptDetail.updatedAt).toLocaleString('cs-CZ')}
                      </div>
                    </>
                  )}
                  {isDirty && (
                    <div style={{ color: '#ffa500' }}>
                      ⚠ Neuložené změny
                    </div>
                  )}
                </div>
                
                {/* Editor */}
                <textarea
                  value={editedText}
                  onChange={(e) => setEditedText(e.target.value)}
                  placeholder="Prompt text..."
                  style={{
                    flex: 1,
                    padding: 16,
                    background: '#0a0a0a',
                    color: '#e0e0e0',
                    border: 'none',
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: 1.6,
                    resize: 'none',
                    outline: 'none'
                  }}
                />
                
                {/* Action bar */}
                <div style={{
                  padding: 12,
                  borderTop: '1px solid #333',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center'
                }}>
                  <button
                    className="btn"
                    onClick={handleSaveClick}
                    disabled={loading || !editedText}
                    style={{
                      padding: '6px 16px',
                      background: '#dc2626',
                      color: 'white',
                      border: 'none',
                      fontWeight: 600
                    }}
                  >
                    💾 Uložit
                  </button>
                  
                  {promptDetail && (
                    <button
                      className="btn"
                      onClick={() => setEditedText(promptDetail.text)}
                      disabled={loading}
                      style={{ padding: '6px 16px' }}
                    >
                      ↺ Reset
                    </button>
                  )}
                  
                  <div style={{ fontSize: 11, opacity: 0.7 }}>
                    {editedText.length} znaků
                  </div>
                </div>
              </>
            )}
            
            {!selectedKey && !loading && (
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                opacity: 0.5
              }}>
                ← Vyber asistenta ze seznamu
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Confirm modal */}
      {showConfirm && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <div style={{
            background: '#1a1a1a',
            border: '2px solid #dc2626',
            borderRadius: 8,
            padding: 24,
            maxWidth: 500
          }}>
            <h3 style={{ margin: '0 0 16px 0', color: '#dc2626' }}>
              ⚠️ Potvrzení uložení
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: 14 }}>
              Přepíšeš prompt pro <strong>{selectedKey}</strong> (dev overlay).
              <br />
              Toto je <strong>nevratné</strong> - starý text se smaže.
            </p>
            <p style={{ margin: '0 0 16px 0', fontSize: 13, opacity: 0.8 }}>
              Hash: {currentHash}
            </p>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              margin: '0 0 16px 0',
              fontSize: 14
            }}>
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              <span>Souhlasím a rozumím důsledkům</span>
            </label>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                className="btn"
                onClick={handleConfirmSave}
                disabled={!confirmChecked || loading}
                style={{
                  padding: '8px 16px',
                  background: confirmChecked ? '#dc2626' : '#666',
                  color: 'white',
                  border: 'none',
                  fontWeight: 600,
                  cursor: confirmChecked ? 'pointer' : 'not-allowed'
                }}
              >
                Uložit
              </button>
              <button
                className="btn"
                onClick={() => setShowConfirm(false)}
                disabled={loading}
                style={{ padding: '8px 16px' }}
              >
                Zrušit
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Export confirm modal */}
      {showExportConfirm && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <div style={{
            background: '#1a1a1a',
            border: '2px solid #16a34a',
            borderRadius: 8,
            padding: 24,
            maxWidth: 600
          }}>
            <h3 style={{ margin: '0 0 16px 0', color: '#16a34a' }}>
              📤 Export overlay → registry
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: 14 }}>
              Exportuješ <strong>všechny overlay prompty</strong> do <code>prompts/*.md</code>.
            </p>
            <div style={{ 
              margin: '0 0 16px 0', 
              padding: 12, 
              background: '#0a0a0a', 
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.6
            }}>
              <strong>⚠️ Co se stane:</strong>
              <ol style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
                <li>Overlay prompty se zkopírují do <code>prompts/*.md</code></li>
                <li>Registry soubory se <strong>přepíšou</strong></li>
                <li>Po exportu musíš <strong>commitnout</strong> <code>prompts/*.md</code></li>
                <li>Na produkci se použijí nové prompty</li>
              </ol>
            </div>
            <p style={{ margin: '0 0 16px 0', fontSize: 13, opacity: 0.8 }}>
              Celkem overlay: {assistants.filter(a => a.hasOverlay).length}
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                className="btn"
                onClick={handleExportAll}
                disabled={loading}
                style={{
                  padding: '8px 16px',
                  background: '#16a34a',
                  color: 'white',
                  border: 'none',
                  fontWeight: 600
                }}
              >
                Exportovat
              </button>
              <button
                className="btn"
                onClick={() => setShowExportConfirm(false)}
                disabled={loading}
                style={{ padding: '8px 16px' }}
              >
                Zrušit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
