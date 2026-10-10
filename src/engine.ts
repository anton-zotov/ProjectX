import { Input } from './input'
import type { GameContext, Scene } from './scene'

export interface EngineOptions {
  /** Virtual resolution; the canvas is scaled to fit the window. */
  width?: number
  height?: number
  /**
   * Internal render scale: 2 renders a 2x buffer (smoother lines),
   * 1 renders at the virtual resolution (fastest, least GPU work).
   */
  bufferScale?: number
}

export class Engine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private input = new Input()
  private scene: Scene
  private lastTime = 0
  private rafId = 0

  readonly width: number
  readonly height: number

  /** Internal render scale; see EngineOptions.bufferScale. */
  private bufferScale: number

  constructor(canvas: HTMLCanvasElement, scene: Scene, options: EngineOptions = {}) {
    this.canvas = canvas
    this.width = options.width ?? 320
    this.height = options.height ?? 180
    this.bufferScale = Math.max(1, Math.floor(options.bufferScale ?? 2))
    this.scene = scene

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context not supported')
    this.ctx = ctx

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  /** Switch the internal render scale at runtime (1 = fastest, 2 = smoother). */
  setBufferScale(scale: number): void {
    const next = Math.max(1, Math.floor(scale))
    if (next === this.bufferScale) return
    this.bufferScale = next
    this.resize()
  }

  /** Scale canvas to fill the window while preserving aspect ratio. */
  private resize() {
    const scale = Math.min(
      window.innerWidth / this.width,
      window.innerHeight / this.height,
    )
    this.canvas.width = this.width * this.bufferScale
    this.canvas.height = this.height * this.bufferScale
    this.canvas.style.width = `${this.width * scale}px`
    this.canvas.style.height = `${this.height * scale}px`
    this.canvas.style.margin = 'auto'
    this.canvas.style.position = 'absolute'
    this.canvas.style.inset = '0'
  }

  private context(): GameContext {
    return { ctx: this.ctx, input: this.input, width: this.width, height: this.height }
  }

  private frame = (time: number) => {
    const dt = Math.min((time - this.lastTime) / 1000, 0.1) // clamp tab-switch spikes
    this.lastTime = time

    this.ctx.setTransform(this.bufferScale, 0, 0, this.bufferScale, 0, 0)
    this.scene.update(dt, this.context())
    this.scene.render(this.context())

    this.rafId = requestAnimationFrame(this.frame)
  }

  start() {
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.frame)
  }

  stop() {
    cancelAnimationFrame(this.rafId)
  }

  setScene(scene: Scene) {
    this.scene = scene
  }
}
