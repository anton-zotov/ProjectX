import { BODY, LIMITS, LINK, SIM, STAND, type BodyKind, type LinkKind, type ShapeKind } from './config'

/* ------------------------------------------------------------------ *
 *  Ragdoll ("чувачок")
 *
 *  A chain of circles per body section, joined by ELASTIC links: rubbery
 *  within limits, never rigid, and neighbouring circles never overlap. The
 *  player only controls a thrust vector, applied AT THE HEAD - the whole
 *  body therefore swings, stretches and tumbles on its own. That is the
 *  core of the original game.
 *
 *  Solver: Verlet integration + XPBD (Gauss-Seidel). XPBD is what makes the
 *  elasticity honest: compliance belongs to the link and is applied through
 *  the substep length, so the feel does not depend on the substep count or
 *  on the number of solver iterations. On top of the elastic pull every
 *  link has two HARD limits - circles may close up to the touching distance
 *  and may only stretch so far. That is the "rubbery, but within limits" of
 *  the original skeleton.
 * ------------------------------------------------------------------ */

export type PartId = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR'

export interface Circle {
  x: number
  y: number
  /** Previous position - Verlet keeps the velocity implicitly. */
  px: number
  py: number
  /** Inverse mass (0 = pinned). */
  im: number
  /** Radius: drawing and wall collisions. Grows with BODY.scale. */
  r: number
  part: PartId
}

export interface Link {
  a: number
  b: number
  /**
   * Third circle of an ANGLE link: the angle is measured at `b` between the
   * segments b->a and b->c. Undefined for distance links.
   */
  c?: number
  /** Rest length of the link. */
  rest: number
  /** Hard limits of that length. */
  min: number
  max: number
  /** Stretch allowance as a factor of rest; `max` is this times the current
   * elasticity, see `setElasticity`. */
  stretch: number
  /** Base fold limit of a shape spring; the elasticity deepens it. */
  fold?: number
  /**
   * True for the links that set an ANGLE (a brace or a limb's attitude
   * spring). Those are the joints, and they can hold their angle by grip.
   */
  joint?: boolean
  /** XPBD compliance (1 / stiffness) at elasticity 1; 0 = rigid. */
  complianceBase: number
  /** The compliance in force right now (softened by the elasticity). */
  compliance: number
  /** Iteration accumulator, reset every substep. */
  lambda: number
  /** Drawn as a capsule between the circles (false for hidden braces). */
  draw: boolean
  /** Width of that capsule, world px (0 for hidden braces). */
  width: number
  kind: LinkKind
}

export interface Bounds {
  w: number
  h: number
}

export interface StepInput {
  /** Thrust acceleration applied at the head, px/s^2. */
  thrustX: number
  thrustY: number
  /** Gravity acceleration applied to every circle, px/s^2. */
  gravity: number
  /**
   * How hard the muscles hold the stance, 0..1 (the admin slider). At 0 the
   * character is a pure ragdoll; at 1 he gets up and stays on his feet.
   */
  stance?: number
}

/**
 * One chain of circles: the circles' offsets in layout px (origin = centre
 * of the head circle), the radius of every circle of the chain, and the
 * circle of another chain the first one is tied to.
 */
interface Chain {
  part: PartId
  prefix: string
  radius: number
  at: ReadonlyArray<readonly [number, number]>
  attachTo?: string
  attachKind?: BodyKind
  /**
   * The body circle next to the one this limb hangs from (torso1 for the arms
   * whose shoulder is torso0, the one above the pelvis for the legs).
   * A second joint is needed there: one joint at the limb's first circle says
   * how the limb is aligned with the link, but the link itself could still
   * rotate all the way around the body circle. Two joints pin the attitude.
   */
  attachAlong?: string
}

const R = BODY.radius.body
const HEAD_R = BODY.radius.head

/**
 * A limb is a line of circles: `count` of them, marching from `start` by
 * `step`. Neighbours sit slightly further apart than touching distance, so the
 * links between them are springs with room to give (and to be squeezed back).
 */
const march = (
  start: readonly [number, number],
  step: readonly [number, number],
  count: number,
): ReadonlyArray<readonly [number, number]> =>
  Array.from(
    { length: count },
    (_, i) => [start[0] + step[0] * i, start[1] + step[1] * i] as const,
  )

