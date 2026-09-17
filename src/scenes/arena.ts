import type { GameContext, Scene } from '../scene'
import { BODY, DEFAULTS, SIM } from '../game/config'
import { Ragdoll } from '../game/ragdoll'

/* ------------------------------------------------------------------ *
 *  Screen / field geometry
 * ------------------------------------------------------------------ */
const VIEW_W = 320
const VIEW_H = 180

/** Field height = width * 3/8: 3 screens wide, 2 screens tall. */
const FIELD_RATIO = 3 / 8

const CELL_MIN = 30
const THRUST_MIN = 50

/* ------------------------------------------------------------------ *
 *  Settings (mirrored in the admin panel)
 * ------------------------------------------------------------------ */
export interface GameSettings {
  thrust: number // px/s^2 applied at the head
  gravity: number // px/s^2, low by default ("moon" feel)
  autoPilot: boolean // demo controller flies the ragdoll on its own
  colorSpeed: number // how fast the background colours flow (0 = static)
  fieldScreens: number // field width in "screens" (320 px each)
  cell: number // background lattice spacing (world px, horizontal)
  showGrid: boolean // render the 3D lattice
  profiler: boolean // show frame timings in the HUD
  bodyScale: number // size of the character (skeleton scale)
  showSkeleton: boolean // paint the circles over the body (tuning view)
  elasticity: number // how rubbery the frame is (1 = the tuned default)
  stance: number // 0..1: how hard the muscles hold the stance
  jointGrip: number // 0..1: how hard the joints hold their angle
}

export const defaultSettings = (): GameSettings => ({
  thrust: DEFAULTS.thrust,
  gravity: DEFAULTS.gravity,
  autoPilot: false, // the demo flies him; off by default, so no input = he falls
  colorSpeed: 1,
  fieldScreens: 3,
  cell: 120,
  showGrid: true,
  profiler: false,
  bodyScale: BODY.scale,
  showSkeleton: true,
  elasticity: 1,
  stance: 0, // pure, universal ragdoll physics; the muscles are an experiment (see docs/VISION.md)
  jointGrip: 0.25, // 0 = springs only (floppy); 1 = joints hold, the frame stands
})

/* ------------------------------------------------------------------ *
 *  3D space behind the arena ("looking through a hole in a sheet")
 *
 *  KS are the depth levels, given by their screen scale k (1 = the arena
 *  plane itself, smaller = deeper).  Every level draws full-window
 *  transverse lines (vertical + horizontal); they get thinner and dimmer
 *  with depth.  Levels are drawn near -> far and a line that would land
 *  within DEDUPE_PX of an already drawn one is skipped, so stacked levels
 *  never add up into a brighter line.
 *
 *  "Rails" are the lines running away from the viewer: they start at the
 *  lattice nodes near the camera and converge toward the far level, with a
 *  distance fade so they slide in and out instead of popping.
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

/* --- the ragdoll's look ------------------------------------------- *
 *  The skeleton is a chain of circles (see ragdoll.ts). What is drawn on
 *  top of it is deliberately dumb: a capsule between every pair of linked
 *  circles plus the circles themselves. The capsule fills the gap and the
 *  joint, so a chain of circles reads as one smooth oval limb instead of
 *  beads - exactly what the original does with its rectangles.
 *
 *  While the frame is being tuned, the circles are painted in their own
 *  colour on top (settings.showSkeleton), so it is obvious where the
 *  skeleton is and where the drawn body merely covers it.
 * ------------------------------------------------------------------ */
const BODY_COLOR = BODY.color
/** Colour of the circles when the skeleton is shown (testing view). */
const SKELETON_COLOR = '#9aa4ad'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const hsla = (h: number, s: number, l: number, a: number) =>
  `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a.toFixed(3)})`

/** True if `v` is closer than DEDUPE_PX to any value already in `list`. */
const tooClose = (list: number[], v: number): boolean => {
  for (const e of list) if (Math.abs(e - v) < DEDUPE_PX) return true
  return false
}

export class ArenaScene implements Scene {
  private settings: GameSettings

  /** The player character (stage 1: a single ragdoll). */
  ragdoll: Ragdoll

  /* Derived from settings by syncSettings() (called from the constructor). */
  worldW!: number
  worldH!: number
  private cellX!: number // horizontal lattice spacing (world px)
  private cellY!: number // vertical lattice spacing (cellX * 3/4)

  /* Camera follows the ragdoll's head; public so tests can read it. */
  camX = 0
  camY = 0

  private colorTime = 0 // drives the colour flow (settings.colorSpeed scales dt)
  private simTime = 0 // accumulated simulated time (deterministic)
  private simAcc = 0 // fixed-step accumulator
  private fps = 60
  private fpsAcc = 0
  private fpsFrames = 0

  /* Frame timings for the HUD profiler (exponential moving averages). */
  private updMs = 0
  private drawMs = 0
  private frameMs = 0
  private frameStart = 0

  /* Reused scratch lists: screen positions already painted this frame. */
  private readonly drawnV: number[] = []
  private readonly drawnH: number[] = []
  /** Body scale the current ragdoll was built with (see buildBody). */
  private builtScale = 0
  /** Elasticity the current ragdoll was last told about. */
  private builtElasticity = 0
  /** Joint grip last handed to the ragdoll. */
  private builtGrip = -1

  constructor(settings: GameSettings) {
    this.settings = settings
    this.syncSettings()

    // spawn in the middle of the field, upright
    this.ragdoll = this.buildBody()
    this.camX = this.ragdoll.head.x - VIEW_W / 2
    this.camY = this.ragdoll.head.y - VIEW_H / 2
  }

