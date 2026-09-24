import { BODY, LIMITS, LINK, SIM, type BodyKind, type LinkKind, type ShapeKind } from './config'

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
   * The circle where this chain FOLDS - its hinge (the elbow, the knee).
   * Two bones meet there, and it is the only place the chain may bend; how far
   * it may fold is `LIMITS.hinge[kind]`. `undefined` means the chain is a
   * single rigid bone (the body, the head).
   *
   * This is the whole difference between a leg and an arm: DATA. The code that
   * builds a chain - its bones, welded links, braces and shape matching - is
   * one and the same for every chain, because the main rule of this project is
   * that the physics is universal (see docs/VISION.md).
   */
  hinge?: number
  /**
   * Half-window of this chain's joint, in radians: how far the limb may swing
   * either way from its neutral attitude. The window ends where the limb would
   * cross the body axis to the other side, so the left arm cannot become the
   * right arm. `undefined` = the chain does not hang on a joint (it is part of
   * the body itself).
   */
  window?: number
  /**
   * The chain is a spine, not a welded bar: its links give a little, its braces
   * stop it folding, and it is not made into a rigid bone.
   */
  flex?: boolean
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

/**
 * A limb that marches straight and then folds a little at its hinge - the pose
 * of a standing man, whose knees are never locked.
 *
 * This is not decoration. A leg of perfectly straight bones is a COLUMN: a
 * load along it does not change the distance across the hinge at all, so there
 * is nothing for the spring to give and nothing to absorb a landing - measured
 * on such a frame, the joints hold their angles perfectly and the whole figure
 * tips over like a plank within a second. With a few degrees of bend at rest
 * the same load folds the knee a little and the frame settles instead.
 */
const bentMarch = (
  start: readonly [number, number],
  angle: number,
  bend: number,
  side: number,
  step: number,
  count: number,
  hinge: number,
): ReadonlyArray<readonly [number, number]> => {
  const points: Array<readonly [number, number]> = [start]
  for (let i = 1; i < count; i++) {
    // `side` mirrors the limb; a bigger angle moves the circle further OUT to
    // its own side, so this bends both knees the same way round.
    const a = angle + (i > hinge ? bend : 0)
    const prev = points[i - 1]
    points.push([prev[0] + side * Math.sin(a) * step, prev[1] + Math.cos(a) * step] as const)
  }
  return points
}

/**
 * Where the first vertebra sits: the head is a bigger circle that covers the
 * UPPER HALF of it - the head circle's edge passes through the vertebra's
 * centre, so the two overlap by one radius.
 */
const TORSO_TOP = HEAD_R
const TORSO_STEP = R * 2
/** How many circles the body has (the legs hang from the last one). */
const TORSO_COUNT = 5
const TORSO_BOTTOM = TORSO_TOP + TORSO_STEP * (TORSO_COUNT - 1)
/** The name of the last circle of the body: the pelvis the legs hang from. */
const PELVIS = `torso${TORSO_COUNT - 1}`
/** The vertebra both shoulders grow from (the SECOND one). */
const SHOULDERS = `torso1`
/** How far a limb's first circle sits from the body circle it hangs on. */
const ATTACH_REST = R * 2 * (1 + LINK.give.attach)
/**
 * A LIMB IS TWO BONES AND ONE JOINT.
 *
 * The joint is where the limb hangs on the body - the shoulder on the first
 * circle of the body, the hip on the last one. It is exactly ONE link: a spring
 * that pulls the limb to its NEUTRAL attitude (straight out to the side for an
 * arm, down and slightly out for a leg) with a hard WINDOW either side of it.
 * Inside the window the limb swings freely; the window ends where the limb
 * would cross the body to the other side, so a left arm can never become a
 * right arm. No extra braces, no extra bones: one link per joint, and it is
 * both the muscle (it pulls to the neutral) and the stop (the window).
 *
 * The attach angle and the bone angle are deliberately different numbers: the
 * attach vector is what gives the window its shape (the link measures the
 * distance body-circle -> limb tip, and with a collinear build that distance
 * could not tell "up" from "down").
 */
const ARM_ATTACH_ANGLE = (45 * Math.PI) / 180
/** Neutral attitude of an arm: straight out to the side, 90 degrees. */
const ARM_ANGLE = (90 * Math.PI) / 180
const ARM_STEP = R * 2
/** An arm may swing a half-turn either way - up over the head or down. */
const ARM_WINDOW = (90 * Math.PI) / 180
/**
 * Legs: the hip link goes out and down at 45 degrees, and the leg itself hangs
 * "south-south-east" / "south-south-west" (20 degrees off the vertical).
 */