/** Where a limb's first circle sits: touching the body circle, `angle` off it. */
const limbStart = (
  bodyY: number,
  angle: number,
  side: number,
  length: number,
): readonly [number, number] => [
  side * Math.sin(angle) * length,
  bodyY + Math.cos(angle) * length,
]

const TORSO_TOP = (HEAD_R + R) * (1 + LINK.give.head)
const TORSO_STEP = R * 2
/** How many circles the body has (the legs hang from the last one). */
const TORSO_COUNT = 5
const TORSO_BOTTOM = TORSO_TOP + TORSO_STEP * (TORSO_COUNT - 1)
/** The name of the last circle of the body: the pelvis the legs hang from. */
const PELVIS = `torso${TORSO_COUNT - 1}`
/** How far a limb's first circle sits from the body circle it hangs on. */
const ATTACH_REST = R * 2 * (1 + LINK.give.attach)
/**
 * Arms: out to the side at 40 degrees. The attach angle and the direction of
 * the chain are separate numbers on purpose - if they were the same, the two
 * legs (or the two arms) would run parallel right next to each other and read
 * as one thick sausage.
 */
const ARM_ATTACH_ANGLE = (45 * Math.PI) / 180
const ARM_ANGLE = (40 * Math.PI) / 180
const ARM_STEP = R * 2
/**
 * Legs: the hips sit wide out to the sides - the hip link is longer than the
 * touching distance - and since the circles push each other apart (see
 * `separate`), the legs stay two legs without any artificial gap at the pelvis.
 * They then go down almost vertically.
 */
const LEG_ATTACH_ANGLE = (36 * Math.PI) / 180
const LEG_ATTACH_LENGTH = ATTACH_REST
const LEG_ANGLE = (14 * Math.PI) / 180
const LEG_STEP = R * 2

const armChain = (side: number, part: PartId): Chain => ({
  part,
  prefix: part,
  radius: R,
  at: march(
    limbStart(TORSO_TOP, ARM_ATTACH_ANGLE, side, ATTACH_REST),
    [side * Math.sin(ARM_ANGLE) * ARM_STEP, Math.cos(ARM_ANGLE) * ARM_STEP],
    4,
  ),
  attachTo: 'torso0',
  attachKind: 'attach',
  attachAlong: 'torso1',
})

const legChain = (side: number, part: PartId): Chain => ({
  part,
  prefix: part,
  radius: R,
  at: march(
    limbStart(TORSO_BOTTOM, LEG_ATTACH_ANGLE, side, LEG_ATTACH_LENGTH),
    [side * Math.sin(LEG_ANGLE) * LEG_STEP, Math.cos(LEG_ANGLE) * LEG_STEP],
    5,
  ),
  attachTo: PELVIS,
  attachKind: 'attach',
  attachAlong: `torso${TORSO_COUNT - 2}`,
})

/**
 * The skeleton, straight from the original's description:
 * one head circle, a five-circle body, four circles per arm, five per leg -
 * and every circle of the frame has the SAME radius. A limb's length comes
 * from how many circles it has, nothing else.
 *
 *   torso0 is the neck AND the shoulders: both arms hang from the FIRST
 *   circle of the body, with the head sitting on top of it
 *   the arms point out to the sides (that is the pose they spring back to)
 *   the legs point down, slightly spread, and hang from the last body circle
 *
 * The numbers are layout px. Neighbouring circles never overlap, and the
 * drawing fills the gap between them with a capsule.
 */
const CHAINS: readonly Chain[] = [
  {
    part: 'head',
    prefix: 'head',
    radius: HEAD_R,
    at: [[0, 0]],
  },
  {
    part: 'torso',
    prefix: 'torso',
    radius: R,
    at: march([0, TORSO_TOP], [0, TORSO_STEP], TORSO_COUNT),
    attachTo: 'head',
    attachKind: 'head',
  },
  armChain(-1, 'armL'),
  armChain(1, 'armR'),
  legChain(-1, 'legL'),
  legChain(1, 'legR'),
]

/**
 * Where the player's thrust is applied. Not the head itself but the circle of
 * the neck just below it: the force then still has a lever arm over the centre
 * of mass (so the body tumbles when you push), without whipping the head
 * around on its neck spring.
 */
