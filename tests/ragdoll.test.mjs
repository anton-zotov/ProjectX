import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModules } from './helpers.mjs'

const RAGDOLL = '/src/game/ragdoll.ts'
const CONFIG = '/src/game/config.ts'
const { mods, close } = await loadModules([RAGDOLL, CONFIG])
const { Ragdoll, POINT_NAMES, SECTION_SIZES } = mods[RAGDOLL]
/** The last circle of the body: the pelvis the legs hang from. */
const PELVIS = POINT_NAMES.filter((n) => n.startsWith('torso')).pop()
const { SIM, DEFAULTS, LINK } = mods[CONFIG]
test.after(close)

const FIELD = { w: 4000, h: 4000 } // far away walls: tests focus on the body
const ARENA = { w: 960, h: 360 } // the real field (3 screens wide)
const DT = SIM.dt
const NO_GRAVITY = 0
const MOON_GRAVITY = 260

const still = (gravity) => ({ thrustX: 0, thrustY: 0, gravity })
const push = (x, y, gravity = NO_GRAVITY) => ({ thrustX: x, thrustY: y, gravity })

function run(ragdoll, steps, input, bounds = FIELD) {
  for (let i = 0; i < steps; i++) ragdoll.step(DT, typeof input === 'function' ? input(i) : input, bounds)
}

/** Current distance between the two circles of a link. */
const span = (r, link) => {
  const p1 = r.points[link.a]
  const p2 = r.points[link.b]
  return Math.hypot(p2.x - p1.x, p2.y - p1.y)
}

/** A player wiggling the stick: slow direction changes, believable flight. */
const wiggle = (thrust) => (i) => ({
  thrustX: Math.cos(i * 0.02) * thrust,
  thrustY: Math.sin(i * 0.031) * thrust,
  gravity: MOON_GRAVITY,
})

/* ------------------------------------------------------------------ *
 *  THE MAIN RULE OF THE PROJECT: the physics is universal.
 *
 *  Whatever we want the character to do, the mechanism that does it must work
 *  the same EVERYWHERE - no rules about the floor, the walls or how close he is
 *  to either. To make him stand we invent physics that stands him up; we never
 *  switch behaviour on because he happens to be near the ground.
 * ------------------------------------------------------------------ */

/** Rotate one section around its first circle - a limb out of its pose. */
const tilt = (r, part, angle) => {
  const names = POINT_NAMES.filter((n) => n.startsWith(part))
  const anchor = r.point(names[0])
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  for (const name of names) {
    const p = r.point(name)
    const dx = p.x - anchor.x
    const dy = p.y - anchor.y
    p.x = anchor.x + dx * cos - dy * sin
    p.y = anchor.y + dx * sin + dy * cos
    p.px = p.x
    p.py = p.y
  }
}

/** Rotate the WHOLE frame around its centre - he is lying on his side. */
const spin = (r, angle) => {
  const c = r.points.reduce(
    (acc, p) => ({ x: acc.x + p.x / r.points.length, y: acc.y + p.y / r.points.length }),
    { x: 0, y: 0 },
  )
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  for (const p of r.points) {
    const dx = p.x - c.x
    const dy = p.y - c.y
    p.x = c.x + dx * cos - dy * sin
    p.y = c.y + dx * sin + dy * cos
    p.px = p.x
    p.py = p.y
  }
}

/**
 * How far the frame is from upright, in radians: the angle of the pelvis->head
 * axis against the vertical: which way is up. Nothing in the frame knows it
 * the SHAPE, but nothing inside the frame knows which way is up.
 */
const lean = (r) => {
  const head = r.points[0]
  const pelvis = r.point(PELVIS)
  return Math.abs(Math.atan2(head.x - pelvis.x, pelvis.y - head.y))
}

/** Every circle's position relative to the centre of mass. */
const relative = (r) => {
  let m = 0
  let cx = 0
  let cy = 0
  for (const p of r.points) {
    const mass = 1 / p.im
    m += mass
    cx += p.x * mass
    cy += p.y * mass
  }
  cx /= m
  cy /= m
  return r.points.map((p) => ({ x: p.x - cx, y: p.y - cy }))
}

