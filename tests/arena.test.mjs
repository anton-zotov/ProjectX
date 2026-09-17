import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alphaOf,
  cameraOffset,
  fills,
  horizontalPositions,
  hudFps,
  hudFrameMs,
  hudProfile,
  loadModules,
  makeInput,
  mockCtx,
  railSegments,
  segments,
  strokes,
  verticalPositions,
} from './helpers.mjs'

const ARENA = '/src/scenes/arena.ts'
const RAGDOLL = '/src/game/ragdoll.ts'
const { mods, close } = await loadModules([ARENA, RAGDOLL])
const { ArenaScene, defaultSettings } = mods[ARENA]
const { POINT_NAMES } = mods[RAGDOLL]
test.after(close)

/* look constants of the character (mirrors src/scenes/arena.ts) */
const BODY_COLOR = '#ffffff'
/** Colour the circles get while the tuning view is on. */
const SKELETON_COLOR = '#9aa4ad'

function makeScene(patch = {}) {
  const settings = { ...defaultSettings(), ...patch }
  const scene = new ArenaScene(settings)
  const { ctx, calls } = mockCtx()
  const game = { ctx, input: makeInput(), width: 320, height: 180 }
  return {
    settings,
    scene,
    calls,
    game,
    input(pressed) {
      game.input = makeInput(pressed)
    },
    /** update + render, returns this frame's draw calls */
    frame(dt = 1 / 60) {
      calls.length = 0
      scene.update(dt, game)
      scene.render(game)
      return calls
    },
    update(dt = 1 / 60) {
      scene.update(dt, game)
    },
    render() {
      calls.length = 0
      scene.render(game)
      return calls
    },
  }
}

const gradients = (calls) => calls.filter((c) => c.op === 'stroke' && c.style?.kind === 'gradient')

test('default settings are the documented ones', () => {
  assert.deepEqual(defaultSettings(), {
    thrust: 1900,
    gravity: 180,
    autoPilot: false,
    colorSpeed: 1,
    fieldScreens: 3,
    cell: 120,
    showGrid: true,
    profiler: false,
    bodyScale: 0.85,
    showSkeleton: true,
    elasticity: 1,
    stance: 0,
    jointGrip: 0.25,
  })
})

test('the camera is centred on the character head', () => {
  const s = makeScene()
  s.frame()
  assert.equal(s.scene.camX, s.scene.ragdoll.head.x - 160)
  assert.equal(s.scene.camY, s.scene.ragdoll.head.y - 90)

  // even when the body is thrown across the field
  s.input({ right: true })
  for (let i = 0; i < 120; i++) s.frame()
  assert.equal(s.scene.camX, s.scene.ragdoll.head.x - 160)
  assert.equal(s.scene.camY, s.scene.ragdoll.head.y - 90)

  // the camera may look beyond the arena edges (free camera)
  s.input({})
  s.settings.autoPilot = false
  s.settings.thrust = 2400
  s.settings.gravity = 0 // fly freely, so the floor friction cannot slow it down
  s.input({ left: true })
  let minCamX = Infinity
  for (let i = 0; i < 600; i++) {
    s.frame()
    minCamX = Math.min(minCamX, s.scene.camX)
  }
  assert.ok(minCamX < 0, `camera went past the left edge (min ${minCamX.toFixed(1)})`)
})

