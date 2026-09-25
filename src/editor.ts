/* ------------------------------------------------------------------ *
 *  THE SKELETON EDITOR - an inspector, like assembling an object in Unity:
 *  the parts on the left, their properties on the right, a live view in the
 *  middle, and save / load.
 *
 *  It builds ordinary SkeletonScheme objects, so whatever it produces can be
 *  handed to the game (Ragdoll) without any change in the engine.
 *
 *  The view has a FIXED camera with zoom: if the camera followed the body (as
 *  the first version did) gravity and pushes look like nothing at all.
 * ------------------------------------------------------------------ */
import { SIM } from './game/config'
import { Ragdoll } from './game/ragdoll'
import { allSkeletons, registerSkeleton, type ChainScheme, type SkeletonScheme } from './game/skeletons'

const STORE_KEY = 'projectx.skeleton'
/** The editor's own little world: a floor and walls, so falling is visible. */
const WORLD = { w: 460, h: 360 }
const MIN_ZOOM = 0.6
const MAX_ZOOM = 7

/**
 * Every property of a chain, in the order an inspector should show it, grouped
 * by what it is about. `appliesTo` marks the fields that belong to ONE of the
 * two joint styles - a scheme uses one or the other, never both.
 */
type Field = {
  key: keyof ChainScheme
  label: string
  kind: 'number' | 'bool' | 'text'
  step?: number
  hint?: string
  appliesTo?: 'props' | 'window'
}

