// Hybrid logical clock for last-writer-wins metadata sync.
// A timestamp is "<ms, 15 digits>:<counter, 6 digits>:<node>" (zero-padded decimal, so SQL can build one too),
// and plain string comparison orders them:
// by wall time, then by counter for events in the same millisecond, then by node to break exact ties.

export class Hlc {
  private ms = 0
  private counter = 0
  private readonly node: string
  private readonly now: () => number

  constructor(node: string, now: () => number = Date.now) {
    this.node = node
    this.now = now
  }

  /** A new timestamp, later than every timestamp this clock has issued or seen. */
  tick(): string {
    const t = this.now()
    if (t > this.ms) {
      this.ms = t
      this.counter = 0
    } else {
      this.counter++
    }
    return Hlc.format(this.ms, this.counter, this.node)
  }

  /** Moves the clock past `ts` (one received from elsewhere, or the newest stored one). */
  observe(ts: string): void {
    const parsed = Hlc.parse(ts)
    if (!parsed) return
    if (parsed.ms > this.ms || (parsed.ms === this.ms && parsed.counter > this.counter)) {
      this.ms = parsed.ms
      this.counter = parsed.counter
    }
  }

  /** A timestamp for an existing value, from its last-modified time (counter 0). */
  static at(ms: number, node: string): string {
    return Hlc.format(ms, 0, node)
  }

  static format(ms: number, counter: number, node: string): string {
    return `${String(ms).padStart(15, '0')}:${String(counter).padStart(6, '0')}:${node}`
  }

  static parse(ts: string): { ms: number; counter: number } | null {
    const [ms, counter] = ts.split(':')
    const m = parseInt(ms, 10)
    const c = parseInt(counter, 10)
    return Number.isFinite(m) && Number.isFinite(c) ? { ms: m, counter: c } : null
  }
}
