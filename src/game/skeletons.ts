/* ------------------------------------------------------------------ *
 *  THE SKELETON, AS DATA.
 *
 *  A scheme describes the character's composition - how many circles, in what
 *  chains, where a chain hangs on the body, under what angle it grows, where it
 *  folds. Nothing here is physics: the same builder in `ragdoll.ts` turns any of
 *  these into a frame, so a new character is a new object in this file (or a
 *  JSON file loaded into the editor), not a change inside the engine.
 *
 *  Units: angles are DEGREES (they are meant to be read and edited by a human),
 *  lengths are factors of the circle diameter; the builder converts them.
 * ------------------------------------------------------------------ */

/** One chain of circles: the body, the head, or one limb. */
export interface ChainScheme {
  /** 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' */
  part: string
  /** How many circles the chain has. */
  count: number
  /** Radius as a factor of the body circle (the head uses a bigger one). */
  radius?: number
  /**
   * The body circle this chain hangs on: a circle name ('torso0'), or the
   * keywords 'neck' (first vertebra) and 'pelvis' (last one).
   */
  attachTo?: string
  /** Direction of the attach link, degrees off the body axis. */
  attachAngle?: number
  /** Length of the attach link, as a factor of the touching distance. */
  attachLength?: number
  /**
   * A second body circle to tie the limb to ('torso1'). This is the joint of
   * the original scheme: two links pin the limb's attitude so it cannot turn
   * inside out. Leave it out to have a joint of a single link with a `window`.
   */
  attachAlong?: string
  /** Direction the chain grows in, degrees off the body axis. */
  angle?: number
  /** Distance between circles, as a factor of the touching distance. */
  step?: number
  /** Which circle of the chain is the hinge (the elbow, the knee). */
  hinge?: number
  /** How much the hinge is already bent in the rest pose (degrees). */
  preBend?: number
  /** How far the limb may swing from its attitude, radians (props joint). */
  swing?: number
  /**
   * A one-sided window of the joint in radians: the limb hangs on ONE link and
   * may swing this far either way, never crossing the body to the other side.
   */
  window?: number
  /** A spine: the chain gives and bends a little instead of being welded. */
  flex?: boolean
}

export interface SkeletonScheme {
  id: string
  /** What to show in the editor and the admin panel. */
  name: string
  /** The body itself: how many vertebrae, the head, the gaps. */
  body: {
    count: number
    /** Head radius as a factor of the body circle. */
    headRadius: number
    /** Where the first vertebra sits: (headR + R) * neckGap below the head. */
    neckGap: number
  }
  /** Every chain, in layout order. The body chain must come first. */
  chains: ChainScheme[]
}

/* ------------------------------------------------------------------ *
 *  HOW A LIMB'S JOINT IS WRITTEN DOWN
 *
 *  There are two styles, and a chain uses ONE of them:
 *
 *    props  - `swing` + `attachAlong`: two links to the body hold the limb's
 *             attitude (the original scheme; a limb cannot turn inside out);
 *    window - `window` alone: one link to the tip of the limb plus a hard
 *             one-sided window (a limb may swing that far either way and never
 *             crosses to the other side).
 *
 *  Everything else is shared: `count`, `radius`, `step`, `angle`, `hinge`,
 *  `preBend`, `attachTo`, `attachAngle`, `attachLength`, `flex`.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  1. "normal" - what the game runs today.
 * ------------------------------------------------------------------ */

export const NORMAL: SkeletonScheme = {
  id: 'normal',
  name: 'обычный (24 кружка)',
  body: { count: 5, headRadius: 1.8, neckGap: 1 },
  chains: [
    { part: 'head', count: 1, radius: 1.8 },
    // flex: false - the body is welded into one rigid bone. (The `vertebrae`
    // scheme below turns it on: a spine that gives and bends instead.)
    { part: 'torso', count: 5, attachTo: 'head', flex: false },
    {
      part: 'armL',
      count: 4,
      attachTo: 'neck',
      attachAngle: 45,
      attachAlong: 'torso1',
      angle: 40,
      hinge: 1,

      swing: 1.2,
    },
    {
      part: 'armR',
      count: 4,
      attachTo: 'neck',
      attachAngle: 45,
      attachAlong: 'torso1',
      angle: 40,
      hinge: 1,
      swing: 1.2,
    },
    {
      part: 'legL',
      count: 5,
      attachTo: 'pelvis',
      attachAngle: 36,
      attachAlong: 'torso3',
      angle: 14,
      hinge: 2,
      swing: 0.8,
    },
    {
      part: 'legR',
      count: 5,
      attachTo: 'pelvis',
      attachAngle: 36,
      attachAlong: 'torso3',
      angle: 14,
      hinge: 2,
      swing: 0.8,
    },
  ],
}

/* ------------------------------------------------------------------ *
 *  2. "vertebrae" - the experiment: a bending spine, longer limbs, the
 *     shoulders on the second vertebra and the hips on the last one.
 * ------------------------------------------------------------------ */

export const VERTEBRAE: SkeletonScheme = {
  id: 'vertebrae',
  name: 'позвонки (26 кружков)',
  body: { count: 5, headRadius: 1.8, neckGap: 0.64 },
  chains: [
    { part: 'head', count: 1, radius: 1.8 },
    { part: 'torso', count: 5, attachTo: 'head', flex: true },
    { part: 'armL', count: 4, attachTo: 'torso1', attachAngle: 45, angle: 90, hinge: 1, window: 90 },
    { part: 'armR', count: 4, attachTo: 'torso1', attachAngle: 45, angle: 90, hinge: 1, window: 90 },
    {
      part: 'legL',
      count: 6,
      attachTo: 'pelvis',
      attachAngle: 45,
      angle: 20,
      hinge: 2,
      preBend: 10,
      window: 20,
    },
    {
      part: 'legR',
      count: 6,
      attachTo: 'pelvis',
      attachAngle: 45,
      angle: 20,
      hinge: 2,
      preBend: 10,
      window: 20,
    },
  ],
}

/** Everything the game and the editor can choose from. */
export const SKELETONS: readonly SkeletonScheme[] = [NORMAL, VERTEBRAE]

export const DEFAULT_SKELETON = NORMAL.id

/**
 * Schemes made at runtime - the editor registers what it builds here, so the
 * game can use it straight away without a rebuild.
 */
const custom = new Map<string, SkeletonScheme>()

export const registerSkeleton = (scheme: SkeletonScheme): SkeletonScheme => {
  custom.set(scheme.id, scheme)
  return scheme
}

export const allSkeletons = (): SkeletonScheme[] => [...SKELETONS, ...custom.values()]

export const skeletonById = (id: string): SkeletonScheme =>
  custom.get(id) ?? SKELETONS.find((s) => s.id === id) ?? NORMAL
