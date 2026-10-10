/* ------------------------------------------------------------------ *
 *  THE BODY ON BOX2D (Planck.js)
 *
 *  This is the other way round from our own solver. There, a body was a chain
 *  of circles and a joint was a set of DISTANCES, so orientation had to be
 *  guessed from lengths - and a distance cannot tell a knee folding the right
 *  way from one folding backwards (measured: the same pull folded our knee 24
 *  degrees backwards in the standard scheme and 104 in the shared-circle one).
 *
 *  Here a BONE is one rigid body (several circle fixtures on it, so it keeps the
 *  look of a chain of circles) and a JOINT is a revolute joint with a lower and
 *  an upper angle. The angle is the thing itself, not something derived, so
 *  limits hold and read back directly, and a joint can also have a MOTOR - the
 *  actuator our own engine never had.
 *
 *  Units: the game works in pixels, Box2D is happiest in metres, so the body is
 *  built in metres (50 px each) and everything that goes in or out is converted.
 * ------------------------------------------------------------------ */
import { World, Vec2, Circle, Edge, RevoluteJoint } from 'planck'

export const PX_PER_M = 50

/** One bone: circles in body-local pixels, plus what it hangs on. */
interface BoneDef {
  name: string
  /** Radius of every circle of this bone, in px. */
  radius: number
  /** Circle centres, in px, relative to the bone's own centre at rest. */
  at: Array<[number, number]>
  /** The bone this one hangs on (null for the torso). */
  parent: string | null
  /** Where the joint sits, in px, relative to THIS bone's centre. */
  anchor: [number, number]
  /** Joint limits in radians. `lower` may be negative: that is a two-sided joint. */
  lower: number
  upper: number
  /**
   * An optional motor: the speed it drives the joint at and the torque it may
   * use. Zero means no motor - the joint is passive, like the whole ragdoll.
   */
  motorSpeed?: number
  maxMotorTorque?: number
}

const R = 6
const STEP = R * 2
const deg = (d: number): number => (d * Math.PI) / 180

/**
 * The character as data: a torso with a head, and two limbs of two bones each.
 * Circles are laid out so a bone reads as a piece of the old chain.
 */
export const BONES: BoneDef[] = [
  { name: 'torso', radius: R, at: [[0, 0], [0, STEP], [0, STEP * 2]], parent: null, anchor: [0, 0], lower: 0, upper: 0 },
  {
    name: 'head',
    radius: R * 1.8,
    at: [[0, -R * 1.6]],
    parent: 'torso',
    anchor: [0, -R * 1.8],
    lower: deg(-30),
    upper: deg(30),
  },
  // arms: a shoulder with a wide range, an elbow that only folds one way
  ...['L', 'R'].flatMap((side) => {
    const s = side === 'L' ? -1 : 1
    return [
      {
        name: `upperArm${side}`,
        radius: R,
        at: [[0, 0], [0, STEP]] as Array<[number, number]>,
        parent: 'torso',
        anchor: [-s * STEP, -STEP] as [number, number],
        lower: deg(-100),
        upper: deg(100),
      },
      {
        name: `forearm${side}`,
        radius: R,
        at: [[0, 0], [0, STEP]] as Array<[number, number]>,
        parent: `upperArm${side}`,
        anchor: [0, STEP] as [number, number],
        lower: deg(-5),
        upper: deg(140),
      },
    ]
  }),
  // legs: a hip that swings a little both ways, a knee that only folds back
  ...['L', 'R'].flatMap((side) => {
    const s = side === 'L' ? -1 : 1
    return [
      {
        name: `thigh${side}`,
        radius: R,
        at: [[0, 0], [0, STEP], [0, STEP * 2]] as Array<[number, number]>,
        parent: 'torso',
        anchor: [-s * STEP * 0.6, STEP * 2] as [number, number],
        lower: deg(-45),
        upper: deg(45),
      },
      {
        name: `shin${side}`,
        radius: R,
        at: [[0, 0], [0, STEP], [0, STEP * 2]] as Array<[number, number]>,
        parent: `thigh${side}`,
        anchor: [0, STEP * 2] as [number, number],
        lower: deg(-5),
        upper: deg(140),
      },
    ]
  }),
]

/** A bone as the renderer sees it: where its circles are right now. */
export interface BoneView {
  name: string
  radius: number
  circles: Array<{ x: number; y: number; r: number }>
}

export class BoxBody {
  readonly bones: BoneView[] = []
  readonly world: World
  private readonly bodies = new Map<string, unknown>()
  private readonly joints = new Map<string, RevoluteJoint>()
  private readonly torso: ReturnType<World['createBody']>
  private elasticity = 1

