// Engine + admin-panel tests. They share one fake browser environment, so
// they live in a single file (see tests/helpers.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { installDom, labelWorld, loadModules, hudProfile, strokes, verticalPositions } from './helpers.mjs'

const dom = installDom({ width: 1000, height: 600 })

const ENGINE = '/src/engine.ts'
const { mods, close } = await loadModules([ENGINE, '/src/main.ts'])
const { Engine } = mods[ENGINE]
test.after(close)

function fakeScene() {
  const seen = { updates: [], renders: [] }
  return {
    seen,
    update(dt, game) {
      seen.updates.push({ dt, game })
    },
    render(game) {
      seen.renders.push(game)
    },
  }
}

/* ------------------------------------------------------------------ *
 *  Engine
 * ------------------------------------------------------------------ */

/** Creates an engine and guarantees it is stopped even if a test fails, so a
 *  stray queued frame can never leak into the admin-panel tests below. */
function engineFor(t, options = {}) {
  const scene = fakeScene()
  const engine = new Engine(dom.canvas, scene, options)
  t.after(() => engine.stop())
  return { scene, engine }
}

test('the canvas is allocated at BUFFER_SCALE and scaled to the window (aspect kept)', (t) => {
  engineFor(t, { width: 320, height: 180 })

  assert.equal(dom.canvas.width, 640, 'internal buffer is 2x for smoother lines')
  assert.equal(dom.canvas.height, 360)
  assert.equal(dom.canvas.style.width, '1000px', 'width matches the window exactly')
  assert.equal(dom.canvas.style.height, '562.5px', 'height follows the 16:9 virtual screen')
})

test('render quality can be lowered to the virtual resolution at runtime', (t) => {
  const { engine } = engineFor(t, { width: 320, height: 180 })
  const t0 = performance.now()
  engine.start()

  engine.setBufferScale(1)
  assert.equal(dom.canvas.width, 320, '1x buffer is 4x cheaper to rasterise')
  assert.equal(dom.canvas.height, 180)
  assert.equal(dom.canvas.style.width, '1000px', 'the on-screen size does not change')

  dom.calls.length = 0
  dom.runFrame(t0 + 16)
  assert.deepEqual(
    dom.calls.find((c) => c.op === 'setTransform')?.args,
    [1, 0, 0, 1, 0, 0],
    'the frame is rendered at 1x',
  )

  engine.setBufferScale(2)
  assert.equal(dom.canvas.width, 640)
  dom.calls.length = 0
  dom.runFrame(t0 + 32)
  assert.deepEqual(
    dom.calls.find((c) => c.op === 'setTransform')?.args,
    [2, 0, 0, 2, 0, 0],
    'back to 2x',
  )

  // clamps to sane values
  engine.setBufferScale(0)
  assert.equal(dom.canvas.width, 320)
  engine.setBufferScale(2)
})

test('default virtual resolution is 320x180', (t) => {
  const { scene, engine } = engineFor(t)
  engine.start()
  dom.runFrame(performance.now() + 16)
  assert.equal(scene.seen.updates[0].game.width, 320)
  assert.equal(scene.seen.updates[0].game.height, 180)
})

test('every frame sets the buffer transform and passes the context to the scene', (t) => {
  const { scene, engine } = engineFor(t, { width: 320, height: 180 })
  const t0 = performance.now()
  engine.start()

  dom.calls.length = 0
  dom.runFrame(t0 + 16.7)

  assert.equal(scene.seen.updates.length, 1)
  assert.equal(scene.seen.renders.length, 1)
  const { dt, game } = scene.seen.updates[0]
  assert.ok(Math.abs(dt - 0.0167) < 5e-4, `dt was ${dt}`)
  assert.equal(game.ctx, dom.ctx)
  assert.equal(game.input, scene.seen.renders[0].input)

  const transform = dom.calls.find((c) => c.op === 'setTransform')
  assert.deepEqual(transform?.args, [2, 0, 0, 2, 0, 0])
})

test('a long pause (tab switch) is clamped so the label cannot teleport', (t) => {
  const { scene, engine } = engineFor(t, { width: 320, height: 180 })
  const t0 = performance.now()
  engine.start()

  dom.runFrame(t0 + 16)
  dom.runFrame(t0 + 5016) // 5 second gap
  assert.equal(scene.seen.updates[1].dt, 0.1, 'dt is clamped to 100 ms')
})