test('the physics does not know where the floor is (the main rule of the project)', () => {
  // The very same scenario in two places in the SAME arena: the feet 10 px above
  // the floor, and 520 px above it. Everything the frame does must be identical
  // - the only thing allowed to differ is contact itself, and here there is no
  // contact in either case.
  const GAP = 10
  const scenario = (gap) => {
    const bounds = { w: 4000, h: 700 }
    const r = new Ragdoll(500, 350)
    // put the feet exactly `gap` above the floor, then lay him on his side and
    // throw a limb out of pose, so the frame has real work to do
    const lowest = Math.max(...r.points.map((p) => p.y + p.r))
    const shift = bounds.h - gap - lowest
    for (const p of r.points) {
      p.y += shift
      p.py += shift
    }
    r.setJointGrip(0.25)
    spin(r, 0.9)
    tilt(r, 'armL', 1.2)
    tilt(r, 'legR', -0.9)

    const started = relative(r)
    for (let i = 0; i < 60 * 2; i++) {
      run(r, 1, still(NO_GRAVITY), bounds)
    }
    const rel = relative(r)
    // ...how far the frame actually travelled from where it started
    let moved = 0
    for (const [i, p] of rel.entries()) {
      moved = Math.max(moved, Math.hypot(p.x - started[i].x, p.y - started[i].y))
    }
    return {
      rel,
      moved,
      lean: lean(r),
      above: bounds.h - Math.max(...r.points.map((p) => p.y + p.r)),
    }
  }

  // the SAME arena, the same push, the same frame - only the height differs
  const near = scenario(GAP)
  const far = scenario(520)

  // the floor never got in the way in either run: this is a fair comparison
  assert.ok(near.above > 0.5, `near the floor he never touches it (${near.above.toFixed(1)} px above)`)
  assert.ok(far.above > 450, `and high above it the floor is ${far.above.toFixed(0)} px away`)

  let worst = 0
  for (const [i, a] of near.rel.entries()) {
    worst = Math.max(worst, Math.hypot(a.x - far.rel[i].x, a.y - far.rel[i].y))
  }
  assert.ok(
    worst < 1e-6,
    `the same scenario gives the same frame near the floor and far from it (worst ${worst.toExponential(1)} px)`,
  )

  // ...and something really did happen in both runs, or the line above would be
  // true for a frozen frame as well
  assert.ok(near.moved > 1, `near the floor the frame moved (${near.moved.toFixed(1)} px)`)
  assert.ok(far.moved > 1, `and far from it too (${far.moved.toFixed(1)} px)`)
})

test('the skeleton is built the original way: 1 + 5 + 4 + 4 + 5 + 5 circles', () => {
  assert.deepEqual(SECTION_SIZES, {
    head: 1,
    torso: 5,
    armL: 4,
    armR: 4,
    legL: 5,
    legR: 5,
  })
  assert.equal(POINT_NAMES.length, 24, 'twenty-four circles in total')
  assert.equal(POINT_NAMES[0], 'head')

  const r = new Ragdoll(2000, 2000)
  assert.equal(r.points.length, POINT_NAMES.length)
  assert.deepEqual(
    r.sections.map((s) => s.count),
    [1, 5, 4, 4, 5, 5],
    'the sections keep their sizes as contiguous ranges',
  )

  // the head hangs on the neck: one link carries it, and a second, tight one
  // to the next body circle is what stops it spinning all the way round
  const headLinks = r.links.filter((l) => l.a === 0 || l.b === 0)
  assert.equal(headLinks.length, 2, 'the head has two links to the body (the neck)')
})

test('the arms hang from the first torso circle, out to the sides', () => {
  const r = new Ragdoll(2000, 2000)
  const torso0 = r.point('torso0')
  const neck = r.point('torso0')

  for (const arm of ['armL0', 'armR0']) {
    const at = r.indexOf(arm)
    const toTorso = r.links.filter((l) => {
      const other = l.a === at ? l.b : l.b === at ? l.a : -1
      return other >= 0 && r.points[other].part === 'torso'
    })
    assert.ok(toTorso.length >= 1, `${arm} is tied to the body`)
    const parents = toTorso.map((l) => r.points[l.a === at ? l.b : l.a])
    assert.ok(parents.includes(torso0), `${arm} hangs from torso0 (the first body circle)`)
  }

  assert.ok(r.point('armL0').x < neck.x && r.point('armR0').x > neck.x, 'the arms hang on both sides')
  assert.ok(r.point('armL3').x < r.point('armL0').x, 'and point outwards, away from the body')
  assert.ok(r.point('head').y < neck.y, 'with the head sitting on top of that same circle')
})

test('neighbouring circles touch, and never sink into each other', () => {
  const r = new Ragdoll(2000, 2000)

  // at rest every drawn link starts at (or just beyond) the touching distance
  for (const link of r.drawn) {
    const p1 = r.points[link.a]
    const p2 = r.points[link.b]
    const touching = p1.r + p2.r
    assert.ok(
      link.rest >= touching - 0.05,
      `link ${link.kind} rests at ${link.rest.toFixed(2)} px, touching is ${touching.toFixed(2)} px`,
    )
    assert.equal(link.min, touching, 'the hard limit IS the touching distance')
  }

  // ...and during a violent flight the hard limit still holds
  let worst = Infinity
  for (let i = 0; i < 300; i++) {
    run(r, 1, wiggle(2400), ARENA)
    for (const link of r.drawn) {
      const overlap = r.points[link.a].r + r.points[link.b].r - span(r, link)
      worst = Math.min(worst, -overlap)
    }
  }
  assert.ok(worst > -1, `circles never overlap (worst: ${(-worst).toFixed(2)} px too close)`)
})

