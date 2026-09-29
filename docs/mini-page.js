/**
 * The explanations page: builds one card per scene from `mini-physics.js`, draws
 * it, and wires the controls. Kept out of the HTML so that its syntax can be
 * checked without a browser (`node --check docs/mini-page.js`).
 */
import { SCENES } from './mini-physics.js'

const COLORS = {
  link: '#cfe3d8',
  brace: '#ffb347',
  bone: '#c8ff6b',
  hinge: '#ff7ad9',
  joint: '#5ec8ff',
}

export function startPage() {
  const host = document.querySelector('#scenes')
  if (!host) return

  for (const entry of SCENES) {
    const built = entry.build()
    const frame = built.frame

    const card = document.createElement('section')
    card.className = 'card'
    card.innerHTML = `
      <div>
        <canvas width="440" height="330"></canvas>
        <div class="controls"></div>
      </div>
      <div>
        <h2></h2>
        <p class="text"></p>
        <div class="readouts"></div>
      </div>
    `
    card.querySelector('h2').textContent = built.title
    card.querySelector('.text').textContent = built.text
    const canvas = card.querySelector('canvas')
    const ctx = canvas.getContext('2d')
    const controls = card.querySelector('.controls')
    const readouts = card.querySelector('.readouts')
    host.append(card)

    /** Fit the scene into the canvas and paint it, then print its numbers. */
    const draw = () => {
      const xs = frame.points.map((p) => p.x)
      const ys = frame.points.map((p) => p.y)
      const margin = 30
      const minX = Math.min(...xs) - margin
      const maxX = Math.max(...xs) + margin
      const minY = Math.min(...ys) - margin
      const maxY = Math.max(...ys) + margin
      const scale = Math.min(canvas.width / (maxX - minX), canvas.height / (maxY - minY))
      const ox = (canvas.width - (maxX - minX) * scale) / 2 - minX * scale
      const oy = (canvas.height - (maxY - minY) * scale) / 2 - minY * scale
      const at = (p) => ({ x: p.x * scale + ox, y: p.y * scale + oy })

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.lineCap = 'round'
      for (const link of frame.links) {
        const p1 = at(frame.points[link.a])
        const p2 = at(frame.points[link.b])
        ctx.strokeStyle = COLORS[link.kind] ?? COLORS.link
        ctx.globalAlpha = link.kind === 'bone' ? 0.75 : 1
        ctx.lineWidth = link.kind === 'bone' ? 1.5 : 2.5
        ctx.setLineDash(link.kind === 'brace' ? [5, 4] : [])
        ctx.beginPath()
        ctx.moveTo(p1.x, p1.y)
        ctx.lineTo(p2.x, p2.y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      for (const p of frame.points) {
        const v = at(p)
        ctx.fillStyle = p.im === 0 ? '#7fa892' : '#e8f3ec'
        ctx.beginPath()
        ctx.arc(v.x, v.y, Math.max(4, p.r * scale), 0, Math.PI * 2)
        ctx.fill()
      }

      readouts.innerHTML = built.readouts
        .map((r) => {
          const text = `${r.label}: ${r.get(frame)}`
          // a link that has gone past its own minimum is shown in red: that is
          // the limit doing its job in the hand-driven scenes
          const shown = Number((text.match(/-?\d+(\.\d+)?/) ?? [NaN])[0])
          const limit = /минимум\s+(-?\d+(\.\d+)?)/.exec(text)
          const bad = limit ? shown < Number(limit[1]) - 0.05 : false
          return `<span class="${bad ? 'bad' : ''}">${text}</span>`
        })
        .join('')
    }

    if (built.control) {
      // a hand-driven scene: a slider sets the pose directly
      const label = document.createElement('span')
      label.textContent = built.control.label
      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = String(built.control.from)
      slider.max = String(built.control.to)
      slider.step = '1'
      slider.value = String(built.control.value)
      const value = document.createElement('span')
      value.textContent = `${slider.value}°`
      slider.addEventListener('input', () => {
        built.control.set(frame, Number(slider.value))
        value.textContent = `${slider.value}°`
        draw()
      })
      controls.append(label, slider, value)
    } else {
      // a live scene: hold the button to push, or reset it
      const button = document.createElement('button')
      button.textContent = 'давить (держать)'
      let pushing = false
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        pushing = true
        button.classList.add('on')
      })
      const stop = () => {
        pushing = false
        button.classList.remove('on')
      }
      button.addEventListener('pointerup', stop)
      button.addEventListener('pointerleave', stop)
      const reset = document.createElement('button')
      reset.textContent = 'сбросить'
      reset.addEventListener('click', () => {
        const fresh = entry.build()
        frame.points.forEach((p, i) => {
          p.x = fresh.frame.points[i].x
          p.y = fresh.frame.points[i].y
          p.px = p.x
          p.py = p.y
        })
        draw()
      })
      controls.append(button, reset)
      // slow motion on purpose: a reader must be able to follow it
      setInterval(() => {
        if (pushing) built.push(frame)
        frame.step(1 / 60)
        draw()
      }, 1000 / 40)
    }

    draw()
  }
}