const FORCE_POINT = 'torso0'

/** Name of the i-th circle of a chain ('head' for a single-circle chain). */
const nameOf = (chain: Chain, i: number): string =>
  chain.at.length === 1 ? chain.prefix : `${chain.prefix}${i}`

/** Which link tuning a body section uses (the two arms share 'arm'). */
const linkKindOf = (part: PartId): BodyKind =>
  part === 'armL' || part === 'armR' ? 'arm' : part === 'legL' || part === 'legR' ? 'leg' : part

/** Every circle name, in layout order - useful for tests and tooling. */
export const POINT_NAMES: readonly string[] = CHAINS.flatMap((chain) =>
  chain.at.map((_, i) => nameOf(chain, i)),
)

/**
 * Diagnostics: set `DEBUG.angle` to a non-empty string and every angle solve
 * reports what it did. Used by the devtools scripts while tuning the joints.
 */
export const DEBUG: { angle: string; log: (message: string) => void } = {
  angle: '',
  log: () => {},
}

/** The sections of the body, in layout order. */
export const SECTION_NAMES: readonly PartId[] = CHAINS.map((chain) => chain.part)

/** How many circles each section has (the original's proportions). */
export const SECTION_SIZES: Readonly<Record<string, number>> = Object.fromEntries(
  CHAINS.map((chain) => [chain.part, chain.at.length] as const),
)

export class Ragdoll {
  readonly points: Circle[] = []
  /** Every link: chain links, attachments and hidden bend braces. */
  readonly links: Link[] = []
  /**
   * The links that get drawn: chain links and attachments. Bend braces stay
   * invisible - they only stop a chain from folding onto itself.
   */
  readonly drawn: Link[] = []
  /** Contiguous ranges of `points`, one per section. */
  readonly sections: Array<{ part: PartId; from: number; count: number }> = []
  private readonly index = new Map<string, number>()
  /**
   * Wall contacts of the current substep: circle index -> velocity at the
   * moment of the first contact, plus which axes hit. Filled by
   * `clampToWalls`, consumed by `bounce`.
   */
  private readonly hits = new Map<number, { vx: number; vy: number; x: boolean; y: boolean }>()
  /**
   * Pairs of circles that are not linked to each other and are close enough to
   * matter: they are pushed apart so that no two circles of the body ever
   * intersect (the two legs, a limb and the body, the head and the body).
   */
  private readonly contacts: Array<[number, number, boolean]> = []
  /**
   * How much harder the force point has to be pushed than the whole body, so
   * that the thrust setting means "the acceleration of the body".
   */
  private readonly pushScale: number
  /** Elasticity currently applied to the links (1 = as tuned in config). */
  private elasticity = 0
  /**
   * Joint grip in px per substep: how far a joint may be corrected at once.
   * Big enough and it simply holds its angle (a posed doll); small enough and
   * a hard hit slips through it. 0 turns every joint back into a spring.
   */
  private grip = 0
  /** Rest pose of every circle, in the body's own frame (origin = torso0). */
  private readonly poseX: number[] = []
  private readonly poseY: number[] = []

