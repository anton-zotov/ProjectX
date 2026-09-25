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
    closePath: () => path.push(['Z']),
    arc: (x, y, r, a0, a1) => path.push(['A', x, y, r, a0, a1]),
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
    '#s-thrust': makeElement('input', { value: '1900' }),
    '#o-thrust': makeElement('output'),
    '#s-elastic': makeElement('input', { value: '1' }),
    '#o-elastic': makeElement('output'),
    '#s-grip': makeElement('input', { value: '0.25' }),
    '#o-grip': makeElement('output'),
    '#s-gravity': makeElement('input', { value: '180' }),
    '#o-gravity': makeElement('output'),
    '#s-auto': makeElement('input', { type: 'checkbox', checked: false }),
    '#s-color': makeElement('input', { value: '1' }),
    '#o-color': makeElement('output'),
    '#s-size': makeElement('input', { value: '3' }),
    '#o-size': makeElement('output'),
    '#s-cell': makeElement('input', { value: '120' }),
    '#o-cell': makeElement('output'),
    '#s-body': makeElement('input', { value: '0.85' }),
    '#o-body': makeElement('output'),
    '#s-grid': makeElement('input', { type: 'checkbox', checked: true }),
    '#s-tuning': makeElement('input', { type: 'checkbox', checked: true }),
    '#s-skeleton': makeElement('input', { type: 'checkbox', checked: true }),
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
