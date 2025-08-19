export type Bar = {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export class RingBuffer {
  private buffer: Bar[] = []
  private capacity: number
  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
  }
  pushClosedBar(bar: Bar) {
    const last = this.buffer[this.buffer.length - 1]
    if (last && last.openTime === bar.openTime) {
      this.buffer[this.buffer.length - 1] = bar
    } else {
      this.buffer.push(bar)
      if (this.buffer.length > this.capacity) this.buffer.shift()
    }
  }
  lastN(n: number): Bar[] {
    const k = Math.max(0, this.buffer.length - n)
    return this.buffer.slice(k)
  }
  size(): number { return this.buffer.length }
  getAll(): Bar[] { return this.buffer.slice() }
  lastAgeMs(now = Date.now()): number | null {
    const last = this.buffer[this.buffer.length - 1]
    return last ? now - last.openTime : null
  }
}


