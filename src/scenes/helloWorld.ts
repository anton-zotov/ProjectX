import type { GameContext, Scene } from '../scene'

const SPEED = 60 // pixels per second

export class HelloWorldScene implements Scene {
  private x = 0
  private y = 0
  private vx = SPEED
  private vy = SPEED * 0.7
  private hue = 0

  update(dt: number, game: GameContext): void {
    // Move with arrow keys, otherwise bounce around on its own.
    const ax = game.input.axis('ArrowLeft', 'ArrowRight')
    const ay = game.input.axis('ArrowUp', 'ArrowDown')

    if (ax !== 0 || ay !== 0) {
      this.x += ax * SPEED * dt
      this.y += ay * SPEED * dt
      this.vx = SPEED
      this.vy = SPEED * 0.7
    } else {
      this.x += this.vx * dt
      this.y += this.vy * dt
    }

    const w = 80
    const h = 12
    if (this.x < 0 || this.x + w > game.width) {
      this.vx *= -1
      this.x = Math.max(0, Math.min(this.x, game.width - w))
    }
    if (this.y < h || this.y > game.height) {
      this.vy *= -1
      this.y = Math.max(h, Math.min(this.y, game.height))
    }

    this.hue = (this.hue + dt * 60) % 360
  }

  render({ ctx, width, height }: GameContext): void {
    ctx.fillStyle = '#0d0f14'
    ctx.fillRect(0, 0, width, height)

    ctx.font = '10px monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = `hsl(${this.hue}, 90%, 65%)`
    ctx.fillText('Hello, World!', this.x, this.y - 5)

    ctx.fillStyle = '#556'
    ctx.font = '6px monospace'
    ctx.fillText('arrow keys to move', 8, height - 10)
  }
}
