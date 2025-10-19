import crypto from 'node:crypto'

// AI event types broadcasted to dev tools
export type AiAssistantKey = 
  | 'entry_strategy_conservative' 
  | 'entry_strategy_aggressive' 
  | 'entry_risk_manager' 
  | 'strategy_updater' 
  | 'hot_screener' 
  | 'reactive_entry_assistant'
  | 'ai_profit_taker'

export type AiRawEvent = {
  id: string
  ts: string
  assistantKey: AiAssistantKey
  symbol?: string | null
  raw_request?: any | null
  raw_response?: any | null
}

export type AiEventPartial = {
  id?: string
  ts?: string
  symbol?: string | null
  raw_request?: any | null
  raw_response?: any | null
}

type Listener = (event: AiRawEvent) => void

/**
 * AiTap - Publisher-Subscriber system for AI event broadcasting
 * 
 * Usage:
 * - Publishers: AI service functions (entry_strategy_gpt.ts, etc.)
 * - Subscribers: SSE endpoints (/dev/ai-stream/*)
 * - Thread-safe emit/subscribe with automatic cleanup
 */
class AiTap {
  private listeners: Record<string, Set<Listener>> = {}

  /**
   * Subscribe to AI events for a specific assistant
   * Returns unsubscribe function
   */
  subscribe(assistantKey: AiAssistantKey, listener: Listener): () => void {
    if (!this.listeners[assistantKey]) {
      this.listeners[assistantKey] = new Set()
    }
    
    this.listeners[assistantKey].add(listener)
    
    // Return cleanup function
    return () => {
      try {
        if (this.listeners[assistantKey]) {
          this.listeners[assistantKey].delete(listener)
        }
      } catch {}
    }
  }

  /**
   * Emit AI event to all subscribers
   * Automatically fills in missing id/ts fields
   */
  emit(assistantKey: AiAssistantKey, event: AiEventPartial): void {
    const set = this.listeners[assistantKey]
    if (!set || set.size === 0) return
    
    // Build full event with defaults
    const full: AiRawEvent = {
      id: event.id || crypto.randomUUID(),
      ts: event.ts || new Date().toISOString(),
      assistantKey,
      symbol: event.symbol ?? null,
      raw_request: event.raw_request ?? null,
      raw_response: event.raw_response ?? null
    }
    
    // Broadcast to all listeners (safe iteration)
    for (const listener of Array.from(set)) {
      try {
        listener(full)
      } catch (err) {
        // Silent fail - don't let listener errors break AI services
        try {
          console.error('[AI_TAP_LISTENER_ERROR]', { assistantKey, error: String(err) })
        } catch {}
      }
    }
  }

  /**
   * Get current subscriber count for debugging
   */
  getSubscriberCount(assistantKey: AiAssistantKey): number {
    return this.listeners[assistantKey]?.size || 0
  }

  /**
   * Get total subscribers across all assistants
   */
  getTotalSubscribers(): number {
    return Object.values(this.listeners).reduce((sum, set) => sum + set.size, 0)
  }
}

// Singleton instance
export const aiTap = new AiTap()