  /** Respawn the character in the middle of the field (fresh, at rest). */
  respawn(): void {
    this.ragdoll = this.buildBody()
    this.simAcc = 0
    this.camX = this.ragdoll.head.x - VIEW_W / 2
    this.camY = this.ragdoll.head.y - VIEW_H / 2
  }

  /** A fresh body in the middle of the field, with the current body scale. */
  private buildBody(): Ragdoll {
    this.builtScale = this.settings.bodyScale
    this.builtElasticity = this.settings.elasticity
    const body = new Ragdoll(this.worldW / 2, this.worldH / 2, this.settings.bodyScale)
    body.setElasticity(this.settings.elasticity)
    body.setJointGrip(this.settings.jointGrip)
    this.builtGrip = this.settings.jointGrip
    return body
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
    // the body scale is geometry, not a live parameter: rebuild the ragdoll
    if (this.builtScale !== this.settings.bodyScale) this.respawn()
    // the elasticity is live: dragging the slider is felt at once
    if (this.builtElasticity !== this.settings.elasticity) {
      this.builtElasticity = this.settings.elasticity
      this.ragdoll.setElasticity(this.settings.elasticity)
    }
    // the grip is live as well: drag it and watch the frame stop sagging
    if (this.builtGrip !== this.settings.jointGrip) {
      this.builtGrip = this.settings.jointGrip
      this.ragdoll.setJointGrip(this.settings.jointGrip)
    }
    this.colorTime += dt * this.settings.colorSpeed

    // fps (smoothed over ~0.5 s)
    this.fpsAcc += dt
    this.fpsFrames++
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc
      this.fpsAcc = 0
      this.fpsFrames = 0
    }

    // --- the only thing a player controls: the thrust vector -------------
    const thrust = Math.max(THRUST_MIN, this.settings.thrust)
    const ax = game.input.axis('ArrowLeft', 'ArrowRight')
    const ay = game.input.axis('ArrowUp', 'ArrowDown')
    let tx = 0
    let ty = 0

    if (ax !== 0 || ay !== 0) {
      const len = Math.hypot(ax, ay) || 1
      tx = (ax / len) * thrust
      ty = (ay / len) * thrust
    } else if (this.settings.autoPilot) {
      const target = this.autoPilotTarget()
      const head = this.ragdoll.head
      const dx = target.x - head.x
      const dy = target.y - head.y
      const len = Math.hypot(dx, dy) || 1
      tx = (dx / len) * thrust
      ty = (dy / len) * thrust
    }

    // --- fixed-step simulation (independent of the frame rate) -----------
    this.simAcc += dt
    let steps = 0
    while (this.simAcc >= SIM.dt && steps < SIM.maxStepsPerFrame) {
      this.ragdoll.step(
        SIM.dt,
        { thrustX: tx, thrustY: ty, gravity: this.settings.gravity, stance: this.settings.stance },
        { w: this.worldW, h: this.worldH },
      )
      this.simAcc -= SIM.dt
      this.simTime += SIM.dt
      steps++
    }
    if (steps >= SIM.maxStepsPerFrame) this.simAcc = 0 // drop the backlog

    // --- camera on the head ---------------------------------------------
    this.camX = this.ragdoll.head.x - VIEW_W / 2
    this.camY = this.ragdoll.head.y - VIEW_H / 2
  }

  /** Deterministic wander target for the demo autopilot. */
  private autoPilotTarget(): { x: number; y: number } {
    const t = this.simTime
    return {
      x: this.worldW / 2 + Math.cos(t * 0.37) * this.worldW * 0.3,
      y: this.worldH / 2 + Math.sin(t * 0.53) * this.worldH * 0.3,
    }
  }

  render({ ctx }: GameContext): void {
    const t0 = performance.now()

    ctx.fillStyle = '#01030a'
    ctx.fillRect(0, 0, VIEW_W, VIEW_H)

    if (this.settings.showGrid) this.renderSpace(ctx)
    this.renderField(ctx)
    this.renderRagdoll(ctx)

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
    ctx.fillText('стрелки — тяга', 6, VIEW_H - 8)
  }

  /* ------------------------------------------------------------------ *
   *  The ragdoll itself
   * ------------------------------------------------------------------ */
  private renderRagdoll(ctx: CanvasRenderingContext2D): void {
    const r = this.ragdoll

    ctx.save()
    ctx.translate(-this.camX, -this.camY)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // 1. the "rectangles" that hide the circles: one capsule per link. The
    //    capsule stops at the edge of any circle that is wider than itself,
    //    so it can never bulge out of the head and turn it into an oval.
    ctx.strokeStyle = BODY_COLOR
    ctx.fillStyle = BODY_COLOR
    for (const link of r.drawn) {
      const p1 = r.points[link.a]
      const p2 = r.points[link.b]
      const half = link.width / 2
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      if (d < 1e-6) continue
      const ux = (p2.x - p1.x) / d
      const uy = (p2.y - p1.y) / d
      const cut1 = p1.r > half + 0.01 ? p1.r : 0
      const cut2 = p2.r > half + 0.01 ? p2.r : 0
      if (cut1 + cut2 >= d) continue

      ctx.lineWidth = link.width
      ctx.beginPath()
      ctx.moveTo(p1.x + ux * cut1, p1.y + uy * cut1)
      ctx.lineTo(p2.x - ux * cut2, p2.y - uy * cut2)
      ctx.stroke()
    }

    // 2. the circles: round ends, a round head, and (while tuning) the
    //    skeleton itself in a colour of its own
    ctx.fillStyle = this.settings.showSkeleton ? SKELETON_COLOR : BODY_COLOR
    for (const p of r.points) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
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
   *  Arena plane: glass "hole" + opaque wall (sheet) + frame
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
