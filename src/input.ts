export class Input {
  private keys = new Set<string>()

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => this.keys.add(e.code))
    target.addEventListener('keyup', (e) => this.keys.delete(e.code))
    target.addEventListener('blur', () => this.keys.clear())
  }

  isDown(code: string): boolean {
    return this.keys.has(code)
  }

  /** Normalized -1..1 axis from two key pairs (e.g. ArrowLeft/ArrowRight). */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0)
  }
}