const LEG_ATTACH_ANGLE = (45 * Math.PI) / 180
const LEG_ATTACH_LENGTH = ATTACH_REST
const LEG_ANGLE = (20 * Math.PI) / 180
const LEG_STEP = R * 2
/** A leg swings less: a narrower window keeps the two legs apart. */
const LEG_WINDOW = (20 * Math.PI) / 180
/** How much the knee is bent in the rest pose: a standing man, not a plank. */
const LEG_BEND = (10 * Math.PI) / 180

const armChain = (side: number, part: PartId): Chain => ({
  part,
  prefix: part,
  radius: R,
  // FOUR circles per arm. The shoulder joint sits in the SECOND vertebra, and
  // the elbow is on the second circle of the arm (bone one: circles 0-1, bone
  // two: circles 1-2-3).
  at: march(
    limbStart(TORSO_TOP + TORSO_STEP, ARM_ATTACH_ANGLE, side, ATTACH_REST),
    [side * Math.sin(ARM_ANGLE) * ARM_STEP, Math.cos(ARM_ANGLE) * ARM_STEP],
    4,
  ),
  hinge: 1,
  window: ARM_WINDOW,
  attachTo: SHOULDERS,
  attachKind: 'attach',
})

const legChain = (side: number, part: PartId): Chain => ({
  part,
  prefix: part,
  radius: R,
  // SIX circles per leg. The hip joint sits in the LAST vertebra (the pelvis),
  // and the knee is on the third circle of the leg (bone one: circles 0-1-2,
  // bone two: circles 2-3-4-5).
  at: bentMarch(
    limbStart(TORSO_BOTTOM, LEG_ATTACH_ANGLE, side, LEG_ATTACH_LENGTH),
    LEG_ANGLE,
    LEG_BEND,
    side,
    LEG_STEP,
    6,
    2,
  ),
  hinge: 2,
  window: LEG_WINDOW,
  attachTo: PELVIS,
  attachKind: 'attach',
})

/**
 * The skeleton:
 * one head circle, a five-circle body with VERTEBRAE (it bends a little, it is
 * not one welded bar), and two limbs of three circles each - two bones and one
 * joint, four bones per pair of limbs.
 *
 *   torso0 is the neck AND the shoulders: both arms hang from the FIRST
 *   circle of the body, with the head sitting on top of it
 *   the arms point straight out to the sides (their neutral attitude)
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
    // The body is a spine, not a bar: its links give a little and its braces
    // stop it folding, so it bends like a back instead of being welded solid.
    flex: true,
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

/**
 * A rigid bone: circles that keep their shape.
 *
 * Distance links are not enough for this. Three circles in a row are a
 * degenerate triangle: the solver may leave a link a quarter of a pixel long
 * and the angle between them swings by thirty degrees (measured) - which is
 * exactly "the legs ripple like a wave" the game complained about. So a bone is
 * fitted to its rest shape once per substep: the whole bone is moved as one
 * rigid piece (translation + one rotation, no stretching at all), which also
 * keeps the momentum, so it cannot pump energy into the frame.
 */
