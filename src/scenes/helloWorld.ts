import type { GameContext, Scene } from '../scene'

/* ------------------------------------------------------------------ *
 *  Screen / field geometry
 * ------------------------------------------------------------------ */
const VIEW_W = 320
const VIEW_H = 180

/** Field height = width * 3/8: 3 screens wide, 2 screens tall. */
const FIELD_RATIO = 3 / 8

/** Label collision box (world px). */
const LABEL_W = 80
const LABEL_H = 12

const SPEED_DEFAULT = 120 // world px/s
const SPEED_MIN = 10
const CELL_MIN = 30

/* ------------------------------------------------------------------ *
 *  Settings (mirrored in the admin panel)
 * ------------------------------------------------------------------ */
export interface GameSettings {
  speed: number // label speed while steering / auto-moving, world px/s
  autoMove: boolean // label drifts/bounces on its own when no arrows
  colorSpeed: number // how fast colours flow (0 = static)
  fieldScreens: number // field width in "screens" (320 px each)
  cell: number // background lattice spacing (world px, horizontal)
  showGrid: boolean // render the 3D lattice
  profiler: boolean // show frame timings in the HUD (diagnostics)
}

export const defaultSettings = (): GameSettings => ({
  speed: SPEED_DEFAULT,
  autoMove: false,
  colorSpeed: 1,
  fieldScreens: 3,
  cell: 120,
  showGrid: true,
  profiler: false,
})

/* ------------------------------------------------------------------ *
 *  3D space behind the arena ("looking through a hole in a sheet")
 *
 *  KS are the depth levels, given by their screen scale k (1 = the arena
 *  plane itself, smaller = deeper).  Every level draws full-window
 *  transverse lines (vertical + horizontal); they get thinner and dimmer
 *  with depth.  Levels are drawn near -> far and a line that would land
 *  within DEDUPE_PX of an already drawn one is skipped, so stacked
 *  levels never add up into a brighter line.
 *
 *  "Rails" are the lines running away from the viewer: they start at the
 *  lattice nodes near the camera and converge toward the far level, with
 *  a distance fade so they slide in and out instead of popping.
 * ------------------------------------------------------------------ */
const KS = [0.92, 0.8, 0.67, 0.54, 0.41, 0.3, 0.2, 0.12, 0.07]
const K0 = KS[0]
const KFAR = KS[KS.length - 1]

const DEDUPE_PX = 1.3 // min screen distance between two transverse lines
const EDGE_MARGIN = 8 // extra px around the viewport when collecting lines
const RAIL_BAND = 560 // px: how far off-screen rails are still enumerated
const RAIL_FADE_END = 540 // px outside the edge where a rail is fully faded
const RAIL_FADE_SPAN = 440 // px over which a rail fades out
const RAIL_FADE_MIN = 0.03 // below this a rail is skipped entirely
const RAIL_MIN_DIST = 28 // world px from the camera below which rails degenerate

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const hsla = (h: number, s: number, l: number, a: number) =>
  `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a.toFixed(3)})`

/** True if `v` is closer than DEDUPE_PX to any value already in `list`. */
const tooClose = (list: number[], v: number): boolean => {
  for (const e of list) if (Math.abs(e - v) < DEDUPE_PX) return true
  return false
}

export class HelloWorldScene implements Scene {
  private settings: GameSettings

  private x: number
  private y: number
  private vx: number
  private vy: number

  /* Derived from settings by syncSettings() (called from the constructor). */
  private worldW!: number
  private worldH!: number
  private cellX!: number // horizontal lattice spacing (world px)
  private cellY!: number // vertical lattice spacing (cellX * 3/4)

  private colorTime = 0 // drives the colour flow (settings.colorSpeed scales dt)
  private fps = 60
  private fpsAcc = 0
  private fpsFrames = 0

  /* Frame timings for the HUD profiler (exponential moving averages). */
  private updMs = 0
  private drawMs = 0
  private frameMs = 0
  private frameStart = 0

  /* Free camera, centred on the label (may look beyond the field edges). */
  private camX = 0
  private camY = 0

  /* Reused scratch lists: screen positions already painted this frame. */
  private readonly drawnV: number[] = []
  private readonly drawnH: number[] = []

  constructor(settings: GameSettings) {
    this.settings = settings
    this.syncSettings()

    this.x = this.worldW / 2
    this.y = this.worldH / 2

    const speed = Math.max(SPEED_MIN, settings.speed)
    this.vx = speed
    this.vy = speed * 0.7
  }

