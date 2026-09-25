/* ------------------------------------------------------------------ *
 *  THE SKELETON EDITOR - a small "inspector", like assembling an object
 *  in Unity: a list of parts on the left, their properties on the right, a
 *  live preview in the middle, and save / load.
 *
 *  It builds ordinary SkeletonScheme objects, so whatever it produces can be
 *  handed to the game (Ragdoll) without any change in the engine.
 * ------------------------------------------------------------------ */
import { BODY, SIM } from './game/config'
import { Ragdoll } from './game/ragdoll'
import { allSkeletons, registerSkeleton, type ChainScheme, type SkeletonScheme } from './game/skeletons'

const STORE_KEY = 'projectx.skeleton'

/** Every property of a chain, with how to edit it. */
const CHAIN_FIELDS: Array<{
  key: keyof ChainScheme
  label: string
  kind: 'number' | 'bool' | 'text'
  step?: number
  hint?: string
}> = [
  { key: 'part', label: 'часть (имя)', kind: 'text', hint: 'head, torso, armL, armR, legL, legR' },
  { key: 'count', label: 'кружков', kind: 'number', step: 1 },
  { key: 'radius', label: 'радиус (× тела)', kind: 'number', step: 0.1 },
  { key: 'attachTo', label: 'крепится к', kind: 'text', hint: 'neck · pelvis · torso1 · head' },
  { key: 'attachAlong', label: 'вторая связь к', kind: 'text', hint: 'для сустава-распорки; пусто = нет' },
  { key: 'attachAngle', label: 'угол крепления, °', kind: 'number', step: 1 },
  { key: 'attachLength', label: 'длина крепления (×)', kind: 'number', step: 0.1 },
  { key: 'angle', label: 'направление, °', kind: 'number', step: 1, hint: '0 = вниз, 90 = в сторону' },
  { key: 'step', label: 'шаг (× диаметра)', kind: 'number', step: 0.1 },
  { key: 'hinge', label: 'шарнир (номер кружка)', kind: 'number', step: 1 },
  { key: 'preBend', label: 'предсгиб, °', kind: 'number', step: 1 },
  { key: 'swing', label: 'окно распорки, рад', kind: 'number', step: 0.05 },
  { key: 'window', label: 'окно сустава, °', kind: 'number', step: 1 },
  { key: 'flex', label: 'позвоночник (гнётся)', kind: 'bool' },
]

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The editor's own copy of a scheme, as it is being changed. */
export class SkeletonEditor {
  private scheme: SkeletonScheme
  private readonly overlay: HTMLDivElement
  private readonly list: HTMLDivElement
  private readonly props: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private selected = 1
  private body: Ragdoll
  private gravity = true
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
        <button data-act="save" type="button">сохранить</button>
        <button data-act="load" type="button">загрузить</button>
        <button data-act="export" type="button">экспорт JSON</button>
        <button data-act="import" type="button">импорт JSON</button>
        <button data-act="apply" type="button" class="primary">применить в игре</button>
        <button data-act="close" type="button">закрыть</button>
      </div>
      <div class="ed-body">
        <div class="ed-list"></div>
        <div class="ed-view">
          <canvas width="520" height="420"></canvas>
          <div class="ed-viewbar">
            <button data-act="pause" type="button">пауза</button>
            <button data-act="gravity" type="button">гравитация: вкл</button>
            <button data-act="kick" type="button">толкнуть</button>
            <span class="ed-info"></span>
          </div>
        </div>
        <div class="ed-props"></div>
      </div>
      <input class="ed-file" type="file" accept="application/json" />
    `

    const canvas = this.overlay.querySelector('canvas')
    if (!canvas) throw new Error('the editor needs a canvas')
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('the editor needs a 2d context')
    this.ctx = ctx
    this.list = this.overlay.querySelector('.ed-list') as HTMLDivElement
    this.props = this.overlay.querySelector('.ed-props') as HTMLDivElement

    this.body = this.build()
    this.overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const act = target.dataset?.act
      if (act) this.action(act)
    })
    const file = this.overlay.querySelector('.ed-file') as HTMLInputElement
    file.addEventListener('change', () => void this.importFile(file))
    document.body.append(this.overlay)
  }

  /** Show the editor with a scheme (a copy is taken). */
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

  /* ---------------- building and drawing ---------------- */

  private build(): Ragdoll {
    const frame = new Ragdoll(260, 210, 1.4, this.scheme)
    frame.setJointGrip(0.25)
    return frame
  }

  private tick = (time: number): void => {
    if (!this.running) return
    const dt = this.last ? Math.min(0.05, (time - this.last) / 1000) : 0
    this.last = time
    if (!this.overlay.classList.contains('hidden')) {
      this.acc += dt
      let steps = 0
      while (this.acc >= SIM.dt && steps < 5) {
        this.body.step(SIM.dt, { thrustX: 0, thrustY: 0, gravity: this.gravity ? 180 : 0 }, { w: 4200, h: 4200 })
        this.acc -= SIM.dt
        steps++
      }
      this.draw()
    }
    requestAnimationFrame(this.tick)
  }

  private draw(): void {
    const { ctx, canvas } = this
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#0d0f14'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // centre the figure: the editor's world has no floor, so follow the body
    const r = this.body
    let cx = 0
    let cy = 0
    for (const p of r.points) {
      cx += p.x / r.points.length
      cy += p.y / r.points.length
    }
    const view = (p: { x: number; y: number }) => ({
      x: canvas.width / 2 + (p.x - cx),
      y: canvas.height / 2 + (p.y - cy),
    })

    ctx.lineCap = 'round'
    for (const link of r.drawn) {
      const a = view(r.points[link.a])
      const b = view(r.points[link.b])
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = link.width
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    for (const span of r.boneSpans()) {
      const a = view(r.points[span[0]])
      const b = view(r.points[span[span.length - 1]])
      ctx.strokeStyle = 'rgba(200,255,107,0.5)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    for (const p of r.points) {
      const v = view(p)
      ctx.fillStyle = p.part === 'head' ? '#ffd479' : '#9aa4ad'
      ctx.beginPath()
      ctx.arc(v.x, v.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const link of r.links) {
      if (!link.joint) continue
      const a = view(r.points[link.a])
      const b = view(r.points[link.b])
      ctx.strokeStyle = 'rgba(255,179,71,0.6)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    const info = this.overlay.querySelector('.ed-info')
    if (info) {
      const total = this.scheme.chains.reduce((n, c) => n + c.count, 0)
      info.textContent = `кружков ${total} · звеньев ${r.links.length} · костей ${r.boneSpans().length}`
    }
  }

  /* ---------------- the panels ---------------- */

  private render(): void {
    const name = this.overlay.querySelector('.ed-name')
    if (name) name.textContent = `${this.scheme.id} — ${this.scheme.name}`

    this.list.innerHTML =
      `<div class="ed-title">состав</div>` +
      `<div class="ed-row ${this.selected === -1 ? 'sel' : ''}" data-sel="-1">тело: позвонков ${this.scheme.body.count}, голова ×${this.scheme.body.headRadius}</div>` +
      this.scheme.chains
        .map(
          (c, i) =>
            `<div class="ed-row ${i === this.selected ? 'sel' : ''}" data-sel="${i}">` +
            `${c.part} · кружков ${c.count}${c.hinge !== undefined ? ` · шарнир ${c.hinge}` : ''}` +
            `${c.flex ? ' · гнётся' : ''}${c.window !== undefined ? ' · окно' : ''}` +
            `</div>`,
        )
        .join('') +
      `<div class="ed-row add" data-act="add">+ добавить цепочку (копию)</div>` +
      `<div class="ed-row del" data-act="del">− удалить выбранную</div>`

    const items = this.list.querySelectorAll('.ed-row[data-sel]')
    items.forEach((el) =>
      el.addEventListener('click', () => {
        this.selected = Number((el as HTMLElement).dataset.sel)
        this.render()
      }),
    )

    if (this.selected === -1) {
      this.props.innerHTML =
        `<div class="ed-title">свойства тела</div>` +
        this.field('позвонков', this.scheme.body.count, 1, (v) => {
          this.scheme.body.count = Math.max(1, Math.round(v))
          this.rebuild()
        }) +
        this.field('голова (× тела)', this.scheme.body.headRadius, 0.1, (v) => {
          this.scheme.body.headRadius = v
          this.rebuild()
        }) +
        this.field('зазор шеи (×)', this.scheme.body.neckGap, 0.05, (v) => {
          this.scheme.body.neckGap = v
          this.rebuild()
        })
      return
    }

    const chain = this.scheme.chains[this.selected]
    if (!chain) return
    this.props.innerHTML =
      `<div class="ed-title">свойства: ${chain.part}</div>` +
      CHAIN_FIELDS.map((f) => {
        const value = chain[f.key]
        if (f.kind === 'bool') {
          return `<label class="ed-field"><span>${f.label}</span>` +
            `<input type="checkbox" data-key="${String(f.key)}" ${value ? 'checked' : ''} /></label>`
        }
        if (f.kind === 'text') {
          return `<label class="ed-field"><span>${f.label}</span>` +
            `<input type="text" data-key="${String(f.key)}" value="${value ?? ''}" placeholder="${f.hint ?? ''}" /></label>`
        }
        return `<label class="ed-field"><span>${f.label}</span>` +
          `<input type="number" step="${f.step ?? 1}" data-key="${String(f.key)}" value="${value ?? ''}" placeholder="—" /></label>`
      }).join('') +
      `<div class="ed-hint">Пустое поле = свойства нет (например, нет шарнира или окна).</div>`

    this.props.querySelectorAll('input[data-key]').forEach((el) => {
      el.addEventListener('change', () => {
        const input = el as HTMLInputElement
        const key = input.dataset.key as keyof ChainScheme
        const target = this.scheme.chains[this.selected] as unknown as Record<string, unknown>
        if (input.type === 'checkbox') target[key] = input.checked
        else if (input.value === '') delete target[key]
        else if (input.type === 'number') target[key] = Number(input.value)
        else target[key] = input.value
        this.rebuild()
        this.render()
      })
    })
  }

  private field(label: string, value: number, step: number, onChange: (v: number) => void): string {
    const html =
      `<label class="ed-field"><span>${label}</span>` +
      `<input type="number" step="${step}" value="${value}" /></label>`
    queueMicrotask(() => {
      const input = this.props.querySelectorAll('input[type=number]')
      const last = input[input.length - 1] as HTMLInputElement
      if (last) last.addEventListener('change', () => onChange(Number(last.value)))
    })
    return html
  }

  private rebuild(): void {
    this.body = this.build()
  }

  /* ---------------- actions ---------------- */

  private action(act: string): void {
    const chain = this.scheme.chains[this.selected]
    switch (act) {
      case 'close':
        this.close()
        return
      case 'reset':
        this.scheme = clone(allSkeletons()[0])
        this.body = this.build()
        break
      case 'pause':
        this.gravity = this.gravity // no-op, keeps the type narrow
        break
      case 'gravity':
        this.gravity = !this.gravity
        break
      case 'kick': {
        const p = this.body.points[Math.floor(this.body.points.length / 2)]
        p.px -= 4
        break
      }
      case 'add':
        if (chain) this.scheme.chains.splice(this.selected + 1, 0, clone(chain))
        break
      case 'del':
        if (chain && this.scheme.chains.length > 1) this.scheme.chains.splice(this.selected, 1)
        break
      case 'save':
        localStorage.setItem(STORE_KEY, JSON.stringify(this.scheme))
        break
      case 'load': {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw) this.scheme = JSON.parse(raw) as SkeletonScheme
        break
      }
      case 'export': {
        const blob = new Blob([JSON.stringify(this.scheme, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${this.scheme.id}.json`
        a.click()
        URL.revokeObjectURL(a.href)
        return
      }
      case 'import': {
        const file = this.overlay.querySelector('.ed-file') as HTMLInputElement
        file.click()
        return
      }
      case 'apply': {
        this.scheme.id = this.scheme.id === 'edited' ? 'edited' : 'edited'
        registerSkeleton(this.scheme)
        this.onApply?.(this.scheme)
        break
      }
    }
    this.body = this.build()
    this.render()
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    if (!file) return
    try {
      this.scheme = JSON.parse(await file.text()) as SkeletonScheme
      this.scheme.id = this.scheme.id || 'edited'
      this.body = this.build()
      this.render()
    } catch {
      /* a broken file changes nothing */
    }
    input.value = ''
  }
}

/** The default scheme of the game, for the editor to start from. */
export const editorStartScheme = (): SkeletonScheme => allSkeletons()[0]

/** Radii as the game uses them (for the panel's numbers). */
export const bodyRadius = BODY.radius.body
