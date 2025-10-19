/**
 * 🔊 KOMPLETNÍ ZVUKOVÝ SYSTÉM
 * 
 * Používá DVOJE AUDIO TECHNOLOGIE:
 * 1. HTML5 Audio API - pro jednoduché beep zvuky (position open)
 * 2. Web Audio API - pro komplexní melodie (price alerts, profit close, order filled)
 * 
 * Všechny zvuky jsou procedurálně generované nebo Base64 embedded - žádné externí soubory.
 */

// ============================================================================
// GLOBÁLNÍ STAV & PERSISTENCE
// ============================================================================

const STORAGE_KEY = 'sound_enabled'

let soundEnabled: boolean = (() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    // Default: ZAPNUTO (pokud není explicitně vypnuto)
    return stored !== '0'
  } catch {
    return true
  }
})()

export function getSoundEnabled(): boolean {
  return soundEnabled
}

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
    console.log('[SOUND_SETTINGS]', { enabled })
  } catch (e) {
    console.warn('[SOUND_SETTINGS] Failed to save to localStorage:', e)
  }
}

// ============================================================================
// 1️⃣ PRICE ALERT (Cenový Alert) - E6→G6→B6 (e-moll zvonky)
// ============================================================================

/**
 * Price Alert Sound - zvonečky při protnutí alert linky
 * 
 * Muzikální teorie: E6 (1319 Hz) → G6 (1568 Hz) → B6 (1976 Hz) = e-moll akord
 * Délka: ~850ms
 * Peak Volume: 0.3 (30%)
 * 
 * Trigger: Cena protne nastavenou alert linku (zatím neimplementováno)
 */
export function playPriceAlertSound(): void {
  if (!soundEnabled) return

  try {
    console.log('[PRICE_ALERT_SOUND] 🔔 Playing bell sound...')

    // Safari fallback
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextClass) {
      console.error('[ALERT_SOUND_ERROR] AudioContext not supported')
      return
    }

    const audioContext = new AudioContextClass()
    const now = audioContext.currentTime

    // Bell frequencies (E6, G6, B6)
    const frequencies = [1319, 1568, 1976]

    for (let i = 0; i < 3; i++) {
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)

      // Sine wave = čistý tón (zvonečky)
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequencies[i], now + i * 0.15)

      // ADSR Envelope
      gainNode.gain.setValueAtTime(0, now + i * 0.15)
      gainNode.gain.linearRampToValueAtTime(0.3, now + i * 0.15 + 0.01) // Attack 10ms
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.15 + 0.4) // Decay 400ms

      oscillator.start(now + i * 0.15)
      oscillator.stop(now + i * 0.15 + 0.4)
    }

    console.log('[PRICE_ALERT_SOUND] ✅ Bell sound played')
  } catch (error) {
    console.error('[ALERT_SOUND_ERROR]', error)
  }
}

// ============================================================================
// 2️⃣ POSITION OPEN - HTML5 Audio beep
// ============================================================================

/**
 * Position Open Sound - jednoduchý beep při otevření pozice
 * 
 * Technologie: HTML5 Audio API s Base64 WAV
 * Volume: 0.3 (30%)
 * 
 * Trigger: Když se zvýší počet otevřených pozic (zatím neimplementováno)
 */

// Base64 encoded WAV beep sound
const BEEP_WAV_BASE64 = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuEy/HWgDMIElmz6+SaSwkNTKXh8bllHAU2jdXvzIc0CAscbrHo4ppRDAo+mtvywHEkBS1+x+7ZiDkIFWe16OGYSgoLO5Xa8rx0JAUvisjv14gzBxJcsuXimFAKCzuW3PK8dSQFL4rI79eIMwcSW7Ll4phQCgs7ldzywnUkBS+KyO/XiDMHElux5eSYUAoLO5Xc8rx1JAUvisjv14gzBxJbseXkmFAKCzuV3PK8dSQFL4rI79eIMwcSW7Hl5JhQCgo7ldzywnQjBS+Kx+/YiDQIElux5uSYTwoKO5Tc8r12JAUvisjv14gzBxJcsuXjmFAKCjqU2/K+dCQFL4vH79aJMwcTW7Hm45hPCgo8ltzyvnYkBS+Kx+/WiDMHE1ux5uOYTwoKPJXb8r52JAUvi8fv1okzBxNbsebkmFAKCjyV3PK+diQFL4vH79aJMwcTW7Hm5JhQCgo8ldzyv3YkBS+Lx+/WiTMHE1ux5uSYUAoKPJXc8r52JAUvi8fv1okzBxNbsebjmFAKCjyW3PK/dSQFL4vH79eJMwcTW7Hm5JhQCQo7ldvywHYkBS+Lx+/WiTMHE1ux5uSYUAoLO5Xc8sFzIwUui8fv1okzBxNbsebkmFAKCzuV2/LBdiQFL4vH79aJMwcTW7Hm5JhQCgs7ldvywXYkBS+Lx+/WiTMHE1ux5uSYUAoLO5Xb8sJ1JAUvi8fv1okzBxNbsebkmFAKCzuW3PLCdiQFL4rI8NiINAcTXLHl5JhQCgs8ltvywnYkBS+KyPDYiDQHE1yx5eSYUAoLPJbb8sJ2JAUvisjw2Ig0BxNcseXkmFAKCzyW2/LCdiQFL4rI8NiINAcTXLHl5JhQCgs8ltvywncjBS+KyPDYiDQHE1yx5eSYUAoLO5Xb8sN1JAU='

