import { Input } from './input'
import type { GameContext, Scene } from './scene'

export interface EngineOptions {
  /** Virtual resolution; the canvas is scaled to fit the window. */
  width?: number
  height?: number
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

  constructor(canvas: HTMLCanvasElement, scene: Scene, options: EngineOptions = {}) {
    this.canvas = canvas
    this.width = options.width ?? 320
    this.height = options.height ?? 180
    this.scene = scene

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context not supported')
    this.ctx = ctx

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  /** Scale canvas to fill the window while preserving aspect ratio. */
  private resize() {
    const scale = Math.min(
      window.innerWidth / this.width,
      window.innerHeight / this.height,
    )
    this.canvas.width = this.width
    this.canvas.height = this.height
    this.canvas.style.width = `${this.width * scale}px`
    this.canvas.style.height = `${this.height * scale}px`
    this.canvas.style.margin = 'auto'
    this.canvas.style.position = 'absolute'
    this.canvas.style.inset = '0'
    this.ctx.imageSmoothingEnabled = false
  }

  private context(): GameContext {
    return { ctx: this.ctx, input: this.input, width: this.width, height: this.height }
  }

  private frame = (time: number) => {
    const dt = Math.min((time - this.lastTime) / 1000, 0.1) // clamp tab-switch spikes
    this.lastTime = time

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