  constructor(x: number, y: number, scale: number = BODY.scale) {
    for (const chain of CHAINS) {
      const from = this.points.length
      // mass comes from the layout radius, so changing BODY.scale (a look
      // setting) does not silently turn the character into a different body
      const mass = chain.radius * chain.radius * BODY.density

      chain.at.forEach(([lx, ly], i) => {
        const cx = x + lx * scale
        const cy = y + ly * scale
        this.index.set(nameOf(chain, i), this.points.length)
        this.points.push({
          x: cx,
          y: cy,
          px: cx,
          py: cy,
          im: 1 / mass,
          r: chain.radius * scale,
          part: chain.part,
        })
      })

      this.sections.push({ part: chain.part, from, count: chain.at.length })

      // chain links: neighbouring circles, elastic, never overlapping
      for (let i = 1; i < chain.at.length; i++) {
        this.addLink(from + i - 1, from + i, linkKindOf(chain.part), true)
      }

      // braces inside the chain: circles i-2 and i are pulled back to the
      // distance they have at rest, so a chain that gets bent springs straight
      // again. `LIMITS.bend` is an angle; the brace works on distances, so the
      // allowed shortening is cos(bend/2).
      const limb = linkKindOf(chain.part)
      const fold = Math.cos(LIMITS.bend[limb] / 2)
      for (let i = 2; i < chain.at.length; i++) {
        this.addBrace(from + i - 2, from + i, fold, 'brace')
      }
      // and one from end to end, so a limb cannot bow out sideways while every
      // individual link happens to sit at its rest length
      if (chain.at.length >= 4) {
        this.addBrace(from, from + chain.at.length - 1, fold, 'brace')
      }

      // how the first circle of this chain hangs on the rest of the body.
      if (chain.attachTo) {
        const parent = this.indexOf(chain.attachTo)
        this.addLink(parent, from, chain.attachKind ?? 'attach', true, true)
        // Springs that give the limb its attitude. Two links to the SAME body
        // circle fix how far along the limb they reach, and a third one from
        // the neighbouring body circle fixes which way it points. One alone
        // would let the limb swing right around its joint and turn inside out.
        const parentPart = linkKindOf(this.points[parent].part)
        const swing = Math.max(LIMITS.swing[parentPart], LIMITS.swing[limb])
        if (swing > 0 && chain.at.length > 1) {
          this.addBrace(parent, from + 1, Math.cos(swing / 2), 'pose')
          if (chain.attachAlong) {
            // The third link is what makes the attitude unique. Two links have
            // a mirror solution (the limb turned inside out) in which every
            // length is the same again - the springs would see nothing wrong
            // and leave it there. This one cannot be short enough in that
            // solution, so the limb cannot get there at all.
            this.addBrace(this.indexOf(chain.attachAlong), from, 0.45, 'pose', 1.5)
          }
        }
        // The head is not a limb: it must not be able to spin all the way
        // round on the neck. A second, tight link to the NEXT circle of the
        // body turns that free hinge into a neck - it can nod and shake a
        // little and no more (measured: a 120 degree turn is impossible).
        if (parentPart === 'head' && chain.at.length > 1) {
          this.addBrace(from + 1, parent, LIMITS.neckFold, 'brace', LIMITS.neckGrow)
        }
      }
    }

    // The target skeleton: where every circle sits in the rest pose, measured
    // upright from the body's centre of mass. The muscles pull towards these
    // points (see `stand`), which is what lets the character get up and hold a
    // stance - links alone can never say which way is up.
    const middle = this.center()
    for (const p of this.points) {
      this.poseX.push(p.x - middle.x)
      this.poseY.push(p.y - middle.y)
    }

    // Which pairs of circles have to be kept apart. Linked circles are handled
    // by their link (which already stops them overlapping); everything else
    // that starts out close enough to ever meet goes into the list - except the
    // two limbs of a pair: the left and the right hip hang on the same body
    // circle and must not shove each other around.
    const linked = new Set(this.links.map((l) => (l.a < l.b ? `${l.a}-${l.b}` : `${l.b}-${l.a}`)))
    const twins = (a: PartId, b: PartId): boolean =>
      (a === 'legL' && b === 'legR') ||
      (a === 'legR' && b === 'legL') ||
      (a === 'armL' && b === 'armR') ||
      (a === 'armR' && b === 'armL')
    for (let i = 0; i < this.points.length; i++) {
      for (let j = i + 1; j < this.points.length; j++) {
        if (linked.has(`${i}-${j}`)) continue
        const p1 = this.points[i]
        const p2 = this.points[j]
        const soft = twins(p1.part, p2.part)
        const touching = p1.r + p2.r
        const apart = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        if (apart < touching * SIM.contactReach) this.contacts.push([i, j, soft])
      }
    }

    // The body is a rigid oval, so a push on one of its circles has to carry
    // the whole frame: scale it by the mass ratio, otherwise the thrust would
    // be three times weaker than it used to be when it was applied at the head.
    let total = 0
    let body = 0
    for (const p of this.points) {
      const mass = 1 / p.im
      total += mass
      if (p.part === 'torso') body += mass
    }
    this.pushScale = body > 0 ? total / body : 1
    this.elasticity = 0 // so that the first setElasticity always applies
    this.setElasticity(SIM.elasticity)
  }