test('a bone is welded and the joint folds: the one chain every limb is built from', () => {
  // A limb is bones with ONE hinge (the elbow, the knee). Inside a bone the
  // links are welded - a bone cannot stretch, that is what stopped the legs
  // rippling like a wave. The fold happens at the hinge brace, and it returns.
  const r = new Ragdoll(2000, 2000)
  const hand = r.indexOf('armL3')
  const inBone = r.links.find((l) => (l.a === hand || l.b === hand) && l.kind === 'arm')
  assert.ok(inBone, 'the hand has a link to the rest of the arm')
  assert.equal(inBone.compliance, 0, 'that link is inside a bone, so it is welded')
  assert.equal(inBone.stretch, 1, 'and it has no room to stretch at all')

  const inArm = (i) => POINT_NAMES[i].startsWith('armL')
  const hinge = r.links.find(
    (l) => l.kind === 'brace' && l.joint && l.fold !== undefined && l.fold < 0.9 && inArm(l.a) && inArm(l.b),
  )
  assert.ok(hinge, 'the arm folds at the elbow')
  assert.ok(
    (hinge.a === r.indexOf('armL0') && hinge.b === r.indexOf('armL2')) ||
      (hinge.b === r.indexOf('armL0') && hinge.a === r.indexOf('armL2')),
    'the fold is the brace straddling the hinge circle',
  )

  // yank the hand: shifting the previous position adds velocity in Verlet
  r.point('armL3').px -= 40
  let maxSpan = 0
  let minFold = hinge.rest
  for (let i = 0; i < 30; i++) {
    run(r, 1, still(NO_GRAVITY))
    maxSpan = Math.max(maxSpan, span(r, inBone))
    minFold = Math.min(minFold, span(r, hinge))
  }

  assert.ok(
    maxSpan <= inBone.max + 0.5,
    `the bone does not stretch (${inBone.rest.toFixed(2)} -> ${maxSpan.toFixed(2)}, limit ${inBone.max.toFixed(2)})`,
  )
  assert.ok(
    minFold < hinge.rest * 0.98,
    `the elbow folds instead (${hinge.rest.toFixed(2)} -> ${minFold.toFixed(2)})`,
  )
  assert.ok(minFold >= hinge.min - 0.5, `but not past the fold limit (${minFold.toFixed(2)} >= ${hinge.min.toFixed(2)})`)

  run(r, 180, still(NO_GRAVITY))
  assert.ok(
    Math.abs(span(r, hinge) - hinge.rest) < hinge.rest * 0.06,
    `and the limb settles back (${span(r, hinge).toFixed(2)} vs ${hinge.rest.toFixed(2)})`,
  )
})

test('every limb is built by the same rule: an arm is a leg with other numbers', () => {
  // THE symmetry test. Before this there were two mechanisms: the legs were
  // welded into bones, the arms were elastic chains. The arms rippled 31
  // degrees where the legs stayed straight at 0, and the sliders moved one limb
  // and not the other. A limb is now data (where its hinge is), not a branch in
  // the solver, so an arm and a leg must come out built the same way.
  const r = new Ragdoll(2000, 2000)
  const census = (prefix) => {
    const indices = new Set(POINT_NAMES.map((n, i) => [n, i]).filter(([n]) => n.startsWith(prefix)).map(([, i]) => i))
    const mine = r.links.filter((l) => indices.has(l.a) && indices.has(l.b))
    return {
      bones: r.boneSpans().filter((span) => indices.has(span[0])).length,
      welds: mine.filter((l) => l.compliance === 0 && l.stretch === 1).length,
      joints: mine.filter((l) => l.joint).length,
      hinges: mine.filter((l) => l.kind === 'brace' && l.joint).length,
      elastic: mine.filter((l) => l.draw && l.compliance > 0 && l.stretch > 1).length,
      circles: indices.size,
    }
  }

  const arm = census('armL')
  const leg = census('legL')
  assert.equal(arm.bones, 2, 'the arm is two bones')
  assert.equal(leg.bones, 2, 'and so is the leg')
  assert.equal(arm.hinges, 1, 'the arm has exactly one hinge (the elbow)')
  assert.equal(leg.hinges, 1, 'the leg has exactly one hinge (the knee)')
  assert.equal(arm.elastic, leg.elastic, `the same number of elastic links (arm ${arm.elastic}, leg ${leg.elastic})`)
  assert.equal(arm.elastic, 0, 'and by design that number is zero: a limb is bones and a joint')
  assert.ok(
    arm.welds >= arm.circles - 1 && leg.welds >= leg.circles - 1,
    `every chain link is welded (arm ${arm.welds}, leg ${leg.welds})`,
  )

  // the fold limit is data per limb, and both limbs respond to the elasticity
  // slider in the same way
  const foldOf = (prefix) => {
    const indices = new Set(POINT_NAMES.map((n, i) => [n, i]).filter(([n]) => n.startsWith(prefix)).map(([, i]) => i))
    const hinge = r.links.find(
      (l) => l.kind === 'brace' && l.joint && indices.has(l.a) && indices.has(l.b) && l.fold !== undefined && l.fold < 0.9,
    )
    return hinge
  }
  // the fold limit is data per limb, and both hinges follow the elasticity
  // slider by exactly the same amount - that is the whole point of building
  // them with one mechanism instead of teaching the solver about a knee
  const elbow = foldOf('armL')
  const knee = foldOf('legL')
  assert.ok(elbow && knee, 'both hinges are folding joints')
  /** The one rule: the fold deepens with the slider, down to a 5% safety floor. */
  const follows = (hinge, factor) => {
    r.setElasticity(factor)
    return (1 - hinge.min / hinge.rest) / (1 - hinge.fold)
  }
  const expected = (hinge, factor) => Math.min(factor, (1 - 0.05) / (1 - hinge.fold))
  for (const factor of [0.5, 1, 3]) {
    assert.ok(
      Math.abs(follows(elbow, factor) - expected(elbow, factor)) < 1e-9,
      `the elbow follows the slider exactly (${factor})`,
    )
    assert.ok(
      Math.abs(follows(knee, factor) - expected(knee, factor)) < 1e-9,
      `and the knee by the same rule (${factor})`,
    )
  }
  r.setElasticity(1)
  assert.ok(Math.abs(follows(elbow, 1) - 1) < 1e-9, 'at 100% the elbow is at its own limit')
  assert.ok(Math.abs(follows(knee, 1) - 1) < 1e-9, 'and so is the knee, from its own number')
})