const GROUPS: Array<{ title: string; hint?: string; fields: Field[] }> = [
  {
    title: 'геометрия',
    fields: [
      { key: 'part', label: 'имя части', kind: 'text', hint: 'head · torso · armL · armR · legL · legR' },
      { key: 'count', label: 'кружков', kind: 'number', step: 1 },
      { key: 'radius', label: 'радиус, × тела', kind: 'number', step: 0.1, hint: '1 = как кружок тела' },
      { key: 'angle', label: 'направление, °', kind: 'number', step: 1, hint: '0 = вниз, 90 = в сторону' },
      { key: 'step', label: 'шаг, × диаметра', kind: 'number', step: 0.1, hint: '1 = кружки вплотную' },
    ],
  },
  {
    title: 'крепление к телу',
    hint: 'как цепочка висит на теле: одна связь к указанному кружку',
    fields: [
      { key: 'attachTo', label: 'крепится к', kind: 'text', hint: 'neck · pelvis · torso1 · head' },
      { key: 'attachAngle', label: 'угол крепления, °', kind: 'number', step: 1 },
      { key: 'attachLength', label: 'длина крепления, ×', kind: 'number', step: 0.1 },
    ],
  },
  {
    title: 'сгиб (локоть, колено)',
    fields: [
      { key: 'hinge', label: 'шарнир, № кружка', kind: 'number', step: 1, hint: 'пусто = цепочка не гнётся' },
      { key: 'preBend', label: 'предсгиб, °', kind: 'number', step: 1, hint: 'поза покоя: слегка согнуто' },
    ],
  },
  {
    title: 'сустав: распорка (старый стиль)',
    hint: 'две связи держат ориентацию; схема normal использует этот стиль',
    fields: [
      { key: 'swing', label: 'окно, рад', kind: 'number', step: 0.05, appliesTo: 'props' },
      { key: 'attachAlong', label: 'вторая связь к', kind: 'text', appliesTo: 'props', hint: 'соседний кружок тела' },
    ],
  },
  {
    title: 'сустав: окно (новый стиль)',
    hint: 'одна связь до кончика конечности плюс жёсткое окно; схема vertebrae использует его',
    fields: [{ key: 'window', label: 'полуокно, °', kind: 'number', step: 1, appliesTo: 'window' }],
  },
  {
    title: 'особое',
    fields: [
      {
        key: 'flex',
        label: 'цепочка гнётся (позвоночник)',
        kind: 'bool',
        hint: 'вкл — цепочка пружинит и может изгибаться; выкл — сваривается в одну кость',
      },
    ],
  },
]

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export class SkeletonEditor {
  private scheme: SkeletonScheme
  private readonly overlay: HTMLDivElement
  private readonly list: HTMLDivElement
  private readonly props: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private selected = 1
  private body: Ragdoll
  private paused = false
  private gravity = true
  private zoom = 2.4
  private acc = 0
  private last = 0
  private running = false
  private onApply?: (scheme: SkeletonScheme) => void

  constructor(scheme: SkeletonScheme) {
    this.scheme = clone(scheme)
    this.overlay = document.createElement('div')
    this.overlay.id = 'editor'
    this.overlay.className = 'hidden'
    this.overlay.innerHTML = `
      <div class="ed-head">
        <b>редактор скелета</b>
        <span class="ed-name"></span>
        <span class="ed-spacer"></span>
        <button data-act="reset" type="button">сброс</button>
        <button data-act="save" type="button">сохранить в браузере</button>
        <button data-act="load" type="button">загрузить</button>
        <button data-act="export" type="button">экспорт JSON</button>
        <button data-act="import" type="button">импорт JSON</button>
        <button data-act="apply" type="button" class="primary">применить в игре</button>
        <button data-act="close" type="button">закрыть</button>
      </div>
      <div class="ed-body">
        <div class="ed-list"></div>
        <div class="ed-view">
          <canvas width="720" height="560"></canvas>
          <div class="ed-viewbar">
            <button data-act="pause" type="button">пауза</button>
            <button data-act="gravity" type="button">гравитация: вкл</button>
            <button data-act="kick" type="button">толкнуть</button>
            <span class="ed-zoom">
              <button data-act="zoom-out" type="button">−</button>
              <button data-act="zoom-in" type="button">+</button>
              <button data-act="fit" type="button">вписать</button>
            </span>
            <span class="ed-info"></span>
          </div>
          <div class="ed-tip">колесо мыши — масштаб · клик по фигуре — выбрать часть</div>
        </div>
        <div class="ed-props"></div>
      </div>
      <input class="ed-file" type="file" accept="application/json" />
    `

    const canvas = this.overlay.querySelector('canvas')
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) throw new Error('the editor needs a canvas')
    this.canvas = canvas
    this.ctx = ctx
    this.list = this.overlay.querySelector('.ed-list') as HTMLDivElement
    this.props = this.overlay.querySelector('.ed-props') as HTMLDivElement

    this.body = this.build()
    this.overlay.addEventListener('click', (event) => {
      const act = (event.target as HTMLElement).dataset?.act
      if (act) this.action(act)
    })
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault()
      this.zoomBy(Math.exp(-event.deltaY * 0.0012))
    })
    canvas.addEventListener('click', (event) => this.pick(event))
    const file = this.overlay.querySelector('.ed-file') as HTMLInputElement
    file.addEventListener('change', () => void this.importFile(file))
    document.body.append(this.overlay)
  }

  /** Show the editor on a copy of the given scheme. */
  open(scheme: SkeletonScheme, onApply?: (scheme: SkeletonScheme) => void): void {
    this.scheme = clone(scheme)
    this.onApply = onApply
    this.body = this.build()
    this.overlay.classList.remove('hidden')
    this.render()
    if (!this.running) {
      this.running = true
      requestAnimationFrame(this.tick)
    }
  }

  close(): void {
    this.overlay.classList.add('hidden')
  }

  /* ---------------- simulation and view ---------------- */

  private build(): Ragdoll {
    const frame = new Ragdoll(WORLD.w / 2, WORLD.h / 2, 1, this.scheme)
    frame.setJointGrip(0.25)
    return frame
  }

  private reset(): void {
    this.body = this.build()
    this.acc = 0
  }

  private tick = (time: number): void => {
    if (!this.running) return
    const dt = this.last ? Math.min(0.05, (time - this.last) / 1000) : 0
    this.last = time
    if (!this.overlay.classList.contains('hidden') && !this.paused) {
      this.acc += dt
      let steps = 0
      while (this.acc >= SIM.dt && steps < 6) {
        this.body.step(SIM.dt, { thrustX: 0, thrustY: 0, gravity: this.gravity ? 180 : 0 }, WORLD)
        this.acc -= SIM.dt
        steps++
      }
    }
    if (!this.overlay.classList.contains('hidden')) this.draw()
    requestAnimationFrame(this.tick)
  }

  private zoomBy(factor: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor))
  }

  /** World -> screen. The camera is fixed: the world's centre stays centred. */
  private view(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: this.canvas.width / 2 + (p.x - WORLD.w / 2) * this.zoom,
      y: this.canvas.height / 2 + (p.y - WORLD.h / 2) * this.zoom,
    }
  }

  /** Screen -> world (for picking with the mouse). */
  private unview(x: number, y: number): { x: number; y: number } {
    return {
      x: WORLD.w / 2 + (x - this.canvas.width / 2) / this.zoom,
      y: WORLD.h / 2 + (y - this.canvas.height / 2) / this.zoom,
    }
  }

  private draw(): void {
    const { ctx, canvas } = this
    ctx.fillStyle = '#0d0f14'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // the world's walls and floor: without them a fall is invisible
    const a = this.view({ x: 0, y: 0 })
    const b = this.view({ x: WORLD.w, y: WORLD.h })
    ctx.strokeStyle = '#22302a'
    ctx.lineWidth = 2
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)

    const r = this.body
    const selectedPart = this.scheme.chains[this.selected]?.part
    const isSelected = (part: string): boolean => part === selectedPart

    ctx.lineCap = 'round'
    for (const link of r.drawn) {
      const p1 = this.view(r.points[link.a])
      const p2 = this.view(r.points[link.b])
      const part = r.points[link.a].part
      ctx.strokeStyle = isSelected(part) ? '#ffd479' : '#ffffff'
      ctx.lineWidth = link.width * this.zoom * (isSelected(part) ? 1.15 : 1)
      ctx.beginPath()
      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
      ctx.stroke()
    }
    for (const span of r.boneSpans()) {
      const p1 = this.view(r.points[span[0]])
      const p2 = this.view(r.points[span[span.length - 1]])
      ctx.strokeStyle = 'rgba(200,255,107,0.45)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
      ctx.stroke()
    }
    for (const link of r.links) {
      if (!link.joint) continue
      const p1 = this.view(r.points[link.a])
      const p2 = this.view(r.points[link.b])
      ctx.strokeStyle = 'rgba(255,179,71,0.55)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
      ctx.stroke()
    }
    for (const p of r.points) {
      const v = this.view(p)
      const chosen = isSelected(p.part)
      ctx.fillStyle = p.part === 'head' ? '#ffd479' : chosen ? '#9fe8c6' : '#9aa4ad'
      ctx.beginPath()
      ctx.arc(v.x, v.y, p.r * this.zoom, 0, Math.PI * 2)
      ctx.fill()
      if (chosen) {
        ctx.strokeStyle = '#3fe09b'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(v.x, v.y, p.r * this.zoom + 3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    const info = this.overlay.querySelector('.ed-info')
    if (info) {
      const total = this.scheme.chains.reduce((n, c) => n + c.count, 0)
      info.textContent = `кружков ${total} · звеньев ${r.links.length} · костей ${r.boneSpans().length} · масштаб ${this.zoom.toFixed(1)}×`
    }
    const pause = this.overlay.querySelector('[data-act="pause"]')
    if (pause) pause.textContent = this.paused ? 'продолжить' : 'пауза'
    const gravity = this.overlay.querySelector('[data-act="gravity"]')
    if (gravity) gravity.textContent = `гравитация: ${this.gravity ? 'вкл' : 'выкл'}`
  }

  /** Click in the view: choose the part whose circle is closest to the point. */
  private pick(event: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const at = this.unview(
      ((event.clientX - rect.left) / rect.width) * this.canvas.width,
      ((event.clientY - rect.top) / rect.height) * this.canvas.height,
    )
    let best = -1
    let bestDistance = 18 / this.zoom
    this.body.points.forEach((p, i) => {
      const d = Math.hypot(p.x - at.x, p.y - at.y)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    })
    if (best < 0) return
    const part = this.body.points[best].part
    const index = this.scheme.chains.findIndex((c) => c.part === part)
    if (index >= 0) {
      this.selected = index
      this.render()
    }
  }

  /* ---------------- panels ---------------- */

  private render(): void {
    const name = this.overlay.querySelector('.ed-name')
    if (name) name.textContent = `${this.scheme.id} — ${this.scheme.name}`
    this.renderList()
    this.renderProps()
  }

  private renderList(): void {
    const rows: string[] = []
    rows.push(
      `<div class="ed-row ${this.selected === -1 ? 'sel' : ''}" data-sel="-1">` +
        `<b>тело</b><span>позвонков ${this.scheme.body.count} · голова ×${this.scheme.body.headRadius}</span></div>`,
    )
    this.scheme.chains.forEach((c, i) => {
      const bits = [`кружков ${c.count}`]
      if (c.hinge !== undefined) bits.push(`шарнир ${c.hinge}`)
      if (c.window !== undefined) bits.push('окно')
      if (c.swing !== undefined) bits.push('распорка')
      if (c.flex) bits.push('гнётся')
      rows.push(
        `<div class="ed-row ${i === this.selected ? 'sel' : ''}" data-sel="${i}">` +
          `<b>${c.part}</b><span>${bits.join(' · ')}</span></div>`,
      )
    })
    rows.push(`<div class="ed-row add" data-act="add">+ добавить копию выбранной</div>`)
    rows.push(`<div class="ed-row del" data-act="del">− удалить выбранную</div>`)
    this.list.innerHTML = `<div class="ed-title">состав</div>${rows.join('')}`
    this.list.querySelectorAll('.ed-row[data-sel]').forEach((el) =>
      el.addEventListener('click', () => {
        this.selected = Number((el as HTMLElement).dataset.sel)
        this.render()
      }),
    )
  }

  private renderProps(): void {
    if (this.selected === -1) {
      const body = this.scheme.body
      this.props.innerHTML =
        `<div class="ed-title">свойства тела</div>` +
        `<div class="ed-hint">Тело — это позвоночник: позвонки, голова и зазор шеи.</div>` +
        `<div class="ed-group">геометрия</div>` +
        `<label class="ed-field"><span>позвонков</span><input type="number" step="1" data-body="count" value="${body.count}" /></label>` +
        `<label class="ed-field"><span>голова, × тела</span><input type="number" step="0.1" data-body="headRadius" value="${body.headRadius}" /></label>` +
        `<label class="ed-field"><span>зазор шеи, ×</span><input type="number" step="0.05" data-body="neckGap" value="${body.neckGap}" /></label>` +
        `<div class="ed-hint tight">зазор шеи: насколько первый позвонок ниже центра головы (1 = касаются)</div>`
      this.props.querySelectorAll('input[data-body]').forEach((el) =>
        el.addEventListener('change', () => {
          const input = el as HTMLInputElement
          const key = input.dataset.body as 'count' | 'headRadius' | 'neckGap'
          const value = Number(input.value)
          if (key === 'count') this.scheme.body.count = Math.max(1, Math.round(value))
          else if (key === 'headRadius') this.scheme.body.headRadius = Math.max(0.2, value)
          else this.scheme.body.neckGap = Math.max(0, value)
          this.reset()
          this.render()
        }),
      )
      return
    }

    const chain = this.scheme.chains[this.selected]
    if (!chain) return
    const style = chain.window !== undefined ? 'window' : 'props'
    const html: string[] = [
      `<div class="ed-title">свойства: ${chain.part}</div>`,
      `<div class="ed-hint">Стиль сустава: <b>${style === 'window' ? 'окно' : 'распорка'}</b>` +
        ` — поля другого стиля не используются этой схемой.</div>`,
    ]
    for (const group of GROUPS) {
      const fields = group.fields.filter((f) => f.appliesTo === undefined || f.appliesTo === style)
      if (!fields.length) continue
      html.push(`<div class="ed-group">${group.title}</div>`)
      if (group.hint) html.push(`<div class="ed-hint">${group.hint}</div>`)
      for (const f of fields) {
        const value = chain[f.key]
        if (f.kind === 'bool') {
          html.push(
            `<label class="ed-field"><span>${f.label}</span>` +
              `<input type="checkbox" data-key="${String(f.key)}" ${value ? 'checked' : ''} /></label>`,
          )
        } else {
          const type = f.kind === 'number' ? 'number' : 'text'
          const extra = f.kind === 'number' ? ` step="${f.step ?? 1}"` : ` placeholder="${f.hint ?? ''}"`
          html.push(
            `<label class="ed-field"><span>${f.label}</span>` +
              `<input type="${type}"${extra} data-key="${String(f.key)}" value="${value ?? ''}" /></label>`,
          )
          if (f.hint && f.kind === 'number') html.push(`<div class="ed-hint tight">${f.hint}</div>`)
        }
      }
    }
    this.props.innerHTML = html.join('')
    this.props.querySelectorAll('input[data-key]').forEach((el) => {
      el.addEventListener('change', () => {
        const input = el as HTMLInputElement
        const key = input.dataset.key as keyof ChainScheme
        const target = this.scheme.chains[this.selected] as unknown as Record<string, unknown>
        if (input.type === 'checkbox') target[key] = input.checked
        else if (input.value === '') delete target[key]
        else if (input.type === 'number') target[key] = Number(input.value)
        else target[key] = input.value
        this.reset()
        this.render()
      })
    })
  }

  /* ---------------- actions ---------------- */

  private action(act: string): void {
    const chain = this.scheme.chains[this.selected]
    switch (act) {
      case 'close':
        this.close()
        return
      case 'pause':
        this.paused = !this.paused
        break
      case 'gravity':
        this.gravity = !this.gravity
        break
      case 'kick':
        // a shove of the whole body: a uniform change of the previous position
        for (const p of this.body.points) p.px -= 6
        break
      case 'zoom-in':
        this.zoomBy(1.25)
        break
      case 'zoom-out':
        this.zoomBy(1 / 1.25)
        break
      case 'fit': {
        // scale so the frame's own height fills most of the view
        let minY = Infinity
        let maxY = -Infinity
        for (const p of this.body.points) {
          minY = Math.min(minY, p.y - p.r)
          maxY = Math.max(maxY, p.y + p.r)
        }
        this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (this.canvas.height * 0.8) / (maxY - minY)))
        break
      }
      case 'reset':
        this.scheme = clone(allSkeletons()[0])
        this.selected = 1
        this.reset()
        break
      case 'add':
        if (chain) {
          const copy = clone(chain)
          copy.part = `${chain.part}Copy`
          this.scheme.chains.splice(this.selected + 1, 0, copy)
          this.selected += 1
        }
        break
      case 'del':
        if (chain && this.scheme.chains.length > 1) {
          this.scheme.chains.splice(this.selected, 1)
          this.selected = Math.min(this.selected, this.scheme.chains.length - 1)
        }
        break
      case 'save':
        localStorage.setItem(STORE_KEY, JSON.stringify(this.scheme))
        break
      case 'load': {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw) this.scheme = JSON.parse(raw) as SkeletonScheme
        this.reset()
        break
      }
      case 'export': {
        const blob = new Blob([JSON.stringify(this.scheme, null, 2)], { type: 'application/json' })
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = `${this.scheme.id}.json`
        link.click()
        URL.revokeObjectURL(link.href)
        return
      }
      case 'import': {
        const file = this.overlay.querySelector('.ed-file') as HTMLInputElement
        file.click()
        return
      }
      case 'apply': {
        this.scheme.id = 'edited'
        this.scheme.name = `правленая (${this.scheme.chains.reduce((n, c) => n + c.count, 0)} кружков)`
        registerSkeleton(this.scheme)
        this.onApply?.(this.scheme)
        break
      }
    }
    this.render()
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    if (!file) return
    try {
      this.scheme = JSON.parse(await file.text()) as SkeletonScheme
      this.scheme.id = this.scheme.id || 'edited'
      this.reset()
      this.render()
    } catch {
      /* a broken file changes nothing */
    }
    input.value = ''
  }
}
