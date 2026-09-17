// Engine + admin-panel tests. They share one fake browser environment, so
// they live in a single file (see tests/helpers.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hudFps,
  hudProfile,
  installDom,
  loadModules,
  strokes,
  verticalPositions,
} from './helpers.mjs'

const dom = installDom({ width: 1000, height: 600 })

const ENGINE = '/src/engine.ts'
const { mods, close } = await loadModules([ENGINE, '/src/main.ts'])
const { Engine } = mods[ENGINE]
test.after(close)

/** The running game, exposed by main.ts as a debug hook. */
const game = () => globalThis.__projectx
const scene = () => game().scene

function fakeScene() {
  const seen = { updates: [], renders: [] }
  return {
    seen,
    update(dt, g) {
      seen.updates.push({ dt, game: g })
    },
    render(g) {
      seen.renders.push(g)
    },
  }
}

/* ------------------------------------------------------------------ *
 *  Engine
 * ------------------------------------------------------------------ */

/** Creates an engine and guarantees it is stopped even if a test fails, so a
 *  stray queued frame can never leak into the admin-panel tests below. */
function engineFor(t, options = {}) {
  const s = fakeScene()
  const engine = new Engine(dom.canvas, s, options)
  t.after(() => engine.stop())
  return { scene: s, engine }
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

  engine.setBufferScale(0)
  assert.equal(dom.canvas.width, 320, 'clamps to sane values')
  engine.setBufferScale(2)
})

test('default virtual resolution is 320x180', (t) => {
  const { scene: s, engine } = engineFor(t)
  engine.start()
  dom.runFrame(performance.now() + 16)
  assert.equal(s.seen.updates[0].game.width, 320)
  assert.equal(s.seen.updates[0].game.height, 180)
})

test('every frame sets the buffer transform and passes the context to the scene', (t) => {
  const { scene: s, engine } = engineFor(t, { width: 320, height: 180 })
  const t0 = performance.now()
  engine.start()

  dom.calls.length = 0
  dom.runFrame(t0 + 16.7)

  assert.equal(s.seen.updates.length, 1)
  assert.equal(s.seen.renders.length, 1)
  const { dt, game: ctxGame } = s.seen.updates[0]
  assert.ok(Math.abs(dt - 0.0167) < 5e-4, `dt was ${dt}`)
  assert.equal(ctxGame.ctx, dom.ctx)
  assert.equal(ctxGame.input, s.seen.renders[0].input)

  const transform = dom.calls.find((c) => c.op === 'setTransform')
  assert.deepEqual(transform?.args, [2, 0, 0, 2, 0, 0])
})