  /**
   * The muscles: pull every circle towards its place in the target skeleton -
   * the stance - which is the rest pose held UPRIGHT and anchored at the
   * body's current centre of mass. That is what can straighten the character
   * and keep it on its feet; links alone cannot, because they never say which
   * way is up.
   *
   * `stance` comes from the admin slider (0 = pure ragdoll). The pull is the
   * same everywhere: no special rules near the floor.
   */
  private stand(stance: number, dt: number, bounds: Bounds): void {
    if (stance <= 0) return

    const c = this.center()
    const k = STAND.frequency * stance * dt * dt
    const damp = STAND.damping * stance

    // The pull is an internal force: whatever the limbs take, the body gives
    // back, so the frame never pushes itself around.
    let pushX = 0
    let pushY = 0
    let sum = 0
    for (const p of this.points) sum += 1 / p.im

    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i]
      const gain = STAND.gain[p.part]
      if (!gain) continue

      const tx = c.x + this.poseX[i]
      const ty = c.y + this.poseY[i]
      let dx = (tx - p.x) * k * gain
      let dy = (ty - p.y) * k * gain

      // A circle lying against a wall is pulled ALONG it, never into it:
      // pushing into the wall would be answered by the wall every substep and
      // that reaction shakes the whole frame.
      const edge = 1.5
      if (p.y + p.r > bounds.h - edge && dy > 0) dy = 0
      if (p.y - p.r < edge && dy < 0) dy = 0
      if (p.x + p.r > bounds.w - edge && dx > 0) dx = 0
      if (p.x - p.r < edge && dx < 0) dx = 0

      p.x += dx
      p.y += dy
      const mass = 1 / p.im
      pushX += dx * mass
      pushY += dy * mass

