// Shared helpers for the test suite.
//
// The tests run on Node's built-in test runner (`node --test`) and import the
// TypeScript sources directly: Node strips the types and `tests/loader.mjs`
// teaches it to resolve the extensionless relative imports. No bundler, no
// extra dependencies.
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let loaderRegistered = false
function registerLoader() {
  if (loaderRegistered) return
  loaderRegistered = true
  register('./loader.mjs', import.meta.url)
}

/**
 * Import source modules. Paths are given as Vite-style absolute paths
 * ('/src/scenes/helloWorld.ts') relative to the project root.
 */
export async function loadModules(paths) {
  registerLoader()
  const mods = {}
  for (const p of paths) {
    const url = new URL(`..${p}`, import.meta.url)
    mods[p] = await import(url.href)
  }
  return { mods, close: async () => {} }
}

/* ------------------------------------------------------------------ *
 *  Recording canvas context
 * ------------------------------------------------------------------ */
export function mockCtx() {
  const calls = []
  let path = []
  const state = {
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px monospace',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
  }

  const gradient = (type, args) => {
    const stops = []
    return {
      kind: 'gradient',
      type,
      args,
      stops,
      addColorStop: (offset, color) => stops.push([offset, color]),
    }
  }

  const ctx = {
    setTransform: (...a) => calls.push({ op: 'setTransform', args: a }),
    save: () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
    translate: (x, y) => calls.push({ op: 'translate', args: [x, y] }),
    fillRect: (...a) => calls.push({ op: 'fillRect', args: a, style: state.fillStyle }),
    strokeRect: (...a) =>
      calls.push({ op: 'strokeRect', args: a, style: state.strokeStyle, width: state.lineWidth }),
    beginPath: () => {
      path = []
    },
    moveTo: (x, y) => path.push(['M', x, y]),
    lineTo: (x, y) => path.push(['L', x, y]),
    stroke: () =>
      calls.push({
        op: 'stroke',
        style: state.strokeStyle,
        width: state.lineWidth,
        path: [...path],
      }),
    fill: () => calls.push({ op: 'fill', style: state.fillStyle, path: [...path] }),
    fillText: (text, x, y) =>
      calls.push({ op: 'fillText', text, args: [x, y], style: state.fillStyle }),
    createLinearGradient: (...a) => gradient('linear', a),
    createRadialGradient: (...a) => gradient('radial', a),
  }

  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (v) => {
        state[key] = v
      },
    })
  }

  return { ctx, calls }
}

/* ------------------------------------------------------------------ *
 *  Reading back what the scene drew
 * ------------------------------------------------------------------ */
export const strokes = (calls) => calls.filter((c) => c.op === 'stroke')

/** All strokes that are a single straight segment. */
export const segments = (calls) =>
  strokes(calls)
    .filter((s) => s.path.length === 2 && s.path[0][0] === 'M' && s.path[1][0] === 'L')
    .map((s) => ({
      style: s.style,
      width: s.width,
      x0: s.path[0][1],
      y0: s.path[0][2],
      x1: s.path[1][1],
      y1: s.path[1][2],
    }))

const isVertical = (s) => s.x0 === s.x1 && s.y0 === 0 && s.y1 === 180
const isHorizontal = (s) => s.y0 === s.y1 && s.x0 === 0 && s.x1 === 320

/** Screen x positions of full-height vertical lines (transverse levels). */
export const verticalPositions = (calls) => [
  ...new Set(segments(calls).filter(isVertical).map((s) => s.x0)),
].sort((a, b) => a - b)

/** Screen y positions of full-width horizontal lines (transverse levels). */
export const horizontalPositions = (calls) => [
  ...new Set(segments(calls).filter(isHorizontal).map((s) => s.y0)),
].sort((a, b) => a - b)

/** Diagonal strokes = the axial "rails" (two strokes per rail: halo + core). */
export const railSegments = (calls) =>
  segments(calls).filter((s) => !isVertical(s) && !isHorizontal(s))

/** World position of the label, taken from its fillText call. */
export function labelWorld(calls) {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.op === 'fillText' && c.text === 'Hello, World!') {
      return { x: c.args[0], y: c.args[1] + 5 }
    }
  }
  return null
}

/** Camera offset implied by the world->screen translate before the label. */
export function cameraOffset(calls) {
  let labelIndex = -1
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.op === 'fillText' && c.text === 'Hello, World!') {
      labelIndex = i
      break
    }
  }
  for (let i = labelIndex; i >= 0; i--) {
    if (calls[i].op === 'translate') {
      return { camX: -calls[i].args[0], camY: -calls[i].args[1] }
    }
  }
  return null
}

/** FPS number from the HUD line ("fps 60  16.4 ms"). */
export const hudFps = (calls) => {
  for (const c of calls) {
    if (c.op === 'fillText' && typeof c.text === 'string' && c.text.startsWith('fps ')) {
      const m = /^fps (\d+)/.exec(c.text)
      return m ? Number(m[1]) : null
    }
  }
  return null
}

