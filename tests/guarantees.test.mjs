/**
 * THE GUARANTEE SUITE.
 *
 * These are not tests of how the character feels - that is what we are building
 * and rebuilding, and any number in it changes with every experiment. These are
 * the things that must hold WHATEVER we do to the skeleton: the foundations of
 * the engine and the two rules of the project.
 *
 * Everything that measures the current tuning (stance, flight distance, leg
 * spread, how far a knee bends, how elastic a link is) lives in `devtools/` as
 * a measuring tool and is NOT run here: those are observations, not guarantees.
 *
 * Rule of thumb when adding something here: would a broken result be a BUG, or
 * merely a different tuning? Only the first kind belongs in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModules, mockCtx, makeInput } from './helpers.mjs'

const RAGDOLL = '/src/game/ragdoll.ts'
const CONFIG = '/src/game/config.ts'
const ARENA = '/src/scenes/arena.ts'
const { mods, close } = await loadModules([RAGDOLL, CONFIG, ARENA])
const { Ragdoll, POINT_NAMES } = mods[RAGDOLL]
const { SIM, DEFAULTS } = mods[CONFIG]
const { ArenaScene, defaultSettings } = mods[ARENA]
test.after(close)

const DT = SIM.dt
/** A field far away from the body: tests about the frame, not the walls. */
const FIELD = { w: 4000, h: 4000 }
const run = (r, steps, input, bounds = FIELD) => {
  for (let i = 0; i < steps; i++) r.step(DT, typeof input === 'function' ? input(i) : input, bounds)
}
const idle = { thrustX: 0, thrustY: 0, gravity: DEFAULTS.gravity }
/** A player hammering the stick: this is what a fight looks like. */
const fight = (i) => ({
  thrustX: Math.cos(i * 0.02) * DEFAULTS.thrust,
  thrustY: Math.sin(i * 0.031) * DEFAULTS.thrust * 1.3,
  gravity: DEFAULTS.gravity,
})

const finite = (r) => r.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))

/* ------------------------------------------------------------------ *
 *  1. The engine does not lie: same input, same result.
 * ------------------------------------------------------------------ */

test('GUARANTEE: the simulation is deterministic', () => {
  const play = () => {
    const r = new Ragdoll(500, 200)
    run(r, 240, fight)
    return r.points.map((p) => [p.x, p.y])
  }
  assert.deepEqual(play(), play(), 'two identical runs must give identical numbers')
})

/* ------------------------------------------------------------------ *
 *  2. It never explodes, however hard it is thrown about.
 * ------------------------------------------------------------------ */

test('GUARANTEE: half a minute of hard flight stays finite and in one piece', () => {
  const r = new Ragdoll(500, 200)
  let worstLink = 0
  for (let i = 0; i < 60 * 30; i++) {
    run(r, 1, fight)
    assert.ok(finite(r), `the frame went non-finite at frame ${i}`)
    for (const link of r.links) {
      const p1 = r.points[link.a]
      const p2 = r.points[link.b]
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      // a link may give a little past its limit, but never turn into a rope
      worstLink = Math.max(worstLink, d / link.rest)
    }
  }
  assert.ok(worstLink < 2.5, `no link stretched into a rope (worst ${worstLink.toFixed(2)}x)`)
})

/* ------------------------------------------------------------------ *
 *  3. The arena holds the body: no circle escapes the field.
 * ------------------------------------------------------------------ */

test('GUARANTEE: no circle ever leaves the arena', () => {
  const bounds = { w: 960, h: 360 }
  const r = new Ragdoll(bounds.w / 2, bounds.h / 2)
  for (let i = 0; i < 60 * 20; i++) {
    run(r, 1, fight, bounds)
    for (const p of r.points) {
      assert.ok(
        p.x - p.r > -1 && p.x + p.r < bounds.w + 1 && p.y - p.r > -1 && p.y + p.r < bounds.h + 1,
        `a circle left the field: ${p.part} at ${p.x.toFixed(0)},${p.y.toFixed(0)}`,
      )
    }
  }
})