test('the body is the stiffest part and the limbs are the rubbery one', () => {
  // the design intent, straight from the numbers that drive the solver
  assert.ok(LINK.compliance.torso < LINK.compliance.leg, 'the body is firmer than the legs')
  assert.ok(LINK.compliance.torso < LINK.compliance.arm, 'the body is firmer than the arms')
  assert.ok(LINK.compliance.arm > LINK.compliance.attach, 'a limb is softer than where it is attached')
  assert.ok(LINK.stretch.torso < LINK.stretch.arm, 'and it may stretch further')
})

test('the head is a bigger circle on a neck, not welded and not spinning', () => {
  const r = new Ragdoll(2000, 2000)
  const head = r.head
  const torso = r.point('torso2')
  assert.ok(head.r > torso.r * 1.3, `the head is a bigger circle (${head.r} vs ${torso.r})`)

  // a neck, not a weld: a sideways impulse still turns the head
  const angle = (rr) => {
    const a = rr.point('torso0')
    const b = rr.point('torso3')
    const h = rr.head
    const v1 = { x: b.x - a.x, y: b.y - a.y }
    const v2 = { x: h.x - a.x, y: h.y - a.y }
    return Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y)
  }
  const before = angle(r)
  r.head.px -= 12
  // how far it ever gets: it swings out and comes back, so the end value alone
  // says nothing about whether the neck is welded
  let deg = 0
  for (let i = 0; i < 60; i++) {
    run(r, 1, still(NO_GRAVITY))
    deg = Math.max(deg, Math.abs((angle(r) - before) * (180 / Math.PI)))
  }
  assert.ok(deg > 8, `the head nods on its neck (swung ${deg.toFixed(0)} degrees)`)

  // ...but it cannot spin all the way round: the second link of the neck stops it
  const spun = new Ragdoll(2000, 2000)
  const turn = 2.1 // ~120 degrees, straight past the top
  const pivot = spun.point('torso0')
  const p = spun.point('head')
  const dx = p.x - pivot.x
  const dy = p.y - pivot.y
  p.x = pivot.x + dx * Math.cos(turn) - dy * Math.sin(turn)
  p.y = pivot.y + dx * Math.sin(turn) + dy * Math.cos(turn)
  p.px = p.x
  p.py = p.y
  run(spun, 60 * 4, still(NO_GRAVITY))
  assert.ok(
    spun.point('head').y < spun.point('torso0').y,
    `the head comes back on top of the neck (${(spun.point('torso0').y - spun.point('head').y).toFixed(1)} px above)`,
  )
})

test('every limb swings around the circle it is attached to', () => {
  const deg = (rad) => (rad * 180) / Math.PI
  const angle = (r, a1, b1, a2, b2) => {
    const p = (n) => r.point(n)
    const v1 = { x: p(b1).x - p(a1).x, y: p(b1).y - p(a1).y }
    const v2 = { x: p(b2).x - p(a2).x, y: p(b2).y - p(a2).y }
    return Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y)
  }
  const delta = (a, b) => {
    let d = deg(a) - deg(b)
    while (d > 180) d -= 360
    while (d < -180) d += 360
    return Math.abs(d)
  }

  const cases = [
    ['left arm', 'armL0', 'armL3'],
    ['right arm', 'armR0', 'armR3'],
    ['left leg', 'legL0', 'legL4'],
    ['right leg', 'legR0', 'legR4'],
  ]

  for (const [label, pivot, end] of cases) {
    const r = new Ragdoll(2000, 2000)
    const before = angle(r, 'torso0', PELVIS, pivot, end)
    r.point(end).px -= 8 // a hit impulse at the far end of the limb
    run(r, 20, still(NO_GRAVITY))
    const moved = delta(angle(r, 'torso0', PELVIS, pivot, end), before)
    assert.ok(moved > 5, `${label} swings around its attachment (moved ${moved.toFixed(0)}°)`)
  }
})

