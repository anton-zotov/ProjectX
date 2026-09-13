import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alphaOf,
  cameraOffset,
  horizontalPositions,
  hudFps,
  hudFrameMs,
  hudProfile,
  labelWorld,
  loadModules,
  makeInput,
  mockCtx,
  railSegments,
  strokes,
  verticalPositions,
} from './helpers.mjs'

const SCENE = '/src/scenes/helloWorld.ts'
const { mods, close } = await loadModules([SCENE])
const { HelloWorldScene, defaultSettings } = mods[SCENE]
test.after(close)

/** Scene + recording context + frame stepping. */
function makeScene(patch = {}) {
  const settings = { ...defaultSettings(), ...patch }
  const scene = new HelloWorldScene(settings)
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
    /** update + render, returns the draw calls of this frame */
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

const lastLabel = (calls) => labelWorld(calls)

/** Comparable form of a stroke style (gradients are objects). */
const styleKey = (style) =>
  style && style.kind === 'gradient' ? JSON.stringify(style.stops) : String(style)

test('default settings are the documented ones', () => {
  assert.deepEqual(defaultSettings(), {
    speed: 120,
    autoMove: false,
    colorSpeed: 1,
    fieldScreens: 3,
    cell: 120,
    showGrid: true,
    profiler: false,
  })
})

test('field is exactly fieldScreens x 3/8 screens, and the label bounces inside it', () => {
  for (const fieldScreens of [2, 3, 6]) {
    const expectedW = fieldScreens * 320
    const expectedH = expectedW * (3 / 8)

    // drifting on its own, the label must reach both far walls ...
    const s = makeScene({ fieldScreens, speed: 400, autoMove: true })
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < 900; i++) {
      const pos = lastLabel(s.frame())
      maxX = Math.max(maxX, pos.x)
      maxY = Math.max(maxY, pos.y)
    }
    assert.equal(maxX, expectedW - 80, `right wall for ${fieldScreens} screens`)
    assert.equal(maxY, expectedH, `bottom wall for ${fieldScreens} screens`)

    // ... and then bounce back off them
    assert.ok(lastLabel(s.calls).x < maxX - 20, 'label travelled back from the right wall')
    assert.ok(lastLabel(s.calls).y < maxY - 20, 'label travelled back from the bottom wall')
  }
})

test('camera is centred on the label and may look beyond the field edges', () => {
  const s = makeScene({ speed: 400 })
  let calls = s.frame()
  let cam = cameraOffset(calls)
  assert.equal(cam.camX, 480 - 160)
  assert.equal(cam.camY, 180 - 90)

  // drive into the top-left corner: the camera goes negative (past the edges)
  s.input({ left: true, up: true })
  for (let i = 0; i < 400; i++) calls = s.frame()
  const pos = lastLabel(calls)
  cam = cameraOffset(calls)
  assert.equal(pos.x, 0)
  assert.equal(pos.y, 12)
  assert.equal(cam.camX, -160)
  assert.equal(cam.camY, -78)

  // and it always stays exactly centred on the label (no clamping)
  s.input({ right: true })
  for (let i = 0; i < 20; i++) calls = s.frame()
  assert.equal(cameraOffset(calls).camX, lastLabel(calls).x - 160)
})

test('movement speed scales linearly with the setting', () => {
  const slow = makeScene({ speed: 60 })
  const fast = makeScene({ speed: 240 })
  slow.input({ right: true })
  fast.input({ right: true })

  const startSlow = lastLabel(slow.frame()).x
  const startFast = lastLabel(fast.frame()).x
  for (let i = 0; i < 10; i++) {
    slow.frame()
    fast.frame()
  }
  const dSlow = lastLabel(slow.calls).x - startSlow
  const dFast = lastLabel(fast.calls).x - startFast

  assert.ok(Math.abs(dSlow - (60 * 10) / 60) < 1e-9, `slow moved ${dSlow}`)
  assert.ok(Math.abs(dFast - (240 * 10) / 60) < 1e-9, `fast moved ${dFast}`)
  assert.ok(Math.abs(dFast / dSlow - 4) < 1e-9)
})

test('auto-move uses the current speed, keeps its direction, and stays off by default', () => {
  const idle = makeScene()
  const before = lastLabel(idle.frame()).x
  for (let i = 0; i < 10; i++) idle.frame()
  assert.equal(lastLabel(idle.calls).x, before, 'no motion without arrows when autoMove is off')

  const auto = makeScene({ autoMove: true, speed: 120 })
  const p0 = lastLabel(auto.frame())
  const p1 = lastLabel(auto.frame())
  const d1 = { x: p1.x - p0.x, y: p1.y - p0.y }
  const len1 = Math.hypot(d1.x, d1.y)
  assert.ok(Math.abs(len1 - 120 / 60) < 1e-9, `step length ${len1}`)

  // change the speed on the fly: the drift must follow it
  auto.settings.speed = 60
  const p2 = lastLabel(auto.frame())
  const d2 = { x: p2.x - p1.x, y: p2.y - p1.y }
  const len2 = Math.hypot(d2.x, d2.y)
  assert.ok(Math.abs(len2 - 60 / 60) < 1e-9, `step length after change ${len2}`)
  assert.ok(Math.abs(d2.x / len2 - d1.x / len1) < 1e-9, 'direction is preserved')
  assert.ok(Math.abs(d2.y / len2 - d1.y / len1) < 1e-9, 'direction is preserved (y)')
})