test('resizing the window re-fits the canvas', (t) => {
  engineFor(t, { width: 320, height: 180 })

  dom.window.setSize(800, 800)
  dom.window.dispatch('resize')
  // scale = min(800/320, 800/180) = 2.5 -> 800 x 450
  assert.equal(dom.canvas.style.width, '800px')
  assert.equal(dom.canvas.style.height, '450px')

  dom.window.setSize(1000, 600)
  dom.window.dispatch('resize')
})

test('stop() cancels the loop and setScene() swaps the scene', (t) => {
  const { scene: first, engine } = engineFor(t, { width: 320, height: 180 })
  const second = fakeScene()

  engine.start()
  dom.runFrame(performance.now() + 16)
  engine.stop()
  assert.ok(dom.raf.cancelled.length > 0, 'the pending frame was cancelled')

  engine.setScene(second)
  engine.start()
  dom.runFrame(performance.now() + 32)
  assert.equal(second.seen.updates.length, 1)
  assert.equal(first.seen.updates.length, 1, 'the old scene is no longer updated')
})

/* ------------------------------------------------------------------ *
 *  Admin panel (main.ts). The module runs on import, so the fake DOM above
 *  is already in place; its engine drives the canvas we record.
 * ------------------------------------------------------------------ */
const el = (sel) => dom.elements[sel]

let now = performance.now()
function frame() {
  now += 1000 / 60
  dom.runFrame(now)
}
function frames(n) {
  for (let i = 0; i < n; i++) frame()
}
const draw = () => {
  dom.calls.length = 0
  frame()
  if (!labelWorld(dom.calls)) {
    throw new Error('the game scene did not render - a stale engine frame is queued')
  }
  return dom.calls
}
const gradients = (calls) => calls.filter((c) => c.op === 'stroke' && c.style?.kind === 'gradient')
const label = (calls) => labelWorld(calls)
const hold = (code) => dom.window.dispatch('keydown', { code })
const releaseKeys = () => {
  hold('ArrowRight') // (no-op if already released)
  dom.window.dispatch('keyup', { code: 'ArrowRight' })
  dom.window.dispatch('keyup', { code: 'ArrowLeft' })
}
const setSlider = (sel, value) => {
  el(sel).value = value
  el(sel).dispatch('input')
}