test('the two legs are two legs: they never merge, and they move apart', () => {
  const r = new Ragdoll(2000, 2000)

  // The hip circles sit right against the pelvis and next to each other (that
  // is what "circles in a row" means), so at the top they only have to not
  // overlap - but they must clearly diverge further down.
  for (let i = 0; i < 5; i++) {
    const a = r.point(`legL${i}`)
    const b = r.point(`legR${i}`)
    const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r
    assert.ok(gap > -0.5, `level ${i}: the legs do not overlap (${gap.toFixed(1)} px apart)`)
  }
  const feet = r.point('legL4')
  const otherFoot = r.point('legR4')
  const footGap = Math.hypot(feet.x - otherFoot.x, feet.y - otherFoot.y) - feet.r - otherFoot.r
  assert.ok(footGap > 5, `the legs clearly diverge by the feet (${footGap.toFixed(1)} px apart)`)

  // the hip circle sits a touching distance from the pelvis: circles in a row
  for (const leg of ['legL0', 'legR0']) {
    const link = r.links.find(
      (l) => (l.a === r.indexOf(leg) || l.b === r.indexOf(leg)) && r.points[l.a].part === 'torso',
    )
    assert.ok(link, `${leg} hangs on the pelvis`)
    assert.ok(
      Math.abs(link.rest - (r.point(leg).r + r.point(PELVIS).r)) < 0.5,
      `${leg} sits right against the pelvis (${link.rest.toFixed(1)} px)`,
    )
  }

  // and they are independent limbs: turning one leaves the other alone
  const attitude = (rr, side) => {
    const p1 = rr.point(`${side}0`)
    const p2 = rr.point(`${side}4`)
    const c = rr.point('torso0')
    const d = rr.point(PELVIS)
    const v1 = { x: p2.x - p1.x, y: p2.y - p1.y }
    const v2 = { x: d.x - c.x, y: d.y - c.y }
    return Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y)
  }
  const left0 = attitude(r, 'legL')
  const right0 = attitude(r, 'legR')
  const pivot = r.point('legL0')
  const turn = (40 * Math.PI) / 180
  for (const name of ['legL1', 'legL2', 'legL3', 'legL4']) {
    const p = r.point(name)
    const dx = p.x - pivot.x
    const dy = p.y - pivot.y
    p.x = pivot.x + dx * Math.cos(turn) - dy * Math.sin(turn)
    p.y = pivot.y + dx * Math.sin(turn) + dy * Math.cos(turn)
    p.px = p.x
    p.py = p.y
  }
  run(r, 30, still(NO_GRAVITY))
  const movedLeft = Math.abs(((attitude(r, 'legL') - left0) * 180) / Math.PI)
  const movedRight = Math.abs(((attitude(r, 'legR') - right0) * 180) / Math.PI)
  assert.ok(movedLeft > 20, `the left leg turned (${movedLeft.toFixed(0)} degrees)`)
  assert.ok(movedRight < 8, `and the right one stayed put (${movedRight.toFixed(0)} degrees)`)
})

test('no two circles of the body ever intersect', () => {
  const r = new Ragdoll(2000, 2000)
  assert.ok(r.contacts.length > 20, `the body checks its own circles (${r.contacts.length} pairs)`)

  // squeeze the two legs into each other as hard as they go
  const turn = (pivotName, members, by) => {
    const pivot = r.point(pivotName)
    for (const name of members) {
      const p = r.point(name)
      const dx = p.x - pivot.x
      const dy = p.y - pivot.y
      p.x = pivot.x + dx * Math.cos(by) - dy * Math.sin(by)
      p.y = pivot.y + dx * Math.sin(by) + dy * Math.cos(by)
      p.px = p.x
      p.py = p.y
    }
  }
  turn('legL0', ['legL1', 'legL2', 'legL3', 'legL4'], -0.8)
  turn('legR0', ['legR1', 'legR2', 'legR3', 'legR4'], 0.8)

  let worst = 0
  for (let i = 0; i < 120; i++) {
    run(r, 1, still(NO_GRAVITY))
    for (const [a, b] of r.contacts) {
      const p1 = r.points[a]
      const p2 = r.points[b]
      worst = Math.max(worst, p1.r + p2.r - Math.hypot(p2.x - p1.x, p2.y - p1.y))
    }
  }
  // A forced squeeze is not a gameplay case: what matters is that they cannot
  // pass through one another, and that in flight they never touch (see above).
  assert.ok(worst < 5, `the circles are pushed apart (deepest overlap ${worst.toFixed(2)} px)`)
})

test('the legs stay two legs in flight, without knocking each other about', () => {
  const deepest = (r) => {
    let worst = 0
    for (let a = 0; a < 5; a++) {
      for (let b = 0; b < 5; b++) {
        const p1 = r.point(`legL${a}`)
        const p2 = r.point(`legR${b}`)
        worst = Math.max(worst, p1.r + p2.r - Math.hypot(p2.x - p1.x, p2.y - p1.y))
      }
    }
    return worst
  }

  // A pure ragdoll: the legs must NEVER touch, however hard he tumbles. (The
  // twin contact between the two limbs is what guarantees it, and it is soft so
  // that the hips do not knock each other about.)
  const fly = () => {
    const r = new Ragdoll(ARENA.w / 2, ARENA.h / 2)
    let overlap = 0
    let share = 0
    const frames = 60 * 12
    for (let i = 0; i < frames; i++) {
      run(r, 1, {
        thrustX: Math.cos(i * 0.02) * DEFAULTS.thrust,
        thrustY: Math.sin(i * 0.031) * DEFAULTS.thrust,
        gravity: DEFAULTS.gravity,
      }, ARENA)
      const now = deepest(r)
      if (now > 0.5) share++
      overlap = Math.max(overlap, now)
    }
    return { overlap, share, frames }
  }

  const pure = fly()
  assert.ok(pure.overlap < 0.5, `the legs never touch (worst ${pure.overlap.toFixed(2)} px)`)
  assert.equal(pure.share, 0, `not even for a moment (${pure.share} of ${pure.frames} frames)`)

  // ...and while he just stands there, the hips must not twitch. He stands
  // because the joints hold their angle (the game's default), and that is the
  // state this is about: a settled frame.
  const standing = onFloor()
  standing.setJointGrip(0.25)
  run(standing, 60 * 3, { thrustX: 0, thrustY: 0, gravity: DEFAULTS.gravity }, ARENA)
  const before = standing.points.map((p) => ({ x: p.x, y: p.y }))
  let twitch = 0
  for (let i = 0; i < 60 * 6; i++) {
    run(standing, 1, { thrustX: 0, thrustY: 0, gravity: DEFAULTS.gravity }, ARENA)
    for (const [k, p] of standing.points.entries()) {
      twitch = Math.max(twitch, Math.hypot(p.x - before[k].x, p.y - before[k].y))
      before[k] = { x: p.x, y: p.y }
    }
  }
  assert.ok(twitch < 0.1, `the hips do not knock each other about (worst ${twitch.toFixed(3)} px/frame)`)
})

