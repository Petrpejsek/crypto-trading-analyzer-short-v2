import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { DevAiOverview } from './ui/components/DevAiOverview'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container not found')
}

// Hash-based routing with dynamic navigation (NO FALLBACKS - backend serves only /)
// Routes: /#/ (root), /#/dev/ai-overview (AI overview)
const Router: React.FC = () => {
  const [currentRoute, setCurrentRoute] = useState(window.location.hash.slice(1) || '/')

  useEffect(() => {
    const handler = () => {
      setCurrentRoute(window.location.hash.slice(1) || '/')
    }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  const isAiOverview = currentRoute === '/dev/ai-overview'

  return (
    <>
      {isAiOverview ? (
        <DevAiOverview />
      ) : (
        <App />
      )}
    </>
  )
}

createRoot(container).render(<Router />)