test('colour flow: 0 freezes the hues, >0 animates them', () => {
  const frozen = makeScene({ colorSpeed: 0 })
  const first = frozen.render().filter((c) => c.op === 'stroke').map((c) => styleKey(c.style))
  const second = frozen.render().filter((c) => c.op === 'stroke').map((c) => styleKey(c.style))
  assert.deepEqual(second, first, 'colours must not change while colour speed is 0')

  const flowing = makeScene({ colorSpeed: 1 })
  const a = flowing.render().filter((c) => c.op === 'stroke').map((c) => styleKey(c.style))
  flowing.update(1 / 60)
  const b = flowing.render().filter((c) => c.op === 'stroke').map((c) => styleKey(c.style))
  assert.notDeepEqual(b, a, 'colours must drift over time')
})

test('the 3D grid can be switched off', () => {
  const on = makeScene({ showGrid: true }).frame()
  const off = makeScene({ showGrid: false }).frame()

  const gradients = (calls) => calls.filter((c) => c.op === 'stroke' && c.style?.kind === 'gradient')
  assert.ok(gradients(on).length > 0, 'rails are gradients when the grid is on')
  assert.equal(gradients(off).length, 0, 'no 3D lattice when the grid is off')
  assert.ok(strokes(on).length > strokes(off).length * 2, 'grid adds many lines')

  // the arena frame, HUD and label survive the toggle
  const texts = off.filter((c) => c.op === 'fillText').map((c) => c.text)
  assert.ok(texts.includes('Hello, World!'))
  assert.ok(texts.includes('arrow keys to move'))
})

test('transverse lines never stack on top of each other (dedupe threshold)', () => {
  const s = makeScene()
  const calls = s.frame()
  const gaps = (list) => list.slice(1).map((v, i) => v - list[i])

  const vs = verticalPositions(calls)
  const hs = horizontalPositions(calls)
  assert.ok(vs.length > 2 && hs.length > 2, 'both orientations are drawn')
  for (const g of gaps(vs)) assert.ok(g >= 1.3 - 1e-9, `vertical gap ${g}`)
  for (const g of gaps(hs)) assert.ok(g >= 1.3 - 1e-9, `horizontal gap ${g}`)
})

test('axial rails are drawn, stay inside the fade window, and fade with distance', () => {
  const s = makeScene()
  const rails = railSegments(s.frame())
  assert.ok(rails.length > 0, 'rails exist')

  const offscreen = (r) => Math.max(0, -r.x0, r.x0 - 320, -r.y0, r.y0 - 180)
  // each rail is painted twice: halo (up to 0.16) and core (up to 0.42)
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

test('the HUD reports the measured fps and the frame time', () => {
  const s = makeScene()
  for (let i = 0; i < 31; i++) s.update(1 / 60) // ~0.5 s of frames
  const calls = s.render()
  const fps = hudFps(calls)
  assert.ok(fps !== null, 'fps text is drawn')
  assert.ok(Math.abs(fps - 60) <= 1, `fps reported as ${fps}`)

  const ms = hudFrameMs(calls)
  assert.ok(ms !== null && ms >= 0, `frame time reported as ${ms}`)
})

test('the profiler breakdown is drawn only when enabled', () => {
  const off = makeScene({ profiler: false })
  assert.equal(hudProfile(off.render()), null, 'no breakdown by default')

  const on = makeScene({ profiler: true })
  const profile = hudProfile(on.render())
  assert.ok(profile, 'breakdown line is drawn')
  assert.ok(profile.update >= 0 && profile.draw >= 0, 'both timings are numbers')
})

test('settings changed at runtime are picked up on the next frame', () => {
  const s = makeScene({ speed: 400 })
  s.input({ right: true })
  for (let i = 0; i < 300; i++) s.frame()
  assert.equal(lastLabel(s.calls).x, 880, 'clamped to the 3-screen field')

  // grow the field: the label is no longer at the wall and can travel on
  s.settings.fieldScreens = 6
  const p = lastLabel(s.frame()).x
  for (let i = 0; i < 10; i++) s.frame()
  const expected = p + (400 * 10) / 60
  const actual = lastLabel(s.calls).x
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`)
})

test('cell size setting changes the lattice density', () => {
  const dense = verticalPositions(makeScene({ cell: 60 }).frame())
  const sparse = verticalPositions(makeScene({ cell: 240 }).frame())
  const medianGap = (list) => {
    const gaps = list.slice(1).map((v, i) => v - list[i])
    gaps.sort((a, b) => a - b)
    return gaps[Math.floor(gaps.length / 2)]
  }

  assert.ok(sparse.length < dense.length, `fewer lines with bigger cells: ${sparse.length} < ${dense.length}`)
  assert.ok(
    medianGap(sparse) > medianGap(dense) * 1.5,
    `gaps grow with cell size: ${medianGap(dense)} -> ${medianGap(sparse)}`,
  )
})