/** Frame time in ms from the HUD line ("fps 60  16.4 ms"). */
export const hudFrameMs = (calls) => {
  for (const c of calls) {
    if (c.op === 'fillText' && typeof c.text === 'string' && c.text.startsWith('fps ')) {
      const m = /([0-9.]+) ms/.exec(c.text)
      return m ? Number(m[1]) : null
    }
  }
  return null
}

/** The profiler breakdown line, if drawn. */
export const hudProfile = (calls) => {
  for (const c of calls) {
    if (c.op === 'fillText' && typeof c.text === 'string' && c.text.startsWith('upd ')) {
      const m = /^upd ([0-9.]+) ms · draw ([0-9.]+) ms$/.exec(c.text)
      return m ? { update: Number(m[1]), draw: Number(m[2]) } : null
    }
  }
  return null
}

/** Numeric alpha out of an `hsla(h,s%,l%,a)` string. */
export function alphaOf(style) {
  const m = /hsla\([^)]*,\s*([0-9.]+)\)$/.exec(String(style))
  return m ? Number(m[1]) : null
}

/* ------------------------------------------------------------------ *
 *  Stubs for the browser environment
 * ------------------------------------------------------------------ */
export function makeInput(pressed = {}) {
  const set = new Set(
    Object.entries(pressed)
      .filter(([, on]) => on)
      .map(([name]) => name),
  )
  return {
    isDown: (code) =>
      set.has(
        { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[code] ?? '?',
      ),
    axis: (neg, pos) => {
      const negName = { ArrowLeft: 'left', ArrowUp: 'up' }[neg]
      const posName = { ArrowRight: 'right', ArrowDown: 'down' }[pos]
      return (set.has(posName) ? 1 : 0) - (set.has(negName) ? 1 : 0)
    },
  }
}

export function makeElement(tag = 'div', props = {}) {
  const listeners = new Map()
  const classes = new Set()
  const el = {
    tagName: tag.toUpperCase(),
    value: '',
    checked: false,
    textContent: '',
    style: {},
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type) ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    dispatch: (type, event = {}) => {
      const ev = { type, target: el, ...event }
      for (const fn of listeners.get(type) ?? []) fn(ev)
      return ev
    },
    appendChild: (child) => {
      el.children.push(child)
      return child
    },
    focus: () => {
      globalThis.document.activeElement = el
    },
    blur: () => {
      if (globalThis.document.activeElement === el) globalThis.document.activeElement = globalThis.document.body
    },
    ...props,
  }
  return el
}

/**
 * Installs fake `window` / `document` / rAF / canvas on globalThis.
 * Returns handles used by the tests to drive frames and fire events.
 */
export function installDom({ width = 1000, height = 600 } = {}) {
  const canvas = makeElement('canvas')
  const ctxMock = mockCtx()
  canvas.getContext = () => ctxMock.ctx

  const elements = {
    '#game': canvas,
    '#admin-toggle': makeElement('button', { textContent: '⚙' }),
    '#admin-panel': makeElement('div'),
    '#s-speed': makeElement('input', { value: '120' }),
    '#o-speed': makeElement('output'),
    '#s-auto': makeElement('input', { type: 'checkbox', checked: false }),
    '#s-color': makeElement('input', { value: '1' }),
    '#o-color': makeElement('output'),
    '#s-size': makeElement('input', { value: '3' }),
    '#o-size': makeElement('output'),
    '#s-cell': makeElement('input', { value: '120' }),
    '#o-cell': makeElement('output'),
    '#s-grid': makeElement('input', { type: 'checkbox', checked: true }),
    '#s-quality': makeElement('input', { type: 'checkbox', checked: true }),
    '#s-profiler': makeElement('input', { type: 'checkbox', checked: false }),
  }
  elements['#admin-panel'].classList.add('hidden')

  const windowListeners = new Map()
  const viewer = {
    innerWidth: width,
    innerHeight: height,
    addEventListener: (type, fn) => {
      if (!windowListeners.has(type)) windowListeners.set(type, [])
      windowListeners.get(type).push(fn)
    },
    removeEventListener: () => {},
    dispatch: (type, event = {}) => {
      for (const fn of windowListeners.get(type) ?? []) fn({ type, ...event })
    },
    setSize: (w, h) => {
      viewer.innerWidth = w
      viewer.innerHeight = h
    },
  }

  const document = {
    body: makeElement('body'),
    activeElement: null,
    querySelector: (sel) => elements[sel] ?? null,
    createElement: (tag) => makeElement(tag),
    addEventListener: () => {},
  }
  document.activeElement = document.body

  const raf = { pending: new Map(), nextId: 1, cancelled: [] }
  globalThis.window = viewer
  globalThis.document = document
  globalThis.requestAnimationFrame = (cb) => {
    const id = raf.nextId++
    raf.pending.set(id, cb)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    raf.cancelled.push(id)
    raf.pending.delete(id)
  }

  /** Runs the most recently scheduled (still pending) animation frame. */
  const runFrame = (timeMs) => {
    const entries = [...raf.pending.entries()]
    if (entries.length === 0) throw new Error('no frame scheduled')
    const [id, cb] = entries[entries.length - 1]
    raf.pending.delete(id)
    cb(timeMs)
  }

  return { canvas, ctx: ctxMock.ctx, calls: ctxMock.calls, elements, window: viewer, document, raf, runFrame }
}
