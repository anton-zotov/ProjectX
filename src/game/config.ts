/* ------------------------------------------------------------------ *
 *  Simulation tuning
 *
 *  Everything that shapes the physics lives here (and, for the values the
 *  player may want to change live, in the admin panel -> GameSettings).
 *  The simulation is deterministic: no randomness, fixed step, no
 *  dependency on the frame rate - that is what future replays and netcode
 *  will rely on.
 * ------------------------------------------------------------------ */

export const SIM = {
  /** Fixed simulation step, seconds. */
  dt: 1 / 60,
  /** Safety valve: never simulate more than this many steps per frame. */
  maxStepsPerFrame: 5,
  /** Velocity damping per step (very low = space-like inertia). */
  airDrag: 0.004,
  /** Bounce off the field walls. */
  wallRestitution: 0.35,
  /**
   * Tangential friction while touching a wall, applied per simulation step.
   * Kept very close to 1 on purpose: with a small value the character sticks
   * to the floor and walls and can barely slide, which feels broken.
   */
  wallFriction: 0.985,
  /**
   * Physics substeps per fixed step. A fast-tumbling body moves several
   * pixels per step, and a single step cannot keep the links inside their
   * limits. Substepping stays deterministic and frame-rate independent.
   */
  substeps: 4,
  /** Constraint solver iterations per substep (XPBD / Gauss-Seidel). */
  solverIterations: 20,
  /**
   * Circles that are NOT linked to each other (the two legs, a limb and the
   * body, the head and the body) are kept apart as well: in the original the
   * circles never intersect, and without this the two legs pass straight
   * through one another in the air and read as one thick leg.
   * `contactReach` says how far apart (in radii) a pair may be and still be
   * checked every iteration - only close pairs are kept in the list.
   */
  /**
   * How hard the two limbs of a pair (leg against leg, arm against arm) push
   * each other apart per solver iteration. Gentler than the contact between a
   * limb and the body: a hard shove there knocks the hips about. 0.25 was too
   * gentle once the frame kept its speed in flight (the legs sank 1.7 px into
   * each other at full thrust); 0.4 leaves 0.15 px and the hips still do not
   * twitch.
   */
  /**
   * What holds a joint at its angle - the "grip" of a posable doll.
   *
   * A spring always yields a little under a load, and along a chain those
   * little yields add up until the frame folds (measured: our elastic frame
   * never stands, at any stiffness, while a welded one stands for ever). A
   * doll's limbs stay posed because of FRICTION in the wire joints, not
   * because the wire is springy.
   *
   * So a joint link (the brace that sets an angle) is corrected rigidly, but
   * by at most `jointGrip` px per substep. Under a static load that is far
   * more than enough, so the joint holds; a hard hit moves it further than one
   * substep can correct, so the joint slips - and then keeps being pulled
   * back, which is how a limb comes home again. The admin slider scales this
   * from 0 (a floppy ragdoll) to 100 % (a statue).
   */
  jointGrip: 4,
  /**
   * How elastic the whole frame is; 1 = the tuning below exactly as written.
   * It scales the stretch allowance of every link AND softens its spring, so
   * the admin slider can be dragged while the character is flying and the
   * effect is felt immediately: 2 = twice as rubbery, 0.5 = twice as firm.
   */
  elasticity: 1,
}

/* ------------------------------------------------------------------ *
 *  The body: a chain of circles per section
 *
 *  The character is built the way the original Ragdoll Masters is: every
 *  section is a CHAIN of circles that touch but never overlap, and
 *  neighbouring circles are joined by an elastic link - rubbery, but only
 *  within limits. Nothing is welded: the whole body is springs.
 *
 *    head   one circle, bigger than the body circles, tied to the neck
 *    torso  six circles, one after another
 *    arms   four circles each, tied to the SECOND torso circle, so the
 *           neck circle stays visible above the shoulders
 *    legs   five circles each
 *
 *  The circles are the skeleton; what is drawn on top of them (see
 *  arena.ts) is a capsule between every pair of touching circles plus the
 *  circles themselves - that is what turns a chain into an oval limb.
 * ------------------------------------------------------------------ */

export const BODY = {
  /** Overall size of the skeleton (admin panel: "размер тела"). */
  scale: 0.85,
  /** Solid colour of the drawn body (capsules). */
  color: '#ffffff',
  /**
   * Every circle of the frame has the SAME radius - only the head is bigger.
   * A limb's length therefore comes from how many circles it has (four per
   * arm, five per leg), exactly like the original.
   */
  radius: {
    head: 7.2,
    body: 4,
  },
  /** Mass of a circle = area * density: a bigger circle carries more weight. */
  density: 0.04,
}

/**
 * Link behaviour.
 *
 * `compliance` is XPBD compliance = 1 / stiffness. It is applied through the
 * substep length, so the feel does not depend on the number of substeps or
 * solver iterations. 0 would mean perfectly rigid.
 *
 * `give` is how much a link may be COMPRESSED from its rest length, as a
 * factor of the rest length. This is what makes the frame springy: at rest
 * the circles are a hair apart, so a link can be squeezed and pushes back.
 * The hard floor of a link is always the touching distance - circles must
 * never overlap.
 *
 * `stretch` is the hard limit on the other side, as a factor of the rest
 * length.
 *
 * `bend` is the spring that gives the frame its SHAPE: it keeps a chain
 *   straight (circles i and i+2 are pulled back to the straight distance).
 * Both are two-sided springs, so a limb that gets knocked aside swings back
 * on its own - in zero gravity the frame returns to its rest pose.
 * The limits are only a safety net; the springs do the work.
 */