interface Bone {
  points: Array<{ i: number; mass: number; rx: number; ry: number }>
}

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
   * The circles of the frame are NOT kept apart: any part of the body may pass
   * through any other. A ragdoll that resists itself - a leg shoving the other
   * leg, a thigh catching on the pelvis - jams in poses it cannot leave, which
   * is what a "hip dislocation" in a split looked like. What holds the shape is
   * the skeleton (links, bones, hinges) and nothing else.
   */
  /** Rigid bones: circles straightened around their hinge every iteration. */
  private readonly bones: Bone[] = []
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

      // ------------------------------------------------------------------
      //  HOW A CHAIN IS BUILT - the same code for the body, an arm and a leg.
      //
      //  A chain is a line of circles with, at most, ONE hinge: a limb folds at
      //  its elbow or its knee, the body does not fold at all. Everything below
      //  is driven by that single number (`chain.hinge`), which is why no part
      //  of the body is a special case in the physics.
      //
      //  Two bones meet at the hinge, and each bone is a rigid piece:
      //    - the shape of a bone is fitted rigidly once per substep
      //      (`straighten`), so a bone can neither stretch nor bow;
      //    - the links INSIDE a bone are welded (no room to stretch at all);
      //    - the braces inside a bone are welded too, and only the brace that
      //      straddles the hinge may fold - by `LIMITS.hinge` - so a limb folds
      //      at the joint and nowhere else.
      //
      //  A `flex` chain (the body) is the exception that proves the rule: it is
      //  a SPINE. Its links are elastic, its braces only stop it folding, and
      //  it is not turned into a rigid bone - so it bends like a back.
      // ------------------------------------------------------------------
      const limb = linkKindOf(chain.part)
      const hinge = chain.hinge ?? -1
      const flex = chain.flex === true
      const circles = chain.at.map((_, i) => i)
      const bones =
        hinge < 0
          ? [circles]
          : [circles.filter((i) => i <= hinge), circles.filter((i) => i >= hinge)]
      /** Is this pair of circles inside ONE bone? */
      const inOneBone = (a: number, b: number): boolean =>
        !flex && bones.some((bone) => bone.includes(a) && bone.includes(b))

      if (!flex) {
        for (const bone of bones) {
          if (bone.length > 1) this.bones.push(this.makeBone(bone.map((i) => from + i)))
        }
      }

      const fold = Math.cos(LIMITS.bend[limb] / 2)
      const hingeFold = Math.cos((LIMITS.hinge[limb] ?? LIMITS.bend[limb]) / 2)

      // chain links: neighbours, never overlapping. Welded inside a bone.
      for (let i = 1; i < chain.at.length; i++) {
        this.addLink(from + i - 1, from + i, limb, true, false, inOneBone(i - 1, i))
      }

      // braces: circles i-2 and i are pulled back to the distance they have at
      // rest, so a chain that gets bent springs straight again. `LIMITS.bend`
      // is an angle; the brace works on distances, so the allowed shortening is
      // cos(bend/2).
      for (let i = 2; i < chain.at.length; i++) {
        if (hinge >= 0 && !inOneBone(i - 2, i)) {
          // The brace across the hinge IS the elbow/knee: it folds to its limit
          // and it is the one elastic thing in a limb (kind 'hinge' has its own,
          // softer compliance), so a joint gives and springs back instead of
          // being a hard stop.
          this.addBrace(from + i - 2, from + i, hingeFold, 'hinge')
        } else if (!flex) {
          this.addBrace(from + i - 2, from + i, 1, 'brace', 1, true)
        } else {
          this.addBrace(from + i - 2, from + i, fold, 'brace')
        }
      }
      // A spine (or any chain without a hinge) would bow out sideways without a
      // brace from end to end. A chain with a hinge must NOT have one: it would
      // lock the fold.
      if (hinge < 0 && chain.at.length >= 4) {
        this.addBrace(from, from + chain.at.length - 1, fold, 'brace')
      }

      // How the first circle of this chain hangs on the rest of the body: ONE
      // link onto the body circle it grows from - and, for a limb, ONE more:
      // the joint itself.
      if (chain.attachTo) {
        const parent = this.indexOf(chain.attachTo)
        this.addLink(parent, from, chain.attachKind ?? 'attach', true, true)
        const parentPart = linkKindOf(this.points[parent].part)
        /**
         * THE JOINT: a spring towards the neutral attitude with a hard window
         * either side. The link measures the distance from the body circle to
         * the limb's TIP: at the neutral attitude that distance is `tipRest`,
         * and swinging the limb by `window` makes it `tipMax`. Allowing exactly
         * that much - and no more - means the limb swings freely inside its own
         * sector, is pulled back to the neutral when nothing holds it, and can
         * never cross the body axis to become the other limb.
         */
        if (chain.window !== undefined && chain.at.length > 1) {
          const tip = from + chain.at.length - 1
          const p = this.points[parent]
          const joint = this.points[from]
          const rest = Math.hypot(this.points[tip].x - p.x, this.points[tip].y - p.y)
          let tipMax = rest
          for (const way of [-1, 1]) {
            const angle = chain.window * way
            const cos = Math.cos(angle)
            const sin = Math.sin(angle)
            const dx = this.points[tip].x - joint.x
            const dy = this.points[tip].y - joint.y
            const rx = joint.x + dx * cos - dy * sin
            const ry = joint.y + dx * sin + dy * cos
            tipMax = Math.max(tipMax, Math.hypot(rx - p.x, ry - p.y))
          }
          this.addBrace(parent, tip, 0, 'pose', tipMax / rest)
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

  /** Build a bone from the circles that belong to it. */
  private makeBone(members: number[]): Bone {
    let m = 0
    let x = 0
    let y = 0
    for (const i of members) {
      const mass = 1 / this.points[i].im
      m += mass
      x += this.points[i].x * mass
      y += this.points[i].y * mass
    }
    const cx = x / m
    const cy = y / m
    return {
      points: members.map((i) => ({
        i,
        mass: 1 / this.points[i].im,
        rx: this.points[i].x - cx,
        ry: this.points[i].y - cy,
      })),
    }
  }

  /**
   * Fit a bone to its rest shape: one translation and one rotation, no
   * stretching. The circles end up exactly where they were built relative to
   * each other, and because the fit is around the bone's own centre of mass it
   * preserves momentum - so it cannot pump energy into the frame (a version
   * that turned the bone around its hinge instead made the whole simulation
   * explode).
   */
  private straighten(bone: Bone): void {
    let m = 0
    let x = 0
    let y = 0
    for (const p of bone.points) {
      m += p.mass
      x += this.points[p.i].x * p.mass
      y += this.points[p.i].y * p.mass
    }
    const cx = x / m
    const cy = y / m
    let dot = 0
    let cross = 0
    for (const p of bone.points) {
      const q = this.points[p.i]
      dot += p.mass * (p.rx * (q.x - cx) + p.ry * (q.y - cy))
      cross += p.mass * (p.rx * (q.y - cy) - p.ry * (q.x - cx))
    }
    const angle = Math.atan2(cross, dot)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    for (const p of bone.points) {
      const q = this.points[p.i]
      q.x = cx + p.rx * cos - p.ry * sin
      q.y = cy + p.rx * sin + p.ry * cos
    }
  }
  /**
   * A hidden spring that gives the frame its shape: it pulls the two circles
   * back to the distance they have at rest, and cannot be pushed past the
   * given band. `kind` says how strong it is (see LINK.compliance).
   */
  private addBrace(a: number, b: number, fold: number, kind: ShapeKind, grow = 1.02, rigid = false): void {
    const p1 = this.points[a]
    const p2 = this.points[b]
    const straight = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const compliance = rigid ? 0 : LINK.compliance[kind]
    this.links.push({
      a,
      b,
      rest: straight,
      min: straight * fold,
      max: straight * grow,
      // a brace that stays inside a bone is welded, not a joint: the grip must
      // not apply to it, or the bone would bend again
      joint: !rigid,
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
    rigid = false,
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
    const stretch = rigid ? 1 : LINK.stretch[kind]
    const compliance = rigid ? 0 : LINK.compliance[kind]
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


  /**
   * The welded bones as lists of circle indices (a leg is two bones sharing the
   * knee). They are not links - they are fitted rigidly once per substep - so
   * the tuning view has to draw them separately, or a leg looks emptier than an
   * arm although it is the stiffest part of the body.
   */
  boneSpans(): number[][] {
    return this.bones.map((bone) => bone.points.map((p) => p.i))
  }

  /** How hard the joints hold their angle right now, in px per substep. */
  get jointGripPx(): number {
    return this.grip
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

    // 4. Satisfy the skeleton and the walls together, iteratively. The XPBD
    //    accumulators live for one substep, so they start from zero.
    for (const link of this.links) link.lambda = 0
    this.hits.clear()
    for (let i = 0; i < SIM.solverIterations; i++) {
      // Order matters: the walls first, then the LINKS - a bone must come out
      // of a substep straight, otherwise the wall clamps leave it bent
      // (measured: the thigh bent by 22-30 degrees even though every link
      // inside it was rigid).
      this.clampToWalls(bounds)
      for (const link of this.links) this.satisfy(link, dt)
    }

    // 3b. Fit every bone to its rest shape: one rigid move, momentum kept
    for (const bone of this.bones) this.straighten(bone)

    // 4. Damp the shape springs: a spring alone would swing for ever
    for (const link of this.links) {
      if (link.kind === 'brace' || link.kind === 'pose' || link.kind === 'hinge') {
        this.damp(link, LINK.damping[link.kind])
      }
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