test('a long pause (tab switch) is clamped so the character cannot teleport', (t) => {
  const { scene: s, engine } = engineFor(t, { width: 320, height: 180 })
  const t0 = performance.now()
  engine.start()

  dom.runFrame(t0 + 16)
  dom.runFrame(t0 + 5016) // 5 second gap
  assert.equal(s.seen.updates[1].dt, 0.1, 'dt is clamped to 100 ms')
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
  if (hudFps(dom.calls) === null) {
    throw new Error('the arena did not render - a stale engine frame is queued')
  }
  return dom.calls
}

const gradients = (calls) => calls.filter((c) => c.op === 'stroke' && c.style?.kind === 'gradient')
const head = () => scene().ragdoll.head
const hold = (code) => dom.window.dispatch('keydown', { code })
const releaseKeys = () => {
  hold('ArrowRight') // (no-op if already released)
  for (const code of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
    dom.window.dispatch('keyup', { code })
  }
}
const setSlider = (sel, value) => {
  el(sel).value = value
  el(sel).dispatch('input')
}
const setCheckbox = (sel, checked) => {
  el(sel).checked = checked
  el(sel).dispatch('change')
}
/** Manual control, no demo autopilot, fresh body at the field centre. */
function manual(gravity = '0', thrust = '1900') {
  releaseKeys()
  setCheckbox('#s-auto', false)
  setSlider('#s-gravity', gravity)
  setSlider('#s-thrust', thrust)
  scene().respawn()
}

test('admin panel', async (t) => {
  await t.test('outputs start from the default settings', () => {
    assert.equal(el('#o-thrust').textContent, '1900')
    assert.equal(el('#o-elastic').textContent, '100 %')
    assert.equal(el('#o-stance').textContent, '0 %')
    assert.equal(el('#o-grip').textContent, '25 %')
    assert.equal(el('#o-gravity').textContent, '180')
    assert.equal(el('#o-color').textContent, '1.0')
    assert.equal(el('#o-size').textContent, '3 × 2')
    assert.equal(el('#o-cell').textContent, '120')
    assert.equal(el('#o-body').textContent, '85 %')
    assert.equal(el('#admin-panel').classList.contains('hidden'), true)
  })

  await t.test('arrow keys are the thrust vector, the slider scales it', () => {
    manual('0', '600')
    const x0 = head().x
    hold('ArrowRight')
    frames(60)
    releaseKeys()
    const low = head().x - x0
    assert.ok(low > 5, `thrust moves the body (${low.toFixed(1)} px)`)

    setSlider('#s-thrust', '1800')
    const x1 = head().x
    hold('ArrowRight')
    frames(60)
    releaseKeys()
    const high = head().x - x1
    assert.ok(high > low * 2, `tripling the thrust moves much further (${low.toFixed(1)} -> ${high.toFixed(1)})`)
  })

  await t.test('gravity slider changes the fall', () => {
    manual('0', '200')
    const y0 = head().y
    frames(60)
    const none = head().y - y0
    assert.ok(Math.abs(none) < 1, `no fall without gravity (${none.toFixed(2)})`)

    setSlider('#s-gravity', '1000')
    const y1 = head().y
    frames(30)
    const strong = head().y - y1
    assert.ok(strong > 5, `falls with gravity (${strong.toFixed(1)})`)
  })

  await t.test('auto-pilot checkbox starts and stops the demo flight', () => {
    manual('0', '900')
    const p0 = { x: head().x, y: head().y }
    frames(60)
    const idle = Math.hypot(head().x - p0.x, head().y - p0.y)
    assert.ok(idle < 1, `no motion while idle (${idle.toFixed(2)} px)`)

    setCheckbox('#s-auto', true)
    frames(60)
    const flown = Math.hypot(head().x - p0.x, head().y - p0.y)
    assert.ok(flown > 5, `autopilot flies the ragdoll (${flown.toFixed(1)} px)`)

    setCheckbox('#s-auto', false)
  })

  await t.test('colour and field-size sliders update settings and outputs', () => {
    setSlider('#s-color', '2.5')
    assert.equal(el('#o-color').textContent, '2.5')

    setSlider('#s-size', '6')
    assert.equal(el('#o-size').textContent, '6 × 4')
    draw() // let the scene pick the new settings up
    assert.equal(scene().worldW, 1920, 'the field really grew')

    setSlider('#s-size', '3')
    draw()
    assert.equal(scene().worldW, 960)
  })

  await t.test('cell size slider changes the lattice density', () => {
    setSlider('#s-size', '3')
    setSlider('#s-cell', '120')
    const count = () => verticalPositions(draw()).length
    const dense = count()

    setSlider('#s-cell', '300')
    assert.equal(el('#o-cell').textContent, '300')
    const sparse = count()

    assert.ok(sparse < dense, `bigger cells mean fewer lines: ${dense} -> ${sparse}`)
    setSlider('#s-cell', '120')
  })

  await t.test('grid checkbox switches the 3D lattice off and on', () => {
    setCheckbox('#s-grid', false)
    const off = draw()
    assert.equal(gradients(off).length, 0)
    const offStrokes = strokes(off).length

    setCheckbox('#s-grid', true)
    const on = draw()
    assert.ok(gradients(on).length > 0)
    assert.ok(strokes(on).length > offStrokes * 2)
  })

  await t.test('quality checkbox switches the render buffer between 2x and 1x', () => {
    assert.equal(dom.canvas.width, 640, 'starts smooth')
    setCheckbox('#s-quality', false)
    assert.equal(dom.canvas.width, 320, 'unchecked renders at the virtual resolution')
    assert.equal(dom.canvas.height, 180)

    setCheckbox('#s-quality', true)
    assert.equal(dom.canvas.width, 640, 'checked restores the 2x buffer')
  })

  await t.test('profiler checkbox adds the frame-time breakdown to the HUD', () => {
    assert.equal(hudProfile(draw()), null, 'no breakdown by default')

    setCheckbox('#s-profiler', true)
    const profile = hudProfile(draw())
    assert.ok(profile, 'breakdown appears')
    assert.ok(profile.draw >= 0 && profile.update >= 0)

    setCheckbox('#s-profiler', false)
    assert.equal(hudProfile(draw()), null, 'breakdown disappears again')
  })

  await t.test('editing a control hands the keyboard back to the game', () => {
    el('#s-thrust').focus()
    assert.equal(dom.document.activeElement, el('#s-thrust'))
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