test('the joint grip holds the frame up and costs nothing in flight', () => {
  const standFor = (grip) => {
    const r = onFloor()
    r.setJointGrip(grip)
    let ticks = 0
    for (let i = 0; i < 60 * 6; i++) {
      run(r, 1, { thrustX: 0, thrustY: 0, gravity: DEFAULTS.gravity }, ARENA)
      if (i % 60 === 59 && ARENA.h - r.head.y > 40) ticks++
    }
    return ticks
  }

  assert.ok(standFor(0) < 5, 'a frame of springs only topples')
  assert.equal(standFor(0.25), 6, 'with the joints holding their angle it stands')

  // The grip holds the pose without slowing the flight
  // down: it holds the pose, it does not push the character back.
  const flight = (grip) => {
    const r = new Ragdoll(ARENA.w / 2, ARENA.h / 2)
    r.setJointGrip(grip)
    const x0 = r.head.x
    for (let i = 0; i < 60 * 3; i++) {
      run(r, 1, { thrustX: DEFAULTS.thrust, thrustY: 0, gravity: 0 }, ARENA)
    }
    return r.head.x - x0
  }
  const loose = flight(0)
  const held = flight(0.25)
  assert.ok(loose > 300, `the frame flies (${loose.toFixed(0)} px)`)
  assert.ok(
    Math.abs(held - loose) / loose < 0.05,
    `and the grip does not hold it back (${held.toFixed(0)} vs ${loose.toFixed(0)} px)`,
  )

  // ...but a hard hit still throws a limb aside: it stays a ragdoll, not a statue
  const bent = (grip) => {
    const r = new Ragdoll(2000, 2000)
    r.setJointGrip(grip)
    const attitude = () => {
      const p1 = r.point('armL0')
      const p2 = r.point('armL3')
      const c = r.point('torso0')
      const d = r.point(PELVIS)
      const v1 = { x: p2.x - p1.x, y: p2.y - p1.y }
      const v2 = { x: d.x - c.x, y: d.y - c.y }
      return Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y)
    }
    const rest = attitude()
    r.point('armL3').px -= 25
    let worst = 0
    for (let i = 0; i < 60; i++) {
      run(r, 1, still(NO_GRAVITY))
      let swing = ((attitude() - rest) * 180) / Math.PI
      while (swing > 180) swing -= 360
      while (swing < -180) swing += 360
      worst = Math.max(worst, Math.abs(swing))
    }
    return worst
  }
  assert.ok(bent(0.25) > 30, `a hard hit still throws the limb aside (${bent(0.25).toFixed(0)} degrees)`)
})

test('gravity pulls the body down; zero gravity does not', () => {
  const falling = new Ragdoll(2000, 2000)
  const y0 = falling.center().y
  run(falling, 30, still(MOON_GRAVITY))
  const fall = falling.center().y - y0
  // 0.5 * g * t^2 for t = 0.5 s -> ~32 px
  assert.ok(fall > 20 && fall < 45, `fell ${fall.toFixed(1)} px in 0.5 s`)

  const floating = new Ragdoll(2000, 2000)
  const fy0 = floating.center().y
  run(floating, 30, still(NO_GRAVITY))
  assert.ok(Math.abs(floating.center().y - fy0) < 0.5, 'stays in place without gravity')
})

test('thrust at the head accelerates the body and rotates it (head leads)', () => {
  const r = new Ragdoll(2000, 2000)
  const head = { ...r.head }
  const pelvis = { ...r.point(PELVIS) }

  run(r, 60, push(900, 0))

  const headDx = r.head.x - head.x
  const pelvisDx = r.point(PELVIS).x - pelvis.x
  assert.ok(headDx > 20, `the body moved right (${headDx.toFixed(1)} px)`)
  assert.ok(headDx > pelvisDx * 1.2, `the head leads the pelvis (${headDx.toFixed(1)} vs ${pelvisDx.toFixed(1)})`)
  assert.ok(r.point('legR4').y !== pelvis.y, 'the body is not just sliding as a rigid block')
})

test('inertia: the body keeps flying after the thrust stops', () => {
  const r = new Ragdoll(2000, 2000)
  run(r, 60, push(900, 0))
  const v1 = r.velocity(DT)

  run(r, 10, still(NO_GRAVITY))
  const v2 = r.velocity(DT)

  const speed1 = Math.hypot(v1.x, v1.y)
  const speed2 = Math.hypot(v2.x, v2.y)
  assert.ok(v1.x > 0, 'moving right while thrusting')
  assert.ok(speed2 > speed1 * 0.85, `keeps most of its speed (${speed1.toFixed(1)} -> ${speed2.toFixed(1)})`)
  assert.ok(v2.x > 0, 'still flying in the same direction')
})