let positionOpenAudioElement: HTMLAudioElement | null = null

export function playPositionOpenSound(): void {
  if (!soundEnabled) return

  try {
    console.log('[POSITION_OPEN_SOUND] 🔔 Playing beep...')

    // Lazy init
    if (!positionOpenAudioElement) {
      positionOpenAudioElement = new Audio(BEEP_WAV_BASE64)
      positionOpenAudioElement.volume = 0.3
      console.log('[SOUND_INIT] Position open audio element created')
    }

    // Reset a přehraj
    positionOpenAudioElement.currentTime = 0
    positionOpenAudioElement.play().catch((err) => {
      console.error('[POSITION_SOUND] Audio play failed:', err)
    })

    console.log('[POSITION_OPEN_SOUND] ✅ Beep played')
  } catch (error) {
    console.error('[POSITION_SOUND] ❌ Failed:', error)
  }
}

// ============================================================================
// 3️⃣ PROFIT CLOSE - C5→E5→G5→C6 (C dur melodie + oktáva)
// ============================================================================

/**
 * Profit Close Sound - veselá melodie při zavření v zisku >10%
 * 
 * Muzikální teorie: C5 (523.25Hz) → E5 (659.25Hz) → G5 (783.99Hz) → C6 (1046.50Hz)
 * = C dur akord + oktáva (veselý, optimistický zvuk)
 * Délka: ~610ms
 * Peak Volume: 0.35 (35%)
 * 
 * Trigger: Pozice zavřena s PnL > 10% (zatím neimplementováno)
 */
export function playProfitCloseSound(): void {
  if (!soundEnabled) return

  try {
    console.log('[PROFIT_SOUND] 🎉 Playing cheerful bells...')

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextClass) {
      console.error('[PROFIT_SOUND] ❌ AudioContext not supported')
      return
    }

    const audioContext = new AudioContextClass()
    const now = audioContext.currentTime

    // Veselá vzestupná melodie: C-E-G-C (dur akord + oktáva)
    const notes = [
      { freq: 523.25, start: 0, duration: 0.15 },      // C5
      { freq: 659.25, start: 0.12, duration: 0.15 },   // E5
      { freq: 783.99, start: 0.24, duration: 0.15 },   // G5
      { freq: 1046.50, start: 0.36, duration: 0.25 }   // C6 (oktáva)
    ]

    for (const note of notes) {
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)

      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(note.freq, now + note.start)

      // ADSR Envelope
      const startTime = now + note.start
      const endTime = startTime + note.duration

      gainNode.gain.setValueAtTime(0, startTime)
      gainNode.gain.linearRampToValueAtTime(0.35, startTime + 0.01) // Attack 10ms
      gainNode.gain.exponentialRampToValueAtTime(0.01, endTime) // Decay

      oscillator.start(startTime)
      oscillator.stop(endTime)
    }

    console.log('[PROFIT_SOUND] ✅ Cheerful bells played')
  } catch (error) {
    console.error('[PROFIT_SOUND] ❌ Failed:', error)
  }
}

// ============================================================================
// 4️⃣ ORDER FILLED (Pending Entry Filled) - C5→E5 (velká tercie)
// ============================================================================

/**
 * Order Filled Sound - dvě vzestupné noty při naplnění limit orderu
 * 
 * Muzikální teorie: C5 (523Hz) → E5 (659Hz) = velká tercie (optimistický interval)
 * Délka: ~400ms
 * Peak Volume: 0.4 (40%)
 * 
 * Trigger: Limit order zmizí z buyLimitOrders array (zatím neimplementováno)
 */
export function playOrderFilledSound(): void {
  if (!soundEnabled) return

  try {
    console.log('[ORDER_FILLED_SOUND] 🔔 Playing success sound...')

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextClass) {
      console.error('[ORDER_FILLED_SOUND] ❌ AudioContext not supported')
      return
    }

    const audioContext = new AudioContextClass()
    const now = audioContext.currentTime

    // Two ascending notes (C5 -> E5)
    const frequencies = [523, 659]

    for (let i = 0; i < frequencies.length; i++) {
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)

      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequencies[i], now + i * 0.1)

      // ADSR Envelope
      const startTime = now + i * 0.1
      const endTime = startTime + 0.3

      gainNode.gain.setValueAtTime(0, startTime)
      gainNode.gain.linearRampToValueAtTime(0.4, startTime + 0.01) // Attack 10ms
      gainNode.gain.exponentialRampToValueAtTime(0.01, endTime) // Decay 300ms

      oscillator.start(startTime)
      oscillator.stop(endTime)
    }

    console.log('[ORDER_FILLED_SOUND] ✅ Success sound played')
  } catch (error) {
    console.error('[ORDER_FILLED_SOUND] ❌ Failed:', error)
  }
}

// ============================================================================
// EXPORT SUMMARY
// ============================================================================

/**
 * Exported functions:
 * - getSoundEnabled() - zjistí aktuální stav zvuků
 * - setSoundEnabled(enabled) - zapne/vypne zvuky s localStorage persistence
 * - playPriceAlertSound() - price alert zvonky (E6-G6-B6)
 * - playPositionOpenSound() - beep při otevření pozice
 * - playProfitCloseSound() - veselá melodie při zavření v zisku
 * - playOrderFilledSound() - dva tóny při naplnění orderu
 */