  /** Pull the admin-panel settings into the derived geometry. */
  private syncSettings(): void {
    this.worldW = this.settings.fieldScreens * VIEW_W
    this.worldH = this.worldW * FIELD_RATIO
    this.cellX = Math.max(CELL_MIN, this.settings.cell)
    this.cellY = this.cellX * 0.75
  }

  /* --- cheap cloud-like colour: hues drift by themselves over time --- */
  private lineHue(wx: number, wy: number): number {
    const t = this.colorTime
    const u = wx * 0.0016 + t * 0.9
    const v = wy * 0.0024 - t * 0.62
    // smooth drifting waves -> n in ~[0,1]
    const n = 0.5 + 0.25 * (Math.sin(u) + Math.sin(v + 1.9))
    // the whole colour centre slowly travels around the wheel on its own
    const centre = (t * 26) % 360
    return (centre + n * 170) % 360
  }

  update(dt: number, game: GameContext): void {
    const t0 = performance.now()
    this.frameStart = t0
    this.step(dt, game)
    this.updMs = this.updMs * 0.9 + (performance.now() - t0) * 0.1
  }

  private step(dt: number, game: GameContext): void {
    this.syncSettings()
    this.colorTime += dt * this.settings.colorSpeed

    // fps (smoothed over ~0.5 s)
    this.fpsAcc += dt
    this.fpsFrames++
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc
      this.fpsAcc = 0
      this.fpsFrames = 0
    }

    const ax = game.input.axis('ArrowLeft', 'ArrowRight')
    const ay = game.input.axis('ArrowUp', 'ArrowDown')
    const speed = Math.max(SPEED_MIN, this.settings.speed)

    if (ax !== 0 || ay !== 0) {
      this.x += ax * speed * dt
      this.y += ay * speed * dt
      this.vx = speed
      this.vy = speed * 0.7
    } else if (this.settings.autoMove) {
      // auto-drift: keep the direction, follow the "speed" setting
      const dir = Math.hypot(this.vx, this.vy)
      if (dir > 0) {
        this.vx = (this.vx / dir) * speed
        this.vy = (this.vy / dir) * speed
      }
      this.x += this.vx * dt
      this.y += this.vy * dt
    }

    // keep the label inside the field (bounce when it steers into a wall)
    if (this.x < 0 || this.x + LABEL_W > this.worldW) {
      this.vx *= -1
      this.x = clamp(this.x, 0, this.worldW - LABEL_W)
    }
    if (this.y < LABEL_H || this.y > this.worldH) {
      this.vy *= -1
      this.y = clamp(this.y, LABEL_H, this.worldH)
    }