test('the simulation is deterministic (same inputs -> same state)', () => {
  const a = new Ragdoll(2000, 2000)
  const b = new Ragdoll(2000, 2000)
  const input = (i) => push(Math.sin(i * 0.3) * 900, Math.cos(i * 0.21) * 900, MOON_GRAVITY)

  run(a, 120, input)
  run(b, 120, input)

  assert.deepEqual(a.points, b.points, 'every circle matches exactly')
})

test('links stay inside their hard limits while tumbling, even against the walls', () => {
  /* Real arena at normal and full thrust, plus a deliberate stress case.
   * Everything is measured every frame, not just at the end: a momentary
   * overstretch is exactly what the eye notices. */
  const cases = [
    ['arena, normal thrust', ARENA, DEFAULTS.thrust, 0.5],
    ['arena, full thrust', ARENA, 2400, 0.5],
    ['stress: huge field, yanked', FIELD, 1800, 3],
  ]

  for (const [label, bounds, thrust, slack] of cases) {
    const r = new Ragdoll(bounds.w / 2, bounds.h / 2)
    let over = 0
    let under = 0
    let overKind = ''
    for (let i = 0; i < 300; i++) {
      run(r, 1, wiggle(thrust), bounds)
      for (const link of r.drawn) {
        const d = span(r, link)
        if (d - link.max > over) {
          over = d - link.max
          overKind = link.kind
        }
        under = Math.max(under, link.min - d)
      }
    }
    assert.ok(
      over < slack,
      `${label}: nothing stretches past its limit (worst ${over.toFixed(2)} px, ${overKind})`,
    )
    assert.ok(under < slack, `${label}: nothing is squeezed past touching distance (worst ${under.toFixed(2)} px)`)
  }
})

test('the body holds its shape and a limb is bones with a hinge', () => {
  // the body is one solid oval: its links are welded, so it cannot flow
  assert.equal(LINK.compliance.torso, 0, 'the links of the body are rigid')

  const r = new Ragdoll(ARENA.w / 2, ARENA.h / 2)
  const worst = {}
  const slack = {}

  for (let i = 0; i < 300; i++) {
    run(r, 1, wiggle(DEFAULTS.thrust), ARENA)
    for (const link of r.drawn) {
      const rel = (span(r, link) - link.rest) / link.rest
      worst[link.kind] = Math.max(worst[link.kind] ?? 0, rel)
      // how far past its own hard limit a link was pushed, in px
      slack[link.kind] = Math.max(slack[link.kind] ?? 0, span(r, link) - link.max)
    }
  }

  // A limb does NOT stretch any more: it is welded bones that FOLD at one
  // hinge (that is what stopped the legs waving). The give now lives in the
  // joints - where a limb meets the body - and in the hinge itself.
  assert.ok(slack.arm < 0.4, `the arm is a bone, it does not give (${slack.arm.toFixed(2)} px past its limit)`)
  assert.ok(slack.leg < 0.4, `the leg either (${slack.leg.toFixed(2)} px)`)
  assert.ok(worst.torso < 0.08, `the body stays put (torso moved ${(worst.torso * 100).toFixed(2)}% at most)`)
  assert.ok(worst.attach > 0.01, `but where a limb hangs on the body it gives (${(worst.attach * 100).toFixed(2)}%)`)

  // ...and the fold is inside its limit the whole time
  const hinges = r.links.filter((l) => l.kind === 'brace' && l.joint && l.fold !== undefined)
  assert.ok(hinges.length >= 2, 'both limbs have a hinge')
  for (const hinge of hinges) {
    const d = span(r, hinge)
    assert.ok(d >= hinge.min - 0.5, `the hinge never folds past its limit (${d.toFixed(2)} >= ${hinge.min.toFixed(2)})`)
  }
})

test('the substep count changes accuracy, not the feel', () => {
  // Air drag is defined per fixed step, so substepping must not damp the body
  // harder. This guards the bug where drag was applied once per substep and
  // four substeps killed the "space-like" inertia the game is built on.
  const travel = (substeps) => {
    const before = SIM.substeps
    SIM.substeps = substeps
    try {
      const r = new Ragdoll(400, 180)
      const c0 = r.center()
      run(r, 60, push(DEFAULTS.thrust, 0, NO_GRAVITY))
      return r.center().x - c0.x
    } finally {
      SIM.substeps = before
    }
  }

  const one = travel(1)
  const four = travel(4)
  assert.ok(one > 20, `one second of thrust actually moves the body (${one.toFixed(1)} px)`)
  assert.ok(
    Math.abs(one - four) / one < 0.1,
    `travel barely depends on the substep count (1 -> ${one.toFixed(1)} px, 4 -> ${four.toFixed(1)} px)`,
  )
})