  constructor(x: number, y: number, scale = 1, bounds = { w: 960, h: 360 }) {
    this.world = new World({ gravity: new Vec2(0, 0) })
    const positions = new Map<string, { cx: number; cy: number }>()
    const px = (v: number): number => (v * scale) / PX_PER_M

    // where every bone's centre sits at rest, in px, relative to the body's
    // origin: walk the bone list, each one under its parent
    const place = (bone: BoneDef): { cx: number; cy: number } => {
      const known = positions.get(bone.name)
      if (known) return known
      const anchorM = { x: bone.anchor[0] * scale, y: bone.anchor[1] * scale }
      const parent = bone.parent ? place(BONES.find((b) => b.name === bone.parent)!) : { cx: 0, cy: 0 }
      // the joint sits at the anchor of the child, which is the parent's centre
      // plus how far the child hangs below it
      const local = { cx: parent.cx + anchorM.x, cy: parent.cy + anchorM.y }
      // the bone's own centre is its first circle
      const centre = { cx: local.cx + bone.at[0][0] * scale, cy: local.cy + bone.at[0][1] * scale }
      positions.set(bone.name, centre)
      return centre
    }

    for (const bone of BONES) {
      const centre = place(bone)
      const body = this.world.createBody({
        type: 'dynamic',
        position: new Vec2((x + centre.cx) / PX_PER_M, (y + centre.cy) / PX_PER_M),
        linearDamping: 0.2,
        angularDamping: 0.4,
      })
      for (const [ax, ay] of bone.at) {
        // the fixture's offset is measured from the body's centre
        body.createFixture(new Circle(new Vec2(px(ax - bone.at[0][0]), px(ay - bone.at[0][1])), px(bone.radius)), {
          density: 1,
          friction: 0.4,
          restitution: 0,
          filterGroupIndex: -1, // the parts of one body never collide with each other
        })
      }
      this.bodies.set(bone.name, body)
      this.bones.push({
        name: bone.name,
        radius: bone.radius,
        circles: bone.at.map(() => ({ x: 0, y: 0, r: bone.radius })),
      })
      if (bone.parent) {
        const parent = this.bodies.get(bone.parent) as ReturnType<World['createBody']>
        const anchorParent = {
          x: (x + centre.cx - (positions.get(bone.parent)?.cx ?? 0)) / PX_PER_M,
          y: (y + centre.cy - (positions.get(bone.parent)?.cy ?? 0)) / PX_PER_M,
        }
        const joint = this.world.createJoint(
          new RevoluteJoint(
            {
              enableLimit: true,
              lowerAngle: bone.lower,
              upperAngle: bone.upper,
              enableMotor: (bone.motorSpeed ?? 0) !== 0,
              motorSpeed: bone.motorSpeed ?? 0,
              maxMotorTorque: bone.maxMotorTorque ?? 0,
              collideConnected: false,
            },
            parent,
            body,
            new Vec2(anchorParent.x, anchorParent.y),
          ),
        )
        if (joint) this.joints.set(bone.name, joint)
      }
    }
    this.torso = this.bodies.get('torso') as ReturnType<World['createBody']>

    // the arena walls as static bodies: Box2D handles the contacts itself
    const floor = this.world.createBody({ type: 'static' })
    const w = bounds.w / PX_PER_M
    const h = bounds.h / PX_PER_M
    floor.createFixture(new Edge(new Vec2(-1, h), new Vec2(w + 1, h)), { friction: 0.6 })
    floor.createFixture(new Edge(new Vec2(0, -1), new Vec2(0, h + 1)), { friction: 0.4 })
    floor.createFixture(new Edge(new Vec2(w, -1), new Vec2(w, h + 1)), { friction: 0.4 })
    floor.createFixture(new Edge(new Vec2(-1, 0), new Vec2(w + 1, 0)), { friction: 0.4 })
  }

  /** Where the camera should look: the head, or the torso if there is none. */
  get head(): { x: number; y: number; r: number } {
    const at = this.bones.find((b) => b.name === 'head')?.circles[0]
    const fallback = this.bones[0]?.circles[0]
    const p = at ?? fallback
    return { x: p?.x ?? 0, y: p?.y ?? 0, r: p?.r ?? 6 }
  }

  /** Elasticity is our own solver's idea; Box2D joints are rigid. Kept for the caller. */
  setElasticity(value: number): void {
    this.elasticity = value
  }

  get elasticityNow(): number {
    return this.elasticity
  }

  /** The angle of a joint, in degrees - the number our engine could not give. */
  jointAngle(name: string): number {
    const joint = this.joints.get(name)
    return joint ? (joint.getJointAngle() * 180) / Math.PI : 0
  }

  /**
   * Set the limit and the motor of every joint that folds one way (the knees and
   * the elbows). This is the panel's "сустав" controls: an exact angle range and
   * a torque-driven motor, both of which our own solver had to fake or never had.
   */
  setFoldingLimits(limit: number, motorSpeed: number, maxTorque: number): void {
    for (const [name, joint] of this.joints) {
      if (!/^(shin|forearm)/.test(name)) continue
      joint.setLimits(-0.05, limit)
      joint.enableMotor(motorSpeed !== 0)
      joint.setMotorSpeed(motorSpeed)
      joint.setMaxMotorTorque(maxTorque)
    }
  }

  /**
   * One tick: gravity, the player's thrust on the torso, and four solver
   * substeps - the recipe the reference implementation uses to keep joints
   * steady when something hits hard.
   */
  step(dt: number, input: { thrustX: number; thrustY: number; gravity: number }, substeps = 4): void {
    this.world.setGravity(new Vec2(0, input.gravity / PX_PER_M))
    const mass = this.torso.getMass()
    // thrust is an acceleration in the settings, so the force is mass * accel
    if (input.thrustX !== 0 || input.thrustY !== 0) {
      this.torso.applyForceToCenter(
        new Vec2((input.thrustX / PX_PER_M) * mass, (input.thrustY / PX_PER_M) * mass),
        true,
      )
    }
    for (let i = 0; i < substeps; i++) this.world.step(dt / substeps, 8, 3)

    // read the positions back out for the renderer
    for (let b = 0; b < this.bones.length; b++) {
      const def = BONES[b]
      const body = this.bodies.get(def.name) as ReturnType<World['createBody']>
      const centre = body.getPosition()
      const origin = { x: centre.x * PX_PER_M, y: centre.y * PX_PER_M }
      const view = this.bones[b]
      def.at.forEach(([ax, ay], i) => {
        const local = body.getWorldPoint(new Vec2((ax - def.at[0][0]) / PX_PER_M, (ay - def.at[0][1]) / PX_PER_M))
        void origin
        view.circles[i] = { x: local.x * PX_PER_M, y: local.y * PX_PER_M, r: def.radius }
      })
    }
  }
}