/* ------------------------------------------------------------------ *
 *  4. The skeleton holds: linked circles stay links, not knots.
 * ------------------------------------------------------------------ */

test('GUARANTEE: circles joined by a link never sink into each other', () => {
  const r = new Ragdoll(500, 200)
  // Only the links that CARRY the body promise this. The attitude links of a
  // joint are angles, not distance floors: they may let their circles come
  // closer than touching (that is how a limb folds at all).
  const carriers = new Set(
    r.links
      .filter((l) => l.kind !== 'brace' && l.kind !== 'pose' && l.kind !== 'hinge')
      .map((l) => (l.a < l.b ? `${l.a}-${l.b}` : `${l.b}-${l.a}`)),
  )
  let deepest = 0
  for (let i = 0; i < 60 * 10; i++) {
    run(r, 1, fight)
    for (let a = 0; a < r.points.length; a++) {
      for (let b = a + 1; b < r.points.length; b++) {
        if (!carriers.has(`${a}-${b}`)) continue
        const p1 = r.points[a]
        const p2 = r.points[b]
        deepest = Math.max(deepest, p1.r + p2.r - Math.hypot(p2.x - p1.x, p2.y - p1.y))
      }
    }
  }
  // The hard floor of such a link is the touching distance. A solver with a
  // finite number of iterations overshoots it under a hard load (and the other
  // links pressing on the same circles add to it), but it must stay a small
  // fraction of a circle - not turn into two circles sharing the same spot.
  assert.ok(
    deepest < 3.5,
    `the links that carry the body kept their circles apart (deepest ${deepest.toFixed(2)} px of ${(2 * r.points[0].r).toFixed(0)} px)`,
  )
})

/* ------------------------------------------------------------------ *
 *  5. A bone is straight and a joint stays inside its own limit.
 * ------------------------------------------------------------------ */

test('GUARANTEE: bones stay straight', () => {
  const r = new Ragdoll(500, 200)
  let worst = 0
  for (let i = 0; i < 60 * 10; i++) {
    run(r, 1, fight)
    for (const bone of r.boneSpans()) {
      if (bone.length < 3) continue
      const first = r.points[bone[0]]
      const last = r.points[bone[bone.length - 1]]
      for (const index of bone.slice(1, -1)) {
        const p = r.points[index]
        const dx = last.x - first.x
        const dy = last.y - first.y
        const len = Math.hypot(dx, dy) || 1
        // distance of the middle circle from the straight line first->last
        worst = Math.max(worst, Math.abs((p.x - first.x) * dy - (p.y - first.y) * dx) / len)
      }
    }
  }
  assert.ok(worst < 1.5, `a bone never bowed (worst ${worst.toFixed(2)} px off its own axis)`)
})

/* ------------------------------------------------------------------ *
 *  6. RULE OF THE PROJECT: the physics does not know where the floor is.
 * ------------------------------------------------------------------ */

test('GUARANTEE: the physics does not know where the floor is', () => {
  // The very same frame in the same arena, once with its feet 10 px above the
  // floor and once 520 px above it, with no contact in either case. Every
  // mechanism (gravity, drag, links, bones, joints) has to behave identically -
  // otherwise some part of the physics is reading the environment.
  const scenario = (gap) => {
    const bounds = { w: 4000, h: 700 }
    const r = new Ragdoll(500, 350)
    const lowest = Math.max(...r.points.map((p) => p.y + p.r))
    const shift = bounds.h - gap - lowest
    for (const p of r.points) {
      p.y += shift
      p.py += shift
    }
    r.setJointGrip(0.25)
    let closest = Infinity
    for (let i = 0; i < 120; i++) {
      run(r, 1, { thrustX: DEFAULTS.thrust * 0.25, thrustY: -DEFAULTS.thrust * 0.1, gravity: 0 })
      closest = Math.min(closest, bounds.h - Math.max(...r.points.map((p) => p.y + p.r)))
    }
    const centre = r.center()
    return {
      rel: r.points.map((p) => [p.x - centre.x, p.y - centre.y]),
      closest,
    }
  }
  const near = scenario(10)
  const far = scenario(520)
  // the floor must never have been touched in either run: this is a fair test
  assert.ok(near.closest > 0.5, `the near run stayed off the floor (closest ${near.closest.toFixed(1)} px)`)
  assert.ok(far.closest > 450, `the far run had the floor far below (closest ${far.closest.toFixed(0)} px)`)
  let worst = 0
  for (const [i, [x, y]] of near.rel.entries()) {
    worst = Math.max(worst, Math.hypot(x - far.rel[i][0], y - far.rel[i][1]))
  }
  assert.ok(worst < 1e-6, `the same scenario gives the same frame at any height (worst ${worst.toExponential(1)} px)`)
})