      // ...and damp the muscle: without it the pull makes the whole frame buzz
      if (damp > 0) {
        const vx = p.x - p.px
        const vy = p.y - p.py
        p.px += vx * damp
        p.py += vy * damp
      }
    }

    // The reaction goes into the body as MOMENTUM: the total displacement the
    // limbs got, times their mass, divided by the body's mass - a displacement
    // every body circle shares. Getting this wrong (as it was: the plain sum of
    // the corrections) pumps energy into the frame until it explodes.
    let body = 0
    for (const p of this.points) {
      if (p.part === 'torso') body += 1 / p.im
    }
    if (body === 0 || sum === 0) return
    for (const p of this.points) {
      if (p.part !== 'torso') continue
      p.x -= pushX / body
      p.y -= pushY / body
    }
  }

  /**
   * A hidden spring that gives the frame its shape: it pulls the two circles
   * back to the distance they have at rest, and cannot be pushed past the
   * given band. `kind` says how strong it is (see LINK.compliance).
   */
  private addBrace(a: number, b: number, fold: number, kind: ShapeKind, grow = 1.02): void {
    const p1 = this.points[a]
    const p2 = this.points[b]
    const straight = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const compliance = LINK.compliance[kind]
    this.links.push({
      a,
      b,
      rest: straight,
      min: straight * fold,
      max: straight * grow,
      joint: true,
      /** Base fold limit; the elasticity deepens it (see setElasticity). */
      fold,
      stretch: grow,
      complianceBase: compliance,
      compliance,
      lambda: 0,
      draw: false,
      width: 0,
      kind,
    })
  }


  /** An elastic link with hard limits derived from the circles' radii. */
  private addLink(
    a: number,
    b: number,
    kind: BodyKind,
    draw: boolean,
    attach = false,
  ): Link {
    const p1 = this.points[a]
    const p2 = this.points[b]
    const spacing = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const touching = p1.r + p2.r
    /**
     * The circles rest a hair apart (`give`), so the link can be squeezed and
     * push back - that is what makes the frame springy and lets the legs carry
     * the body. The hard floor stays the touching distance.
     */
    const rest = Math.max(spacing, touching * (1 + LINK.give[kind]))
    /**
     * Capsule width. Inside a chain the capsule is as wide as the circles, so
     * the chain reads as ONE smooth bar (a narrower capsule would show the
     * circles as beads). Where a limb or the head meets the body it is the
     * THINNER of the two, so a neck never gets as wide as the head - that is
     * what used to turn the head into an oval.
     */
    const width = 2 * (attach ? Math.min(p1.r, p2.r) : Math.max(p1.r, p2.r))
    const stretch = LINK.stretch[kind]
    const compliance = LINK.compliance[kind]
    const link: Link = {
      a,
      b,
      rest,
      // circles may close up to the touching distance - and not a pixel more
      min: touching,
      max: Math.max(touching, rest * stretch),
      stretch,
      complianceBase: compliance,
      compliance,
      lambda: 0,
      draw,
      width: draw ? width : 0,
      kind,
    }
    this.links.push(link)
    if (draw) this.drawn.push(link)
    return link
  }

  /**
   * How elastic the frame is right now (the admin slider). Every link gets a
   * wider stretch allowance and a softer spring; rigid links (the body) stay
   * rigid, so the character becomes rubbery without turning into a rope.
   */
  setElasticity(factor: number): void {
    const f = Math.max(0.2, Math.min(4, factor))
    if (f === this.elasticity) return
    this.elasticity = f
    for (const link of this.links) {
      link.max = Math.max(link.min, link.rest * (1 + (link.stretch - 1) * f))
      link.compliance = link.complianceBase / f
      // A shape spring (a brace or a limb's attitude spring) also allows a
      // DEEPER bend the more elastic the frame is: that is what makes the
      // slider something you can feel - a stiff skeleton against a rubbery one.
      // The body links keep their floor: the circles must never overlap.
      if (link.fold !== undefined) {
        link.min = link.rest * Math.max(0.05, 1 - (1 - link.fold) * f)
      }
    }
  }

  /**
   * How hard the joints hold their angle (the admin slider, 0..1): this is the
   * grip of a posable doll. 0 = springs only (a floppy ragdoll), 1 = the joints
   * hold and the frame stands on its own, like a posed figure.
   */
  setJointGrip(fraction: number): void {
    this.grip = SIM.jointGrip * Math.max(0, Math.min(1, fraction))
  }

  /** Index of a named circle. */
  indexOf(name: string): number {
    const i = this.index.get(name)
    if (i === undefined) throw new Error(`unknown skeleton point: ${name}`)
    return i
  }

  point(name: string): Circle {
    return this.points[this.indexOf(name)]
  }

  get head(): Circle {
    return this.point('head')
  }

  /** Mass-weighted centroid of the body. */
  center(): { x: number; y: number } {
    let m = 0
    let x = 0
    let y = 0
    for (const p of this.points) {
      const w = 1 / p.im
      m += w
      x += p.x * w
      y += p.y * w
    }
    return { x: x / m, y: y / m }
  }

  /** Average velocity of the body (px/s), useful for HUD and tests. */
  velocity(dt: number = SIM.dt): { x: number; y: number } {
    let x = 0
    let y = 0
    for (const p of this.points) {
      x += p.x - p.px
      y += p.y - p.py
    }
    return { x: x / this.points.length / dt, y: y / this.points.length / dt }
  }

  /**
   * One fixed simulation step. The step is split into `SIM.substeps` physics
   * substeps: a fast-tumbling limb moves several pixels per step, and a
   * single pass would let the links run past their limits. Substepping stays
   * deterministic and frame-rate independent - it only makes the same
   * simulation more accurate.
   */
  step(dt: number, input: StepInput, bounds: Bounds): void {
    const substeps = SIM.substeps
    const h = dt / substeps
    for (let s = 0; s < substeps; s++) this.substep(h, input, bounds)
  }

  /** Integrate, apply forces, solve the skeleton, hit the walls. */
  private substep(dt: number, input: StepInput, bounds: Bounds): void {
    const dt2 = dt * dt

    // Air drag is defined per FIXED step: a substep only takes its share, so
    // the number of substeps changes the accuracy of the simulation and never
    // the feel (otherwise 4 substeps would damp the body four times as hard).
    const drag = 1 - SIM.airDrag * (dt / SIM.dt)

    // 1. Verlet integration (+ gravity for every circle, mass independent)
    for (const p of this.points) {
      const vx = (p.x - p.px) * drag
      const vy = (p.y - p.py) * drag
      p.px = p.x
      p.py = p.y
      p.x += vx
      p.y += vy + input.gravity * dt2
    }

    // 2. The player's thrust acts at the neck only -> the body tumbles.
    //    The slider is the acceleration of the whole BODY, so the push is
    //    scaled by how much heavier the body is than the part it is applied
    //    to - the body is a rigid oval, so the force on that circle carries
    //    the whole of it.
    const push = this.point(FORCE_POINT)
    push.x += input.thrustX * this.pushScale * dt2
    push.y += input.thrustY * this.pushScale * dt2

    // 3. The pose springs hold the limbs where they belong
    this.stand(input.stance ?? 0, dt, bounds)

    // 4. Satisfy the skeleton and the walls together, iteratively. The XPBD
    //    accumulators live for one substep, so they start from zero.
    for (const link of this.links) link.lambda = 0
    this.hits.clear()
    for (let i = 0; i < SIM.solverIterations; i++) {
      // walls first: the links get the last word, because a stretched link is
      // far more visible than a circle a fraction of a pixel inside a wall
      this.clampToWalls(bounds)
      for (const link of this.links) this.satisfy(link, dt)
      this.separate()
    }

    // 4. Damp the shape springs: a spring alone would swing for ever
    for (const link of this.links) {
      if (link.kind === 'brace' || link.kind === 'pose') this.damp(link, LINK.damping[link.kind])
    }

    // 5. One velocity response for the circles that touched a wall
    this.bounce()
  }

  /**
   * Remove a part of the relative velocity of the two outer circles of a
   * spring (a damper in parallel with it), conserving momentum. This is what
   * makes a limb come to rest in its pose instead of swinging around the joint.
   */
  private damp(link: Link, amount: number): void {
    const p1 = this.points[link.a]
    const p2 = this.points[link.b]
    const relX = p2.x - p2.px - (p1.x - p1.px)
    const relY = p2.y - p2.py - (p1.y - p1.py)
    if (relX === 0 && relY === 0) return
    const w1 = p1.im
    const w2 = p2.im
    const w = w1 + w2
    if (w === 0) return
    const k = amount / w
    p1.px -= relX * k * w1
    p1.py -= relY * k * w1
    p2.px += relX * k * w2
    p2.py += relY * k * w2
  }


  /**
   * Push apart the circles that are not linked to each other, so that no two
   * circles of the body intersect. This is what keeps the two legs two legs:
   * without it they simply pass through one another in the air (measured: they
   * overlap completely in 98% of frames) and read as one thick leg.
   *
   * The two limbs of a pair (left leg against right leg, left arm against the
   * right arm) are handled GENTLY. A hard shove there is felt as the hips
   * knocking each other about; the soft one only stops them sinking in.
   */
  private separate(): void {
    for (const [i, j, soft] of this.contacts) {
      const p1 = this.points[i]
      const p2 = this.points[j]
      let dx = p2.x - p1.x
      let dy = p2.y - p1.y
      const d = Math.hypot(dx, dy)
      const min = p1.r + p2.r
      if (d >= min || d < 1e-6) continue
      const w1 = p1.im
      const w2 = p2.im
      const w = w1 + w2
      if (w === 0) continue

      // part of the overlap per iteration: the rest of the loop finishes the
      // job, and pushing it all at once makes the pair jitter
      const corr = ((min - d) / d) * (soft ? SIM.twinPush : 0.5)
      p1.x -= dx * corr * (w1 / w)
      p1.y -= dy * corr * (w1 / w)
      p2.x += dx * corr * (w2 / w)
      p2.y += dy * corr * (w2 / w)

      if (!soft) continue
      // ...and take the fight out of the pair: damp the velocity ALONG the line
      // between them (a proper damper - remove a share of the approach), so two
      // limbs settle instead of bouncing off each other
      const nx = dx / d
      const ny = dy / d
      const relX = p2.x - p2.px - (p1.x - p1.px)
      const relY = p2.y - p2.py - (p1.y - p1.py)
      const relN = relX * nx + relY * ny
      const imp = (0.25 * relN) / w
      p1.px -= imp * w1 * nx
      p1.py -= imp * w1 * ny
      p2.px += imp * w2 * nx
      p2.py += imp * w2 * ny
    }
  }

  /**
   * Solve one link: hard limits first (no overlap, no overstretch), then the
   * elastic XPBD pull towards the rest length.
   */
  private satisfy(link: Link, dt: number): void {
    const p1 = this.points[link.a]
    const p2 = this.points[link.b]
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    let d = Math.hypot(dx, dy)
    const w1 = p1.im
    const w2 = p2.im
    const w = w1 + w2
    if (w === 0) return

    // degenerate case: coincident circles have no direction - push them apart
    if (d < 1e-6) {
      p1.x -= 0.01
      p2.x += 0.01
      return
    }

    const nx = dx / d
    const ny = dy / d

    // hard limits: the circles may not overlap and may not run away
    const target = d < link.min ? link.min : d > link.max ? link.max : d
    if (target !== d) {
      const corr = target - d
      p1.x -= nx * corr * (w1 / w)
      p1.y -= ny * corr * (w1 / w)
      p2.x += nx * corr * (w2 / w)
      p2.y += ny * corr * (w2 / w)
      d = target
    }

    if (link.compliance <= 0) {
      // a rigid link: project the two circles exactly onto the rest length
      const corr = link.rest - d
      p1.x -= nx * corr * (w1 / w)
      p1.y -= ny * corr * (w1 / w)
      p2.x += nx * corr * (w2 / w)
      p2.y += ny * corr * (w2 / w)
      return
    }

    if (link.joint && this.grip > 0) {
      // A JOINT, and it has grip: correct it rigidly, but by at most `grip` px
      // per substep. A static load is corrected completely (so the joint holds
      // its angle, like the wire in a posed doll), while a hard hit moves it
      // further than one substep can fix - so it slips, and is then pulled
      // back step by step.
      const want = link.rest - d
      const corr = want > this.grip ? this.grip : want < -this.grip ? -this.grip : want
      p1.x -= nx * corr * (w1 / w)
      p1.y -= ny * corr * (w1 / w)
      p2.x += nx * corr * (w2 / w)
      p2.y += ny * corr * (w2 / w)
      return
    }

    // elastic pull towards the rest length (XPBD)
    const alpha = link.compliance / (dt * dt)
    const error = d - link.rest
    const dLambda = (-error - alpha * link.lambda) / (w + alpha)
    link.lambda += dLambda
    p1.x -= nx * dLambda * w1
    p1.y -= ny * dLambda * w1
    p2.x += nx * dLambda * w2
    p2.y += ny * dLambda * w2
  }

  /**
   * Wall contact of one solver iteration: pure position clamping, so it can
   * run inside the constraint loop. The velocity at the moment of the first
   * contact is remembered for `bounce()`.
   */
  private clampToWalls({ w, h }: Bounds): void {
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i]
      const hitX = p.x < p.r || p.x > w - p.r
      const hitY = p.y < p.r || p.y > h - p.r
      if (!hitX && !hitY) continue

      let hit = this.hits.get(i)
      if (hit === undefined) {
        hit = { vx: p.x - p.px, vy: p.y - p.py, x: false, y: false }
        this.hits.set(i, hit)
      }
      if (hitX) {
        p.x = p.x < p.r ? p.r : w - p.r
        hit.x = true
      }
      if (hitY) {
        p.y = p.y < p.r ? p.r : h - p.r
        hit.y = true
      }
    }
  }

  /**
   * Velocity response for the wall contacts of this substep: the velocity
   * component into the wall bounces back (restitution), the one along the
   * wall is only slightly damped (friction). Applied once per substep, after
   * the constraints are satisfied - applying it inside the loop would eat
   * all the speed.
   */
  private bounce(): void {
    const rest = SIM.wallRestitution
    const fric = SIM.wallFriction
    for (const [i, hit] of this.hits) {
      const p = this.points[i]
      if (hit.x && hit.y) {
        p.px = p.x + hit.vx * rest
        p.py = p.y + hit.vy * rest
      } else if (hit.x) {
        p.px = p.x + hit.vx * rest
        p.py = p.y - hit.vy * fric
      } else {
        p.px = p.x - hit.vx * fric
        p.py = p.y + hit.vy * rest
      }
    }
    this.hits.clear()
  }
}
