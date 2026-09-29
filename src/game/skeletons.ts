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
  /**
   * Radius as a factor of the body circle. NOT used by the head: the head's
   * size lives in `body.headRadius` (one number, one place - it decides both
   * how big the head is and where the first vertebra sits).
   */
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
    /** Head radius as a factor of the body circle. THE size of the head. */
    headRadius: number
    /** Where the first vertebra sits: (headR + R) * neckGap below the head. */
    neckGap: number
  }
  /**
   * The neck: the head hangs on the first vertebra by one link, and this second
   * link is what turns a free hinge into a neck - it stops the head from
   * spinning all the way round, so it can only nod and shake a little. Both
   * numbers are distances as factors of the link's own length: `fold` is how
   * far it may shorten, `grow` how far it may stretch.
   */
  neck?: { fold: number; grow: number }
  /** Every chain, in layout order. The body chain must come first. */
  chains: ChainScheme[]
}

/**
 * Is this scheme buildable? Returns a human-readable reason, or null when it is
 * fine. The editor and the game both call it before using a scheme: a scheme
 * that points at a circle that does not exist used to take the whole frame -
 * and with it the game loop - down with it.
 */
export const validateScheme = (scheme: SkeletonScheme): string | null => {
  if (!scheme || typeof scheme !== 'object') return 'схема пустая'
  if (!scheme.body || !Number.isFinite(scheme.body.count) || scheme.body.count < 1) {
    return 'у тела должно быть хотя бы одно звено'
  }
  if (!Array.isArray(scheme.chains) || !scheme.chains.length) return 'в схеме нет ни одной цепочки'
  const parts = new Set<string>()
  for (const chain of scheme.chains) {
    if (!chain.part) return 'у цепочки нет имени'
    if (parts.has(chain.part)) return `две цепочки с одним именем: ${chain.part}`
    parts.add(chain.part)
    if (!Number.isFinite(chain.count) || chain.count < 1) return `${chain.part}: кружков должно быть ≥ 1`
    if (chain.hinge !== undefined) {
      const h = Math.round(chain.hinge)
      if (h < 1 || h > chain.count - 1) {
        return `${chain.part}: шарнир №${chain.hinge} — это не кружок цепочки (можно 1…${chain.count - 1})`
      }
    }
    if (chain.attachTo && !circleExists(chain.attachTo, scheme)) {
      return `${chain.part}: некуда крепить — кружка «${chain.attachTo}» нет`
    }
    if (chain.attachAlong && !circleExists(chain.attachAlong, scheme)) {
      return `${chain.part}: вторая связь ведёт к несуществующему кружку «${chain.attachAlong}»`
    }
  }
  return null
}

/** Does this circle name exist in the scheme ('neck'/'pelvis' are keywords)? */
const circleExists = (name: string, scheme: SkeletonScheme): boolean => {
  if (name === 'head') return true
  if (name === 'neck') return true
  if (name === 'pelvis') return scheme.body.count >= 1
  const m = /^torso(\d+)$/.exec(name)
  if (m) return Number(m[1]) < scheme.body.count
  return scheme.chains.some((c) => c.part === name)
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
  neck: { fold: 0.94, grow: 1.01 },
  chains: [
    { part: 'head', count: 1 },
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
      count: 6,
      attachTo: 'pelvis',
      attachAngle: 36,
      attachAlong: 'torso3',
      angle: 14,
      hinge: 2,
      swing: 0.8,
    },
    {
      part: 'legR',
      count: 6,
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
  neck: { fold: 0.94, grow: 1.01 },
  chains: [
    { part: 'head', count: 1 },
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

/**
 * Bumped whenever a scheme is (re)registered. The game watches this number:
 * without it, pressing "apply" twice with the same id would look like nothing
 * changed, because the id is what the scene compares.
 */
let revision = 0
export const skeletonRevision = (): number => revision

export const registerSkeleton = (scheme: SkeletonScheme): SkeletonScheme => {
  custom.set(scheme.id, scheme)
  revision++
  return scheme
}

export const allSkeletons = (): SkeletonScheme[] => [...SKELETONS, ...custom.values()]

export const skeletonById = (id: string): SkeletonScheme =>
  custom.get(id) ?? SKELETONS.find((s) => s.id === id) ?? NORMAL