test('the field is fieldScreens x 3/8 screens and contains the character', () => {
  for (const fieldScreens of [2, 3, 6]) {
    // Nothing that holds the character back here: this is about the field and
    // its walls, and both the stance and the joint grip deliberately hold him.
    // (The grip is about holding a pose, not about the field.)
    const s = makeScene({ fieldScreens, autoPilot: false, gravity: 0, thrust: 1900, stance: 0, jointGrip: 0 })
    assert.equal(s.scene.worldW, fieldScreens * 320)
    assert.equal(s.scene.worldH, fieldScreens * 320 * (3 / 8))

    s.input({ right: true, down: true })
    // the character bounces off the walls, so track how far it ever got
    let maxX = 0
    let maxY = 0
    for (let i = 0; i < 900; i++) {
      s.frame()
      for (const p of s.scene.ragdoll.points) {
        assert.ok(p.x >= 0 && p.x <= s.scene.worldW, `x inside for ${fieldScreens} screens`)
        assert.ok(p.y >= 0 && p.y <= s.scene.worldH, `y inside for ${fieldScreens} screens`)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
      }
    }
    s.input({})

    assert.ok(maxX > s.scene.worldW - 60, `reached the right wall (${maxX.toFixed(0)})`)
    assert.ok(maxY > s.scene.worldH - 60, `reached the bottom wall (${maxY.toFixed(0)})`)
  }
})

test('the simulation runs on a fixed step and is deterministic', () => {
  const a = makeScene({ gravity: 200 })
  const b = makeScene({ gravity: 200 })
  for (let i = 0; i < 150; i++) {
    a.frame()
    b.frame()
  }
  assert.deepEqual(a.scene.ragdoll.points, b.scene.ragdoll.points, 'identical after 150 frames')

  // a long pause is clamped: no teleporting after a tab switch
  const c = makeScene({ gravity: 0, autoPilot: false, thrust: 2400 })
  c.input({ right: true })
  const x0 = c.scene.ragdoll.head.x
  c.update(5) // five seconds in one frame
  const jump = c.scene.ragdoll.head.x - x0
  assert.ok(jump < 60, `a single huge frame cannot teleport the body (${jump.toFixed(1)} px)`)
})

test('thrust setting scales the acceleration', () => {
  const measure = (thrust) => {
    const s = makeScene({ thrust, gravity: 0, autoPilot: false })
    s.input({ right: true })
    const x0 = s.scene.ragdoll.head.x
    for (let i = 0; i < 60; i++) s.frame()
    return s.scene.ragdoll.head.x - x0
  }
  const slow = measure(200)
  const fast = measure(2000)
  assert.ok(slow > 1, `slow thrust moves the body (${slow.toFixed(2)} px)`)
  assert.ok(fast > slow * 3, `ten times the thrust moves much further (${slow.toFixed(1)} -> ${fast.toFixed(1)})`)
})

test('gravity setting changes the fall, zero gravity keeps it afloat', () => {
  const fall = (gravity) => {
    // a big field, so the body never reaches the floor while measuring
    const s = makeScene({ gravity, autoPilot: false, thrust: 200, fieldScreens: 6 })
    const y0 = s.scene.ragdoll.head.y
    for (let i = 0; i < 30; i++) s.frame()
    return s.scene.ragdoll.head.y - y0
  }
  const none = fall(0)
  const moon = fall(260)
  const heavy = fall(1200)
  assert.ok(Math.abs(none) < 1, `no fall without gravity (${none.toFixed(2)})`)
  assert.ok(moon > 10, `falls with the default gravity (${moon.toFixed(1)})`)
  assert.ok(heavy > moon * 2, `stronger gravity falls faster (${moon.toFixed(1)} -> ${heavy.toFixed(1)})`)
})