test('admin panel', async (t) => {
  await t.test('outputs start from the default settings', () => {
    assert.equal(el('#o-speed').textContent, '120')
    assert.equal(el('#o-color').textContent, '1.0')
    assert.equal(el('#o-size').textContent, '3 × 2')
    assert.equal(el('#o-cell').textContent, '120')
    assert.equal(el('#admin-panel').classList.contains('hidden'), true)
  })

  await t.test('arrow keys drive the label, the speed slider rescales it', () => {
    releaseKeys()
    setSlider('#s-speed', '120')
    hold('ArrowRight')

    const start = label(draw()).x
    frames(10)
    const slow = label(dom.calls).x - start
    assert.ok(Math.abs(slow - 20) < 1e-6, `120 px/s for 10 frames = 20 px, got ${slow}`)

    setSlider('#s-speed', '360')
    assert.equal(el('#o-speed').textContent, '360')

    const start2 = label(draw()).x
    frames(10)
    const fast = label(dom.calls).x - start2
    assert.ok(Math.abs(fast - 60) < 1e-6, `360 px/s for 10 frames = 60 px, got ${fast}`)
    releaseKeys()
  })

  await t.test('colour and field-size sliders update settings and outputs', () => {
    releaseKeys()
    setSlider('#s-color', '2.5')
    assert.equal(el('#o-color').textContent, '2.5')

    setSlider('#s-size', '6')
    assert.equal(el('#o-size').textContent, '6 × 4')

    // the field really grew: the label can now travel past the old wall
    setSlider('#s-speed', '360')
    hold('ArrowRight')
    frames(200)
    releaseKeys()
    assert.ok(label(dom.calls).x > 960, `label at ${label(dom.calls).x} should pass the 3-screen wall`)
  })

  await t.test('cell size slider changes the lattice density', () => {
    releaseKeys()
    setSlider('#s-size', '3')
    setSlider('#s-cell', '120')
    const count = () => verticalPositions(draw()).length
    const dense = count()

    setSlider('#s-cell', '300')
    assert.equal(el('#o-cell').textContent, '300')
    const sparse = count()

    assert.ok(sparse < dense, `bigger cells mean fewer lines: ${dense} -> ${sparse}`)
  })

  await t.test('auto-move checkbox starts and stops the drift', () => {
    releaseKeys()
    setSlider('#s-speed', '120')

    // park the label against the left wall (deterministic starting point)
    hold('ArrowLeft')
    frames(600) // 120 px/s for 10 s = 1200 px, more than the widest field
    releaseKeys()
    const before = label(draw()).x
    assert.equal(before, 0, 'label parked at the left wall')

    frames(10)
    assert.equal(label(dom.calls).x, before, 'no drift while unchecked')

    el('#s-auto').checked = true
    el('#s-auto').dispatch('change')
    frames(10)
    assert.ok(label(dom.calls).x > before, 'drift starts when checked')

    el('#s-auto').checked = false
    el('#s-auto').dispatch('change')
    const parked = label(draw()).x
    frames(10)
    assert.equal(label(dom.calls).x, parked, 'drift stops when unchecked')
  })

  await t.test('grid checkbox switches the 3D lattice off and on', () => {
    el('#s-grid').checked = false
    el('#s-grid').dispatch('change')
    const off = draw()
    assert.equal(gradients(off).length, 0)
    const offStrokes = strokes(off).length

    el('#s-grid').checked = true
    el('#s-grid').dispatch('change')
    const on = draw()
    assert.ok(gradients(on).length > 0)
    assert.ok(strokes(on).length > offStrokes * 2)
  })

  await t.test('quality checkbox switches the render buffer between 2x and 1x', () => {
    assert.equal(dom.canvas.width, 640, 'starts smooth')
    el('#s-quality').checked = false
    el('#s-quality').dispatch('change')
    assert.equal(dom.canvas.width, 320, 'unchecked renders at the virtual resolution')
    assert.equal(dom.canvas.height, 180)

    el('#s-quality').checked = true
    el('#s-quality').dispatch('change')
    assert.equal(dom.canvas.width, 640, 'checked restores the 2x buffer')
  })

  await t.test('profiler checkbox adds the frame-time breakdown to the HUD', () => {
    assert.equal(hudProfile(draw()), null, 'no breakdown by default')

    el('#s-profiler').checked = true
    el('#s-profiler').dispatch('change')
    const profile = hudProfile(draw())
    assert.ok(profile, 'breakdown appears')
    assert.ok(profile.draw >= 0 && profile.update >= 0)

    el('#s-profiler').checked = false
    el('#s-profiler').dispatch('change')
    assert.equal(hudProfile(draw()), null, 'breakdown disappears again')
  })

  await t.test('editing a control hands the keyboard back to the game', () => {
    el('#s-speed').focus()
    assert.equal(dom.document.activeElement, el('#s-speed'))
    el('#admin-panel').dispatch('change')
    assert.equal(dom.document.activeElement, dom.document.body, 'focus returns to the page')

    // while dragging with the mouse the focus is kept ...
    el('#admin-panel').dispatch('pointerdown')
    el('#s-color').focus()
    el('#admin-panel').dispatch('input')
    assert.equal(dom.document.activeElement, el('#s-color'))
    // ... and released as soon as the drag ends
    el('#admin-panel').dispatch('pointerup')
    assert.equal(dom.document.activeElement, dom.document.body)
  })

  await t.test('the ⚙ button collapses and expands the panel', () => {
    el('#admin-toggle').dispatch('click')
    assert.equal(el('#admin-panel').classList.contains('hidden'), false)
    assert.equal(el('#admin-toggle').textContent, '✕')

    el('#admin-toggle').dispatch('click')
    assert.equal(el('#admin-panel').classList.contains('hidden'), true)
    assert.equal(el('#admin-toggle').textContent, '⚙')
  })
})
