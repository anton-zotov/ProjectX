import './style.css'
import { Engine } from './engine'
import {
  HelloWorldScene,
  defaultSettings,
  type GameSettings,
} from './scenes/helloWorld'

const canvas = document.querySelector<HTMLCanvasElement>('#game')!

const settings: GameSettings = defaultSettings()
const scene = new HelloWorldScene(settings)

const engine = new Engine(canvas, scene, {
  width: 320,
  height: 180,
})

setupAdminPanel(settings, engine)
engine.start()

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

  // any committed change (checkbox, select, slider release, keyboard step)
  // moves the focus back to the page -> arrows play the game afterwards
  for (const type of ['input', 'change', 'click'] as const) {
    panel.addEventListener(type, () => {
      if (!pointerDown) blurActive()
    })
  }

  const speed = document.querySelector<HTMLInputElement>('#s-speed')!
  const oSpeed = document.querySelector<HTMLOutputElement>('#o-speed')!
  const auto = document.querySelector<HTMLInputElement>('#s-auto')!
  const color = document.querySelector<HTMLInputElement>('#s-color')!
  const oColor = document.querySelector<HTMLOutputElement>('#o-color')!
  const size = document.querySelector<HTMLInputElement>('#s-size')!
  const oSize = document.querySelector<HTMLOutputElement>('#o-size')!
  const cell = document.querySelector<HTMLInputElement>('#s-cell')!
  const oCell = document.querySelector<HTMLOutputElement>('#o-cell')!
  const grid = document.querySelector<HTMLInputElement>('#s-grid')!
  const quality = document.querySelector<HTMLInputElement>('#s-quality')!
  const profiler = document.querySelector<HTMLInputElement>('#s-profiler')!

  const syncOutputs = (): void => {
    oSpeed.textContent = String(s.speed)
    oColor.textContent = s.colorSpeed.toFixed(1)
    const h = Math.round(s.fieldScreens * (2 / 3) * 10) / 10
    oSize.textContent = `${s.fieldScreens} × ${h}`
    oCell.textContent = String(s.cell)
  }

  toggle.addEventListener('click', () => {
    panel.classList.toggle('hidden')
    toggle.textContent = panel.classList.contains('hidden') ? '⚙' : '✕'
    blurActive()
  })

  speed.addEventListener('input', () => {
    s.speed = Number(speed.value)
    syncOutputs()
  })
  auto.addEventListener('change', () => {
    s.autoMove = auto.checked
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
  grid.addEventListener('change', () => {
    s.showGrid = grid.checked
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