test('the character is drawn as a solid body (head, torso, limbs) under the camera', () => {
  const s = makeScene({ autoPilot: false, showSkeleton: false })
  const calls = s.frame()

  const headFills = fills(calls).filter((c) => c.style === BODY_COLOR)
  assert.ok(headFills.length >= 1, 'the head is filled')
  assert.ok(
    headFills.some((c) => c.path.some((op) => op[0] === 'A')),
    'the head is a circle',
  )

  // The body is drawn as capsules between linked circles, plus the circles
  // themselves. Every capsule must lie ON a real link: nothing is drawn that
  // is not part of the skeleton, and nothing in the middle of a limb.
  const r = s.scene.ragdoll
  const whiteSegments = segments(calls).filter((c) => c.style === BODY_COLOR)
  assert.equal(whiteSegments.length, r.drawn.length, 'every drawn link becomes one capsule')

  const onLink = (x, y, p1, p2) => {
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : ((x - p1.x) * dx + (y - p1.y) * dy) / len2
    if (t < -0.01 || t > 1.01) return false
    return Math.hypot(x - (p1.x + dx * t), y - (p1.y + dy * t)) < 0.02
  }
  for (const seg of whiteSegments) {
    const ok = r.drawn.some(
      (l) =>
        onLink(seg.x0, seg.y0, r.points[l.a], r.points[l.b]) &&
        onLink(seg.x1, seg.y1, r.points[l.a], r.points[l.b]),
    )
    assert.ok(
      ok,
      `the capsule (${seg.x0.toFixed(1)},${seg.y0.toFixed(1)}) -> (${seg.x1.toFixed(1)},${seg.y1.toFixed(1)}) lies on a real link`,
    )
  }

  // the neck capsule stops at the edge of the head, otherwise the head would
  // be drawn as a circle with a square stuck into it (looks like an oval)
  const head = r.head
  const neckCut = whiteSegments.some(
    (seg) => Math.abs(Math.hypot(seg.x0 - head.x, seg.y0 - head.y) - head.r) < 0.02,
  )
  assert.ok(neckCut, 'the capsule into the head stops at its edge')

  const circleFills = fills(calls).filter(
    (c) => c.style === BODY_COLOR && c.path.some((op) => op[0] === 'A'),
  )
  assert.equal(circleFills.length, r.points.length, 'every circle of the skeleton is filled')

  // head: a round, bigger circle
  const headRadius = circleFills
    .map((c) => c.path.find((op) => op[0] === 'A'))
    .map((op) => op[3])
    .reduce((a, b) => Math.max(a, b), 0)
  assert.ok(Math.abs(headRadius - r.head.r) < 1e-6, `the head is drawn with its own radius (${headRadius})`)
  assert.ok(headRadius > r.point('torso2').r, 'and it is bigger than a body circle')

  // no outline pass any more: the old dark colour must not appear at all
  const oldOutline = 'rgba(24,16,10,0.9)'
  assert.equal(
    strokes(calls).filter((c) => c.style === oldOutline).length,
    0,
    'the body has no dark outline',
  )

  // not even eyes: the head is the only filled shape of the character
  assert.ok(
    fills(calls).every((c) => c.style === BODY_COLOR),
    'the body is one solid colour',
  )

  const cam = cameraOffset(calls)
  assert.ok(cam, 'the body is drawn in world space under the camera')
  assert.equal(cam.camX, s.scene.camX, 'and the camera matches the scene')
  assert.equal(cam.camY, s.scene.camY)
})

test('the tuning view paints the circles of the skeleton over the body', () => {
  const on = makeScene({ autoPilot: false, showSkeleton: true }).frame()
  const off = makeScene({ autoPilot: false, showSkeleton: false }).frame()

  const skeletonFills = (calls) => fills(calls).filter((c) => c.style === SKELETON_COLOR)
  assert.equal(skeletonFills(off).length, 0, 'the tuning view is off by default in that scene')
  assert.equal(skeletonFills(on).length, 24, 'one painted circle per skeleton circle')

  // the capsules are painted first, the circles on top of them
  const firstCircle = on.findIndex((c) => c.op === 'fill' && c.style === SKELETON_COLOR)
  const lastCapsule = on.reduce((last, c, i) => (c.op === 'stroke' && c.style === BODY_COLOR ? i : last), -1)
  assert.ok(firstCircle > lastCapsule, 'the circles are painted after the capsules that hide them')

  // switching the view off leaves a single solid colour
  assert.ok(
    fills(off).every((c) => c.style === BODY_COLOR),
    'without the tuning view the body is one colour',
  )
})

