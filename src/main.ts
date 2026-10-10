/* ------------------------------------------------------------------ *
 *  THE TEST BED OF THE "engine-planck" BRANCH
 *
 *  Deliberately small: a canvas, the Box2D body, and a panel with only what this
 *  experiment is about - gravity, the player's thrust, and the two things our own
 *  engine never had: an exact joint limit and a joint MOTOR. No schemes, no
 *  editor, no tuning views: the base is being rewritten, so first just play.
 * ------------------------------------------------------------------ */
import { BoxBody, PX_PER_M } from './game/body'

const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const ctx = canvas.getContext('2d')!
const hud = document.querySelector<HTMLElement>('#hud')!

const sliders = {
  gravity: document.querySelector<HTMLInputElement>('#s-gravity')!,
  thrust: document.querySelector<HTMLInputElement>('#s-thrust')!,
  limit: document.querySelector<HTMLInputElement>('#s-limit')!,
  motor: document.querySelector<HTMLInputElement>('#s-motor')!,
}
const outputs = {
  gravity: document.querySelector<HTMLOutputElement>('#o-gravity')!,
  thrust: document.querySelector<HTMLOutputElement>('#o-thrust')!,
  limit: document.querySelector<HTMLOutputElement>('#o-limit')!,
  motor: document.querySelector<HTMLOutputElement>('#o-motor')!,
}

const world = { w: 960, h: 540 }
let body = new BoxBody(world.w / 2, world.h * 0.3, 1.2, world)
let camX = 0
let camY = 0
const keys = new Set<string>()

/** The panel drives the joints that fold one way: the knees and the elbows. */
const applyJointSettings = (): void => {
  const limit = (Number(sliders.limit.value) * Math.PI) / 180
  const speed = Number(sliders.motor.value)
  body.setFoldingLimits(limit, speed === 0 ? 0 : speed, 40)
}

const respawn = (): void => {
  body = new BoxBody(world.w / 2, world.h * 0.3, 1.2, world)
  applyJointSettings()
  camX = body.head.x - canvas.width / 2
  camY = body.head.y - canvas.height / 2
}

document.querySelector<HTMLButtonElement>('#respawn')!.addEventListener('click', respawn)
for (const key of Object.keys(sliders) as Array<keyof typeof sliders>) {
  sliders[key].addEventListener('input', () => {
    outputs[key].textContent = sliders[key].value
    if (key === 'limit' || key === 'motor') applyJointSettings()
  })
}
window.addEventListener('keydown', (event) => {
  keys.add(event.code)
  if (event.code === 'KeyR') respawn()
})
window.addEventListener('keyup', (event) => keys.delete(event.code))

const resize = (): void => {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  world.w = canvas.width
  world.h = canvas.height
}
window.addEventListener('resize', resize)
resize()

const COLORS: Record<string, string> = {
  torso: '#9fe8c6',
  head: '#ffd479',
  upperArmL: '#5ec8ff',
  forearmL: '#5ec8ff',
  upperArmR: '#3fa9e0',
  forearmR: '#3fa9e0',
  thighL: '#c58cff',
  shinL: '#c58cff',
  thighR: '#a06fd8',
  shinR: '#a06fd8',
}

let last = performance.now()
let acc = 0

const frame = (now: number): void => {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  acc += dt
  const thrust = Number(sliders.thrust.value)
  const gravity = Number(sliders.gravity.value)
  let steps = 0
  while (acc >= 1 / 60 && steps < 5) {
    const left = keys.has('ArrowLeft') || keys.has('KeyA')
    const right = keys.has('ArrowRight') || keys.has('KeyD')
    const up = keys.has('ArrowUp') || keys.has('KeyW')
    const down = keys.has('ArrowDown') || keys.has('KeyS')
    body.step(
      1 / 60,
      {
        thrustX: (right ? thrust : 0) - (left ? thrust : 0),
        thrustY: (down ? thrust : 0) - (up ? thrust : 0),
        gravity,
      },
      4,
    )
    acc -= 1 / 60
    steps++
  }

  // camera: follow the head, the way the game does
  camX += (body.head.x - canvas.width / 2 - camX) * 0.1
  camY += (body.head.y - canvas.height / 2 - camY) * 0.1

  ctx.fillStyle = '#0d0f14'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.translate(-camX, -camY)

  // the arena frame, so the walls Box2D holds him in are visible
  ctx.strokeStyle = '#22302a'
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, world.w, world.h)

  // bones: the capsules of the old look, drawn from the circles of one body
  ctx.lineCap = 'round'
  for (const bone of body.bones) {
    ctx.strokeStyle = COLORS[bone.name] ?? '#cfe3d8'
    ctx.fillStyle = COLORS[bone.name] ?? '#cfe3d8'
    ctx.lineWidth = bone.radius * 2
    for (let i = 0; i + 1 < bone.circles.length; i++) {
      ctx.beginPath()
      ctx.moveTo(bone.circles[i].x, bone.circles[i].y)
      ctx.lineTo(bone.circles[i + 1].x, bone.circles[i + 1].y)
      ctx.stroke()
    }
    for (const circle of bone.circles) {
      ctx.beginPath()
      ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()

  hud.innerHTML =
    `кружков: ${body.bones.reduce((n, b) => n + b.circles.length, 0)} · тел: ${body.bones.length}<br>` +
    `колено L: ${body.jointAngle('shinL').toFixed(1)}° · колено R: ${body.jointAngle('shinR').toFixed(1)}°<br>` +
    `локоть L: ${body.jointAngle('forearmL').toFixed(1)}° · предел: ${sliders.limit.value}°<br>` +
    `стрелки — тяга · R — пересобрать · масштаб ${PX_PER_M} px/м`

  requestAnimationFrame(frame)
}

respawn()
requestAnimationFrame(frame)