export const LINK = {
  compliance: {
    head: 0.00002, // the neck link carries the whole body, so it is firm
    torso: 0, // the body is one solid oval: its links are rigid
    arm: 0.00003, // ...and neither do the segments of a limb
    leg: 0.00003,
    attach: 0.00002, // where a limb meets the body
    brace: 0.00008, // hidden braces that keep a chain straight
    hinge: 0.00025, // the spring of an elbow or a knee: it gives and returns
    pose: 0.0003, // the one attitude spring a limb hangs on
  },
  /**
   * How far a link can be squeezed from rest (rest = touching * (1 + give)).
   * The circles of a chain sit exactly next to each other, and so does the
   * first circle of a limb against the body circle it hangs on - only the head
   * keeps a little room on its neck.
   */
  give: {
    head: 0, // the head sits right on the neck circle, no gap
    torso: 0,
    arm: 0,
    leg: 0,
    attach: 0,
  },
  stretch: {
    head: 1.04,
    torso: 1.03,
    arm: 1.05,
    leg: 1.05,
    attach: 1.03,
  },
  /**
   * Damping of the shape springs, per substep: how much of the RELATIVE
   * velocity of the two circles is removed. Without it a limb swings around
   * its joint for ever - a spring stores the energy and gives it back, and
   * air drag alone is far too weak to settle it (measured: the arm was still
   * rotating after eight seconds in zero gravity).
   */
  damping: { brace: 0.012, pose: 0.02, hinge: 0.02 },
}

/*
 * REMOVED: the "muscles" (the second skeleton pulled upright, `STAND` and the
 * `stance` slider). The idea was to right the frame towards a target pose, and
 * it never stopped misbehaving: first it braked the whole body (the damper took
 * the absolute velocity away, 453 px -> 75 px of flight in 3 s), then, fixed,
 * it dragged circles onto targets regardless of what the frame was doing. The
 * character stands WITHOUT it: the grip of the joints (SIM.jointGrip) holds the
 * pose at no cost in flight, and the limbs are bones folded at one hinge. One
 * mechanism less is one thing less to explain - and the rule of the project is
 * that the physics stays universal (docs/VISION.md).
 */

/**
 * The shape limits, in radians. They are turned into DISTANCE limits for the
 * braces and springs that hold the frame together: a chain braced so that
 * circles i and i+2 cannot come closer than cos(bend/2) of their straight
 * distance can bend by about `bend`, and the same trick holds a limb in its
 * attitude. Distance links are used on purpose - they are what stayed stable
 * through every test; an explicit angle constraint deadlocked with them and
 * froze the frame in a wrong pose.
 *
 *   bend   how far a joint inside a chain bends away from straight
 *   swing  how far a whole limb swings away from its rest attitude
 */
export const LIMITS = {
  bend: {
    head: 0.3,
    torso: 0.25, // the body bends only a little
    arm: 0.35, // a limb gives, but stays a limb instead of a rope
    leg: 0.3,
    attach: 0,
  },
  /**
   * The neck: how much the link from the second body circle to the head may
   * shorten (and how far it may stretch). This is what stops the head from
   * spinning all the way round - it can nod and shake a little, like a neck
   * with muscles in it.
   */
  /**
   * How far a HINGE may fold, in radians. A hinge is the one place a chain of
   * circles bends: where two of its bones meet - the elbow, the knee. Which
   * circle that is, is per-chain DATA (see CHAINS in ragdoll.ts); the mechanism
   * that builds and folds it is the same for every chain, arms and legs alike.
   */
  hinge: { head: 0, torso: 0.25, arm: 1.2, leg: 1.7, attach: 0 },
  /**
   * How far a limb may swing away from the attitude it is built in, in radians -
   * the window of the ONE attitude spring each limb hangs on. Generous on
   * purpose: the arms must be able to go up over the shoulders (they were
   * clamped below them while a second spring pinned the attitude down).
   */
  swing: { head: 0, torso: 0, arm: 2.6, leg: 1.4, attach: 0 },
  neckFold: 0.94,
  neckGrow: 1.01,
}

/** Links that carry the body: an elastic distance with hard limits. */
export type BodyKind = 'head' | 'torso' | 'arm' | 'leg' | 'attach'
export type ShapeKind = 'brace' | 'pose' | 'hinge'
export type LinkKind = BodyKind | ShapeKind

/** Defaults for the player-tunable values (mirrored in the admin panel). */
export const DEFAULTS = {
  /**
   * px/s^2, applied at the head. The thrust is the acceleration of the HEAD
   * alone, while the body it has to pull weighs about seven times more, so
   * the number is much bigger than gravity - otherwise the character cannot
   * even lift itself off the floor.
   */
  thrust: 1900,
  /** px/s^2, low on purpose ("moon" feel). */
  gravity: 180,
}
