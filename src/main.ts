import './style.css'
import { Engine } from './engine'
import { ArenaScene, defaultSettings, type GameSettings } from './scenes/arena'

const canvas = document.querySelector<HTMLCanvasElement>('#game')!

const settings: GameSettings = defaultSettings()
const scene = new ArenaScene(settings)

const engine = new Engine(canvas, scene, {
  width: 320,
  height: 180,
})

setupAdminPanel(settings, engine)
engine.start()

// Debug hook: handy in the browser console and for the tests.
;(globalThis as unknown as Record<string, unknown>)['__projectx'] = { settings, scene, engine }

/* ------------------------------------------------------------------ *
 *  Collapsible admin panel
 * ------------------------------------------------------------------ */

/** Return focus to the page so arrow keys control the game again. */
function blurActive(): void {
  const el = document.activeElement
  if (el && el !== document.body && 'blur' in el) (el as HTMLElement).blur()
}

function setupAdminPanel(s: GameSettings, engine: Engine): void {
  const toggle = document.querySelector<HTMLButtonElement>('#admin-toggle')!
  const panel = document.querySelector<HTMLDivElement>('#admin-panel')!

  // while the user drags a slider with the mouse we keep focus on it;
  // as soon as they stop interacting (or use the keyboard) we release it
  let pointerDown = false
  panel.addEventListener('pointerdown', () => {
    pointerDown = true
  })
  const releasePointer = (): void => {
    pointerDown = false
    blurActive()
  }
  panel.addEventListener('pointerup', releasePointer)
  panel.addEventListener('pointercancel', releasePointer)

  // any committed change (checkbox, slider release, keyboard step)
  // moves the focus back to the page -> arrows play the game afterwards
  for (const type of ['input', 'change', 'click'] as const) {
    panel.addEventListener(type, () => {
      if (!pointerDown) blurActive()
    })
  }

  const thrust = document.querySelector<HTMLInputElement>('#s-thrust')!
  const oThrust = document.querySelector<HTMLOutputElement>('#o-thrust')!
  const elastic = document.querySelector<HTMLInputElement>('#s-elastic')!
  const oElastic = document.querySelector<HTMLOutputElement>('#o-elastic')!
  const gravity = document.querySelector<HTMLInputElement>('#s-gravity')!
  const oGravity = document.querySelector<HTMLOutputElement>('#o-gravity')!
  const auto = document.querySelector<HTMLInputElement>('#s-auto')!
  const color = document.querySelector<HTMLInputElement>('#s-color')!
  const oColor = document.querySelector<HTMLOutputElement>('#o-color')!
  const size = document.querySelector<HTMLInputElement>('#s-size')!
  const oSize = document.querySelector<HTMLOutputElement>('#o-size')!
  const body = document.querySelector<HTMLInputElement>('#s-body')!
  const oBody = document.querySelector<HTMLOutputElement>('#o-body')!
  const cell = document.querySelector<HTMLInputElement>('#s-cell')!
  const oCell = document.querySelector<HTMLOutputElement>('#o-cell')!
  const grid = document.querySelector<HTMLInputElement>('#s-grid')!
  const skeleton = document.querySelector<HTMLInputElement>('#s-skeleton')!
  const quality = document.querySelector<HTMLInputElement>('#s-quality')!
  const profiler = document.querySelector<HTMLInputElement>('#s-profiler')!

  const syncOutputs = (): void => {
    oThrust.textContent = String(s.thrust)
    oGravity.textContent = String(s.gravity)
    oElastic.textContent = `${Math.round(s.elasticity * 100)} %`
    oColor.textContent = s.colorSpeed.toFixed(1)
    const h = Math.round(s.fieldScreens * (2 / 3) * 10) / 10
    oSize.textContent = `${s.fieldScreens} × ${h}`
    oCell.textContent = String(s.cell)
    oBody.textContent = `${Math.round(s.bodyScale * 100)} %`
  }

  toggle.addEventListener('click', () => {
    panel.classList.toggle('hidden')
    toggle.textContent = panel.classList.contains('hidden') ? '⚙' : '✕'
    blurActive()
  })

  thrust.addEventListener('input', () => {
    s.thrust = Number(thrust.value)
    syncOutputs()
  })
  // how rubbery the whole frame is: it applies at once, mid-flight
  elastic.addEventListener('input', () => {
    s.elasticity = Number(elastic.value)
    syncOutputs()
  })
  gravity.addEventListener('input', () => {
    s.gravity = Number(gravity.value)
    syncOutputs()
  })
  auto.addEventListener('change', () => {
    s.autoPilot = auto.checked
  })
  color.addEventListener('input', () => {
    s.colorSpeed = Number(color.value)
    syncOutputs()
  })
  size.addEventListener('input', () => {
    s.fieldScreens = Number(size.value)
    syncOutputs()
  })
  cell.addEventListener('input', () => {
    s.cell = Number(cell.value)
    syncOutputs()
  })
  // size of the character itself (the arena rebuilds the body on change)
  body.addEventListener('input', () => {
    s.bodyScale = Number(body.value)
    syncOutputs()
  })
  grid.addEventListener('change', () => {
    s.showGrid = grid.checked
  })
  // tuning view: paint the circles of the skeleton over the drawn body
  skeleton.addEventListener('change', () => {
    s.showSkeleton = skeleton.checked
  })
  // render quality: 2x buffer is smoother, 1x is ~4x cheaper for the GPU
  quality.addEventListener('change', () => {
    engine.setBufferScale(quality.checked ? 2 : 1)
  })
  // diagnostics: show frame timings in the HUD
  profiler.addEventListener('change', () => {
    s.profiler = profiler.checked
  })

  syncOutputs()
}