test('the HUD reports fps, frame time and the hint', () => {
  const s = makeScene()
  for (let i = 0; i < 31; i++) s.update(1 / 60) // ~0.5 s
  const calls = s.render()

  const fps = hudFps(calls)
  assert.ok(fps !== null && Math.abs(fps - 60) <= 1, `fps reported as ${fps}`)
  assert.ok(hudFrameMs(calls) !== null, 'frame time is shown')
  assert.equal(hudProfile(calls), null, 'no breakdown by default')
  assert.ok(
    calls.some((c) => c.op === 'fillText' && c.text === 'стрелки — тяга'),
    'control hint is drawn',
  )

  const prof = makeScene({ profiler: true })
  assert.ok(hudProfile(prof.render()), 'breakdown appears when enabled')
})

test('the 3D grid can be switched off', () => {
  const on = makeScene({ showGrid: true }).frame()
  const off = makeScene({ showGrid: false }).frame()

  assert.ok(gradients(on).length > 0, 'rails are gradients when the grid is on')
  assert.equal(gradients(off).length, 0, 'no 3D lattice when the grid is off')
  assert.ok(strokes(on).length > strokes(off).length * 2, 'the grid adds many lines')
})

test('transverse lines never stack on top of each other (dedupe threshold)', () => {
  const calls = makeScene().frame()
  const gaps = (list) => list.slice(1).map((v, i) => v - list[i])

  const vs = verticalPositions(calls)
  const hs = horizontalPositions(calls)
  assert.ok(vs.length > 2 && hs.length > 2, 'both orientations are drawn')
  for (const g of gaps(vs)) assert.ok(g >= 1.3 - 1e-9, `vertical gap ${g}`)
  for (const g of gaps(hs)) assert.ok(g >= 1.3 - 1e-9, `horizontal gap ${g}`)
})

test('axial rails stay inside the fade window and fade with distance', () => {
  const rails = railSegments(makeScene().frame())
  assert.ok(rails.length > 0, 'rails exist')

  const offscreen = (r) => Math.max(0, -r.x0, r.x0 - 320, -r.y0, r.y0 - 180)
  let fullyVisible = 0
  let faded = 0
  for (const r of rails) {
    assert.ok(offscreen(r) <= 540 + 1e-6, `rail starts beyond the fade window: ${offscreen(r)}`)
    const alpha = alphaOf(r.style.stops[0][1])
    assert.ok(alpha > 0 && alpha <= 0.42 + 1e-9, `rail alpha ${alpha}`)
    if (alpha === 0.42) fullyVisible++
    else if (alpha < 0.16) faded++
  }
  assert.ok(fullyVisible > 0, 'some rails are fully visible')
  assert.ok(faded > 0, 'some rails sit partly outside the screen and are faded')
})

test('changing the field size at runtime keeps the character inside', () => {
  const s = makeScene({ autoPilot: false, gravity: 0, thrust: 2400 })
  s.input({ right: true })
  for (let i = 0; i < 300; i++) s.frame()

  s.settings.fieldScreens = 6
  for (let i = 0; i < 60; i++) s.frame()
  assert.equal(s.scene.worldW, 1920)
  for (const p of s.scene.ragdoll.points) {
    assert.ok(p.x >= 0 && p.x <= 1920, `inside the grown field (${p.x})`)
  }
})

test('respawn puts the character back in the middle, at rest', () => {
  const s = makeScene({ gravity: 0, autoPilot: false, thrust: 2400 })
  s.input({ right: true })
  for (let i = 0; i < 120; i++) s.frame()
  assert.ok(s.scene.ragdoll.head.x > s.scene.worldW / 2 + 50, 'moved away from the centre')

  s.input({})
  s.scene.respawn()
  assert.equal(s.scene.ragdoll.head.x, s.scene.worldW / 2)
  assert.equal(s.scene.ragdoll.head.y, s.scene.worldH / 2)
  const v = s.scene.ragdoll.velocity()
  assert.ok(Math.hypot(v.x, v.y) < 1e-9, 'spawned at rest')
})