test('the character never leaves the arena', () => {
  const bounds = { w: 320, h: 180 }
  const r = new Ragdoll(160, 90)

  // slam it into every wall in turn
  run(r, 200, push(2400, 0), bounds)
  run(r, 200, push(-2400, 0), bounds)
  run(r, 200, push(0, 2400), bounds)
  run(r, 200, push(0, -2400), bounds)

  for (const p of r.points) {
    assert.ok(p.x >= p.r - 0.5 && p.x <= bounds.w - p.r + 0.5, `x inside: ${p.x.toFixed(1)} (r=${p.r})`)
    assert.ok(p.y >= p.r - 0.5 && p.y <= bounds.h - p.r + 0.5, `y inside: ${p.y.toFixed(1)} (r=${p.r})`)
  }
})

test('reaching a wall keeps every circle inside it', () => {
  const r = new Ragdoll(ARENA.w / 2, ARENA.h / 2)
  run(r, 300, push(2400, 0), ARENA)
  const maxX = Math.max(...r.points.map((p) => p.x))
  assert.ok(maxX > ARENA.w - 60, `flew to the right wall (max x ${maxX.toFixed(1)})`)
  for (const p of r.points) {
    assert.ok(p.x <= ARENA.w - p.r + 0.5, `circle of r=${p.r.toFixed(2)} stays inside (x=${p.x.toFixed(1)})`)
  }
})

test('half a minute of hard flight stays finite and in one piece', () => {
  const r = new Ragdoll(ARENA.w / 2, ARENA.h / 2)
  for (let i = 0; i < 30 * 60; i++) run(r, 1, wiggle(2400), ARENA)

  for (const p of r.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'positions stay finite (no NaN)')
    assert.ok(p.x >= p.r - 1 && p.x <= ARENA.w - p.r + 1, `x stays in the arena (${p.x.toFixed(1)})`)
    assert.ok(p.y >= p.r - 1 && p.y <= ARENA.h - p.r + 1, `y stays in the arena (${p.y.toFixed(1)})`)
  }
  for (const link of r.drawn) {
    const d = span(r, link)
    assert.ok(d >= link.min - 1, `link ${link.kind} did not collapse (${d.toFixed(2)} >= ${link.min.toFixed(2)})`)
    assert.ok(d <= link.max + 1, `link ${link.kind} did not run away (${d.toFixed(2)} <= ${link.max.toFixed(2)})`)
  }
})

/** Put a fresh body on the floor: its lowest circle just touches the ground. */
function onFloor() {
  const r = new Ragdoll(ARENA.w / 2, ARENA.h / 2)
  const lowest = Math.max(...r.points.map((p) => p.y + p.r))
  for (const p of r.points) {
    p.y += ARENA.h - lowest
    p.py += ARENA.h - lowest
  }
  return r
}

test('the frame keeps its shape on the floor and does not crumple', () => {
  const r = onFloor()
  const start = ARENA.h - r.head.y
  const heights = []
  for (let i = 0; i < 60 * 5; i++) {
    run(r, 1, { thrustX: 0, thrustY: 0, gravity: DEFAULTS.gravity }, ARENA)
    if (i % 60 === 59) heights.push(ARENA.h - r.head.y)
  }
  // A passive frame on its feet is an inverted pendulum: its equilibrium is
  // unstable, so it may topple - but it must not fold up into a heap, and the
  // body must stay in one piece.
  assert.ok(
    heights.every((h) => h > 4),
    `the frame never crumples into the floor (${heights.map((h) => h.toFixed(0)).join(', ')} vs start ${start.toFixed(0)})`,
  )
  for (const link of r.drawn) {
    const d = span(r, link)
    assert.ok(d >= link.min - 1 && d <= link.max + 1, `${link.kind} link stayed within its limits`)
  }
})

test('the default thrust lifts the frame off the floor', () => {
  const r = onFloor()
  const start = ARENA.h - r.head.y
  for (let i = 0; i < 60; i++) {
    run(r, 1, { thrustX: 0, thrustY: -DEFAULTS.thrust, gravity: DEFAULTS.gravity }, ARENA)
  }
  const climbed = ARENA.h - r.head.y - start
  assert.ok(climbed > 20, `one second of thrust lifts it by ${climbed.toFixed(0)} px`)
})

test('proportions: a long body, real limbs, and a head worth aiming at', () => {
  const r = new Ragdoll(2000, 2000)
  const height = Math.hypot(r.point('legL4').x - r.head.x, r.point('legL4').y - r.head.y)
  assert.ok(height > 60 && height < 140, `the body is ${height.toFixed(1)} px tall on screen scale`)

  const torso = Math.hypot(r.point('torso0').x - r.point(PELVIS).x, r.point('torso0').y - r.point(PELVIS).y)
  const arm = Math.hypot(r.point('armL0').x - r.point('armL3').x, r.point('armL0').y - r.point('armL3').y)
  const leg = Math.hypot(r.point('legL0').x - r.point('legL4').x, r.point('legL0').y - r.point('legL4').y)
  assert.ok(arm > torso * 0.55, `the arms are long enough (${arm.toFixed(1)} vs torso ${torso.toFixed(1)})`)
  assert.ok(leg > torso * 0.7, `the legs are long enough (${leg.toFixed(1)} vs torso ${torso.toFixed(1)})`)

  // the head is a bigger circle than the body, yet still a small target
  assert.ok(r.head.r > r.point('torso2').r * 1.5, 'the head is a bigger circle')
  assert.ok(r.head.r < torso * 0.35, `the head is small next to the body (${r.head.r.toFixed(1)} vs ${torso.toFixed(1)})`)
})