/* ------------------------------------------------------------------ *
 *  7. RULE OF THE PROJECT: one mechanism, so all limbs are built alike.
 * ------------------------------------------------------------------ */

test('GUARANTEE: every limb is built by the same rule', () => {
  // A limb is data (where it hangs, where it folds), never a branch of the
  // solver. So an arm and a leg must come out of the builder with the same
  // SHAPE of construction, whatever the numbers are.
  const r = new Ragdoll(500, 200)
  const census = (prefix) => {
    const mine = new Set(POINT_NAMES.map((n, i) => [n, i]).filter(([n]) => n.startsWith(prefix)).map(([, i]) => i))
    const links = r.links.filter((l) => mine.has(l.a) && mine.has(l.b))
    return {
      circles: mine.size,
      bones: r.boneSpans().filter((span) => mine.has(span[0])).length,
      // the link that can FOLD is the joint (elbow/knee); how it is labelled is
      // an implementation detail, that it exists and is alone is the guarantee
      folds: links.filter((l) => l.joint && l.fold !== undefined && l.fold < 0.9).length,
      welded: links.filter((l) => l.compliance === 0 && l.stretch === 1).length,
    }
  }
  const arm = census('armL')
  const leg = census('legL')
  assert.equal(arm.bones, 2, 'an arm is two bones')
  assert.equal(leg.bones, 2, 'a leg is two bones')
  assert.equal(arm.folds, 1, 'an arm folds in exactly one place (the elbow)')
  assert.equal(leg.folds, 1, 'a leg folds in exactly one place (the knee)')
  assert.ok(arm.welded >= arm.circles - 1, 'every link inside an arm is welded')
  assert.ok(leg.welded >= leg.circles - 1, 'and every link inside a leg')
})

/* ------------------------------------------------------------------ *
 *  8. The game starts, and the panel is usable.
 * ------------------------------------------------------------------ */

test('GUARANTEE: the scene renders a frame from the default settings', () => {
  const scene = new ArenaScene({ ...defaultSettings(), autoPilot: false })
  const { ctx, calls } = mockCtx()
  const game = { ctx, input: makeInput({ right: true }), width: 320, height: 180 }
  for (let i = 0; i < 5; i++) scene.update(1 / 60, game)
  scene.render(game)
  assert.ok(calls.length > 50, 'the scene drew something')
  assert.ok(finite(scene.ragdoll), 'and the character is made of real numbers')
})

test('GUARANTEE: every control of the admin panel is wired to something', () => {
  // Cheap and stable: the panel and the code that reads it must not drift
  // apart (a slider nobody listens to, a readout nobody updates).
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const ids = [...html.matchAll(/id="(s-[a-z]+)"/g)].map((m) => m[1])
  assert.ok(ids.length >= 8, `the panel has its controls (${ids.length} found)`)
  for (const id of ids) {
    assert.ok(main.includes(`#${id}`), `${id} is read by the code`)
    if (!/checkbox/.test(html.slice(html.indexOf(`id="${id}"`), html.indexOf(`id="${id}"`) + 120))) {
      const out = `#o-${id.slice(2)}`
      assert.ok(html.includes(`id="${out.slice(1)}"`), `${id} shows its value (${out})`)
      assert.ok(main.includes(out), `${out} is updated by the code`)
    }
  }
})
