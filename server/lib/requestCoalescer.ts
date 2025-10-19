// Request Coalescer - merges duplicate in-flight requests
// If multiple calls to the same endpoint happen simultaneously,
// only one actual API call is made and all callers get the same result

type PendingRequest<T> = Promise<T>

type CoalescerStats = {
  unique: number      // Unique API calls made
  coalesced: number   // Requests that were merged
  total: number       // Total requests received
  saveRate: number    // Percentage of saved requests
  pending: number     // Currently pending requests
}

export class RequestCoalescer {
  private pending = new Map<string, PendingRequest<any>>()
  private stats = {
    unique: 0,
    coalesced: 0
  }

  // Fetch with coalescing - if a request is already in-flight, wait for it
  async fetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    // Check if this request is already pending
    if (this.pending.has(key)) {
      console.log(`[COALESCE_HIT] Key: ${key}`)
      this.stats.coalesced++
      return this.pending.get(key)! as Promise<T>
    }

    // Start a new request
    this.stats.unique++
    const promise = fetcher().finally(() => {
      // Cleanup after completion
      this.pending.delete(key)
    })

    this.pending.set(key, promise)
    return promise
  }

  // Get coalescer statistics
  getStats(): CoalescerStats {
    const total = this.stats.unique + this.stats.coalesced
    const saveRate = total > 0 ? (this.stats.coalesced / total) * 100 : 0

    return {
      unique: this.stats.unique,
      coalesced: this.stats.coalesced,
      total,
      saveRate: Math.round(saveRate * 10) / 10,
      pending: this.pending.size
    }
  }

  // Reset statistics
  resetStats(): void {
    this.stats = { unique: 0, coalesced: 0 }
  }

  // Get current pending requests count
  getPendingCount(): number {
    return this.pending.size
  }

  // Clear all pending (for testing/debugging only)
  clear(): void {
    this.pending.clear()
  }
}

// Global singleton instance
export const requestCoalescer = new RequestCoalescer()