    this.camX = this.x - VIEW_W / 2
    this.camY = this.y - VIEW_H / 2
  }

  render({ ctx }: GameContext): void {
    const t0 = performance.now()

    ctx.fillStyle = '#01030a'
    ctx.fillRect(0, 0, VIEW_W, VIEW_H)

    if (this.settings.showGrid) this.renderSpace(ctx)
    this.renderField(ctx)

    this.drawMs = this.drawMs * 0.9 + (performance.now() - t0) * 0.1
    if (this.frameStart > 0) {
      const total = performance.now() - this.frameStart
      this.frameMs = this.frameMs * 0.9 + total * 0.1
    }

    // HUD: fps + frame time (top-left), optional breakdown, and the hint
    ctx.font = '6px monospace'
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(140,220,190,0.9)'
    ctx.fillText(`fps ${Math.round(this.fps)}  ${this.frameMs.toFixed(1)} ms`, 6, 6)
    if (this.settings.profiler) {
      ctx.fillStyle = 'rgba(120,190,220,0.9)'
      ctx.fillText(
        `upd ${this.updMs.toFixed(2)} ms · draw ${this.drawMs.toFixed(1)} ms`,
        6,
        15,
      )
    }
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(125,154,140,0.9)'
    ctx.fillText('arrow keys to move', 6, VIEW_H - 8)
  }

  /* ------------------------------------------------------------------ *
   *  The gridded 3D volume (additive glow)
   * ------------------------------------------------------------------ */
  private renderSpace(ctx: CanvasRenderingContext2D): void {
    const lx = this.camX
    const ly = this.camY
    const cx = VIEW_W / 2
    const cy = VIEW_H / 2
    const LX = this.cellX
    const LY = this.cellY

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'

    const drawnV = this.drawnV
    const drawnH = this.drawnH
    drawnV.length = 0
    drawnH.length = 0

    // --- transverse lines per depth level (near -> far) -----------------
    for (const k of KS) {
      const a = 0.055 + 0.15 * k // dim with depth
      const wm = 0.55 + 0.45 * k // thin with depth

      const m0 = Math.ceil((lx - (VIEW_W / 2 + EDGE_MARGIN) / k) / LX)
      const m1 = Math.floor((lx + (VIEW_W / 2 + EDGE_MARGIN) / k) / LX)
      for (let m = m0; m <= m1; m++) {
        const sx = cx + (m * LX - lx) * k
        if (sx < -6 || sx > VIEW_W + 6) continue
        if (tooClose(drawnV, sx)) continue
        drawnV.push(sx)
        const hue = this.lineHue(m * LX, ly)
        this.ln(ctx, sx, 0, sx, VIEW_H, hue, a, wm)
      }

      const n0 = Math.ceil((ly - (VIEW_H / 2 + EDGE_MARGIN) / k) / LY)
      const n1 = Math.floor((ly + (VIEW_H / 2 + EDGE_MARGIN) / k) / LY)
      for (let n = n0; n <= n1; n++) {
        const sy = cy + (n * LY - ly) * k
        if (sy < -6 || sy > VIEW_H + 6) continue
        if (tooClose(drawnH, sy)) continue
        drawnH.push(sy)
        const hue = this.lineHue(lx, n * LY)
        this.ln(ctx, 0, sy, VIEW_W, sy, hue, a, wm)
      }
    }

    // --- axial rails -----------------------------------------------------
    const bandX = Math.ceil((VIEW_W / 2 + RAIL_BAND) / K0 / LX) + 1
    const bandY = Math.ceil((VIEW_H / 2 + RAIL_BAND) / K0 / LY) + 1
    const m0 = Math.floor(lx / LX) - bandX
    const m1 = Math.floor(lx / LX) + bandX
    const n0 = Math.floor(ly / LY) - bandY
    const n1 = Math.floor(ly / LY) + bandY
    for (let m = m0; m <= m1; m++) {
      for (let n = n0; n <= n1; n++) {
        const ox = m * LX - lx
        const oy = n * LY - ly
        if (ox * ox + oy * oy < RAIL_MIN_DIST * RAIL_MIN_DIST) continue
        const x1 = cx + ox * K0
        const y1 = cy + oy * K0
        const x2 = cx + ox * KFAR
        const y2 = cy + oy * KFAR
        // how far the bright (near) end sits beyond the screen edge
        const off = Math.max(0, -x1, x1 - VIEW_W, -y1, y1 - VIEW_H)
        const fade = clamp((RAIL_FADE_END - off) / RAIL_FADE_SPAN, 0, 1)
        if (fade <= RAIL_FADE_MIN) continue

        const hue = this.lineHue(m * LX, n * LY)
        const g = ctx.createLinearGradient(x1, y1, x2, y2)
        g.addColorStop(0, hsla(hue, 100, 62, 0.16 * fade))
        g.addColorStop(0.65, hsla(hue, 100, 60, 0.06 * fade))
        g.addColorStop(1, hsla(hue, 100, 58, 0.01 * fade))
        ctx.strokeStyle = g
        ctx.lineWidth = 2.4
        this.seg(ctx, x1, y1, x2, y2)
        const gc = ctx.createLinearGradient(x1, y1, x2, y2)
        gc.addColorStop(0, hsla(hue, 100, 84, 0.42 * fade))
        gc.addColorStop(0.65, hsla(hue, 100, 82, 0.12 * fade))
        gc.addColorStop(1, hsla(hue, 100, 80, 0.02 * fade))
        ctx.strokeStyle = gc
        ctx.lineWidth = 0.85
        this.seg(ctx, x1, y1, x2, y2)
      }
    }

    ctx.restore()
  }

  /* ------------------------------------------------------------------ *
   *  Arena plane: glass "hole" + opaque wall (sheet) + frame + label
   * ------------------------------------------------------------------ */
  private renderField(ctx: CanvasRenderingContext2D): void {
    const { camX, camY } = this
    const w = this.worldW
    const h = this.worldH
    const LX = this.cellX
    const LY = this.cellY

    const frx0 = -camX
    const fry0 = -camY
    const frx1 = frx0 + w
    const fry1 = fry0 + h
    const ix0 = clamp(frx0, 0, VIEW_W)
    const iy0 = clamp(fry0, 0, VIEW_H)
    const ix1 = clamp(frx1, 0, VIEW_W)
    const iy1 = clamp(fry1, 0, VIEW_H)

    // --- the wall (paper sheet) outside the hole ---
    ctx.fillStyle = '#0d1520'
    ctx.fillRect(0, 0, VIEW_W, iy0)
    ctx.fillRect(0, iy1, VIEW_W, VIEW_H - iy1)
    ctx.fillRect(0, iy0, ix0, iy1 - iy0)
    ctx.fillRect(ix1, iy0, VIEW_W - ix1, iy1 - iy0)

    // faint wall lattice (skips the hole itself)
    ctx.strokeStyle = 'rgba(70,105,150,0.16)'
    ctx.lineWidth = 1
    for (let tx = 0; tx <= w; tx += LX) {
      const sx = frx0 + tx
      if (sx < 0 || sx > VIEW_W) continue
      if (sx > ix0 && sx < ix1) {
        if (iy0 > 0) this.seg(ctx, sx, 0, sx, iy0)
        if (iy1 < VIEW_H) this.seg(ctx, sx, iy1, sx, VIEW_H)
      } else {
        this.seg(ctx, sx, 0, sx, VIEW_H)
      }
    }
    for (let ty = 0; ty <= h; ty += LY) {
      const sy = fry0 + ty
      if (sy < 0 || sy > VIEW_H) continue
      if (sy > iy0 && sy < iy1) {
        if (ix0 > 0) this.seg(ctx, 0, sy, ix0, sy)
        if (ix1 < VIEW_W) this.seg(ctx, ix1, sy, VIEW_W, sy)
      } else {
        this.seg(ctx, 0, sy, VIEW_W, sy)
      }
    }

    // --- glass "hole" ---
    if (ix1 > ix0 && iy1 > iy0) {
      ctx.fillStyle = 'rgba(5,11,13,0.5)'
      ctx.fillRect(ix0, iy0, ix1 - ix0, iy1 - iy0)
    }

    // --- border frame, corner brackets, ticks ---
    ctx.save()
    ctx.translate(-camX, -camY)

    ctx.strokeStyle = 'rgba(210,235,255,0.9)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    const B = 22 // corner bracket length (world px)
    for (const [wx, wy, sx, sy] of [
      [0, 0, 1, 1],
      [w, 0, -1, 1],
      [0, h, 1, -1],
      [w, h, -1, -1],
    ] as const) {
      ctx.moveTo(wx + sx * B, wy)
      ctx.lineTo(wx, wy)
      ctx.lineTo(wx, wy + sy * B)
    }
    ctx.stroke()

    ctx.strokeStyle = 'rgba(190,230,252,0.8)'
    ctx.lineWidth = 2
    ctx.strokeRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(190,230,252,0.25)'
    ctx.lineWidth = 5
    ctx.strokeRect(0, 0, w, h)

    ctx.strokeStyle = 'rgba(190,230,252,0.55)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let tx = 0; tx <= w; tx += LX) {
      ctx.moveTo(tx, 0)
      ctx.lineTo(tx, 5)
      ctx.moveTo(tx, h)
      ctx.lineTo(tx, h - 5)
    }
    for (let ty = 0; ty <= h; ty += LY) {
      ctx.moveTo(0, ty)
      ctx.lineTo(5, ty)
      ctx.moveTo(w, ty)
      ctx.lineTo(w - 5, ty)
    }
    ctx.stroke()

    // --- the label ---
    const hue = this.lineHue(this.x, this.y)
    ctx.save()
    ctx.shadowColor = hsla(hue, 90, 55, 0.9)
    ctx.shadowBlur = 6
    ctx.font = '10px monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hsla(hue, 95, 90, 1)
    ctx.fillText('Hello, World!', this.x, this.y - 5)
    ctx.restore()

    ctx.restore()
  }

  /** One glowing line: soft wide pass + crisp bright core (two strokes). */
  private ln(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    hue: number,
    alpha: number,
    widthMul: number,
  ): void {
    ctx.strokeStyle = hsla(hue, 100, 62, alpha * 0.9)
    ctx.lineWidth = 2.4 * widthMul
    this.seg(ctx, x0, y0, x1, y1)
    ctx.strokeStyle = hsla(hue, 100, 84, Math.min(1, alpha * 2.6))
    ctx.lineWidth = 0.8 * widthMul
    this.seg(ctx, x0, y0, x1, y1)
  }

  /** Stroke a single straight segment with the current stroke style. */
  private seg(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void {
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
}
