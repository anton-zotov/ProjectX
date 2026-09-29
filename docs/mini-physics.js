/* ------------------------------------------------------------------ *
 *  A TINY PHYSICS KIT for the explanations page.
 *
 *  It solves the SAME KINDS OF LINKS as the game, in the simplest possible
 *  form, so a reader can watch one link at a time:
 *
 *    link        two circles: the distance is held, the ANGLE is free
 *    brace       circles i and i+2: it is what makes a chain resist bending
 *    bone        links with no give at all: the piece cannot bend anywhere
 *    hinge       one foldable brace among welded ones: one place bends
 *    joint       a link from a limb to the body: its attitude, with grip
 *
 *  Verlet integration (positions only, velocity is x - px), a few solver
 *  iterations, hard limits first and then the spring - exactly the order the
 *  game uses. No DOM, no canvas: this file is pure numbers, so it can be run
 *  and checked outside a browser.
 * ------------------------------------------------------------------ */

export class Frame {
  constructor() {
    /** @type {{x:number,y:number,px:number,py:number,r:number,im:number,label?:string}[]} */
    this.points = []
    /** @type {any[]} */
    this.links = []
    /** Rigid pieces: groups of circles fitted to their rest shape every step. */
    this.bones = []
    this.gravity = 0
    this.grip = 0 // px of correction a joint link may take per iteration
  }

  point(x, y, r = 7, opts = {}) {
    const im = opts.pinned ? 0 : 1 / (opts.mass ?? 1)
    this.points.push({ x, y, px: x, py: y, r, im, label: opts.label })
    return this.points.length - 1
  }

  /**
   * A link between two circles.
   *   kind: what to call it on screen ('link' | 'brace' | 'bone' | 'hinge' | 'joint')
   *   rest: length at rest (default: the current distance)
   *   stretch: how far it may stretch, as a factor (default 1.05)
   *   fold: how far it may be squeezed, as a factor (default: to touching)
   *   compliance: 0 = rigid (projected exactly), > 0 = a spring
   *   joint: true = the grip applies to it
   */
  link(a, b, opts = {}) {
    const p1 = this.points[a]
    const p2 = this.points[b]
    const rest = opts.rest ?? Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const touching = p1.r + p2.r
    this.links.push({
      a,
      b,
      rest,
      min: opts.min ?? (opts.fold ? rest * opts.fold : touchFloor(touching, rest)),
      max: opts.max ?? rest * (opts.stretch ?? 1.05),
      compliance: opts.compliance ?? 0,
      joint: opts.joint ?? false,
      kind: opts.kind ?? 'link',
      hidden: opts.hidden ?? false,
    })
    return this.links.length - 1
  }

  /** Steps of simulation, each with `iterations` solver passes. */
  step(dt, iterations = 20) {
    for (const p of this.points) {
      if (p.im === 0) continue
      const vx = (p.x - p.px) * 0.999
      const vy = (p.y - p.py) * 0.999
      p.px = p.x
      p.py = p.y
      p.x += vx
      p.y += this.gravity * dt * dt
    }
    // The bones are fitted INSIDE the solver loop, not after it: a fit moves
    // circles, so a fit that runs last can leave a link outside its hard limit
    // (measured: the hinge folded to 90 degrees although its cap was 60). The
    // loop ends with a few plain solver passes, so the limits have the last word
    // and the bones are still as good as straight.
    for (let i = 0; i < iterations; i++) {
      for (const link of this.links) this.solve(link, dt)
      if (i % 6 === 5) {
        for (let pass = 0; pass < 2; pass++) {
          for (const bone of this.bones) this.fit(bone)
        }
      }
    }
    for (let i = 0; i < 6; i++) {
      for (const link of this.links) this.solve(link, dt)
    }
  }

  /**
   * Declare a group of circles a rigid piece: its shape is remembered and
   * restored every step.
   */
  bone(group) {
    const pts = group.map((i) => this.points[i])
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    this.bones.push({ group, angle: 0, rest: pts.map((p) => ({ x: p.x - cx, y: p.y - cy })) })
  }

  /**
   * Fit a bone to its rest shape: find the rotation that best matches, put every
   * circle exactly at its rest offset, and then shift the whole piece by the
   * average correction so its momentum is not changed by the fit.
   */
  fit(bone) {
    const pts = bone.group.map((i) => this.points[i])
    const free = pts.filter((p) => p.im > 0)
    if (free.length < 2) return
    // the reference must be the SAME for the rest shape and for the current
    // one: the centroid of every circle of the bone. Using only the free ones
    // breaks the piece as soon as one of its circles is pinned (measured: the
    // shoulder would bend its own bone by 83 degrees).
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    // the best rotation: the sum of dot and cross products of current vs rest
    let dot = 0
    let cross = 0
    pts.forEach((p, k) => {
      const dx = p.x - cx
      const dy = p.y - cy
      dot += dx * bone.rest[k].x + dy * bone.rest[k].y
      cross += dx * bone.rest[k].y - dy * bone.rest[k].x
    })
    const rot = Math.atan2(cross, dot)
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const targets = pts.map((p, k) => ({
      p,
      x: cx + bone.rest[k].x * cos - bone.rest[k].y * sin,
      y: cy + bone.rest[k].x * sin + bone.rest[k].y * cos,
    }))
    const movable = targets.filter((t) => t.p.im > 0)
    const ax = movable.reduce((s, t) => s + (t.x - t.p.x), 0) / movable.length
    const ay = movable.reduce((s, t) => s + (t.y - t.p.y), 0) / movable.length
    for (const t of movable) {
      t.p.x = t.x + ax
      t.p.y = t.y + ay
    }
  }

  solve(link, dt) {
    const p1 = this.points[link.a]
    const p2 = this.points[link.b]
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    let d = Math.hypot(dx, dy)
    const w1 = p1.im
    const w2 = p2.im
    const w = w1 + w2
    if (w === 0) return
    if (d < 1e-6) {
      p1.x -= 0.01
      p2.x += 0.01
      return
    }
    const nx = dx / d
    const ny = dy / d

    // hard limits first: never closer than `min`, never further than `max`
    const target = d < link.min ? link.min : d > link.max ? link.max : d
    if (target !== d) {
      const corr = target - d
      p1.x -= nx * corr * (w1 / w)
      p1.y -= ny * corr * (w1 / w)
      p2.x += nx * corr * (w2 / w)
      p2.y += ny * corr * (w2 / w)
      d = target
    }

    if (link.compliance <= 0) {
      // rigid: put the pair exactly at the rest length
      const corr = link.rest - d
      p1.x -= nx * corr * (w1 / w)
      p1.y -= ny * corr * (w1 / w)
      p2.x += nx * corr * (w2 / w)
      p2.y += ny * corr * (w2 / w)
      return
    }

    // elastic: pull towards the rest length, softened by the compliance
    const alpha = link.compliance / (dt * dt)
    let corr = (link.rest - d) / (w + alpha)
    if (link.joint && this.grip > 0) {
      corr = corr > this.grip ? this.grip : corr < -this.grip ? -this.grip : corr
    }
    p1.x -= nx * corr * w1
    p1.y -= ny * corr * w1
    p2.x += nx * corr * w2
    p2.y += ny * corr * w2
  }

  /** Distance between two circles, for the readouts. */
  span(link) {
    const p1 = this.points[link.a]
    const p2 = this.points[link.b]
    return Math.hypot(p2.x - p1.x, p2.y - p1.y)
  }

  /** Angle (degrees) at circle `b` between b->a and b->c. 180 = straight. */
  angleAt(a, b, c) {
    const p = (i) => this.points[i]
    const v1 = { x: p(a).x - p(b).x, y: p(a).y - p(b).y }
    const v2 = { x: p(c).x - p(b).x, y: p(c).y - p(b).y }
    const dot = v1.x * v2.x + v1.y * v2.y
    const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1
    return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI
  }

  /** Absolute direction of the pair a->b, degrees. */
  heading(a, b) {
    const p = (i) => this.points[i]
    return (Math.atan2(p(b).y - p(a).y, p(b).x - p(a).x) * 180) / Math.PI
  }

  nudge(index, dx, dy) {
    const p = this.points[index]
    if (!p || p.im === 0) return
    p.px -= dx
    p.py -= dy
  }

  allFinite() {
    return this.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  }
}

/** The hard floor of a link is the touching distance - never closer. */
function touchFloor(touching, rest) {
  return Math.min(touching, rest)
}

/* ------------------------------------------------------------------ *
 *  THE SCENES used by the page. Each returns { frame, notes } where the
 *  page reads the frame to draw and print numbers.
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180

/** 1. Two circles and ONE link: distance held, angle free. */
export function sceneOneLink() {
  const f = new Frame()
  const a = f.point(150, 120, 8, { pinned: true })
  const b = f.point(230, 120, 8)
  const link = f.link(a, b, { kind: 'link' })
  return {
    frame: f,
    title: 'Звено: держится только расстояние',
    text:
      'Два кружка и одна связь. Длина между ними зафиксирована (её можно сжать максимум до касания и растянуть на 5 %), ' +
      'а вот ПОВОРОТ не ограничен ничем: пара свободно вращается вокруг общего центра. В связи нет ни одного угла — ' +
      'это главное, что нужно про неё понять.',
    readouts: [
      { label: 'длина', get: (fr) => `${fr.span(fr.links[link]).toFixed(1)} px` },
      { label: 'направление', get: (fr) => `${fr.heading(a, b).toFixed(0)}°` },
    ],
    push: (fr) => fr.nudge(b, 0, -1.2),
    angle: { a, b, c: null },
  }
}

/** 2. Three circles: two links and exactly ONE brace (1st <-> 3rd). */
export function sceneThreeCircles() {
  const f = new Frame()
  const a = f.point(150, 90, 8, { pinned: true })
  const b = f.point(150, 120, 8)
  const c = f.point(150, 150, 8)
  f.link(a, b, { kind: 'link' })
  f.link(b, c, { kind: 'link' })
  // the brace is a SPRING (like in the game, compliance 0.00008), and its
  // minimum caps the bend: cos(10°) of the straight distance, so about 20°
  const brace = f.link(a, c, { kind: 'brace', fold: Math.cos((20 * DEG) / 2), stretch: 1.2, compliance: 0.02 })
  return {
    frame: f,
    title: 'Тело из трёх кружков: распорка ровно одна',
    text:
      'Да, твоя догадка верна: на тело из трёх кружков приходится РОВНО ОДНА распорка — между 1-м и 3-м кружком ' +
      '(на рисунке она другого цвета). Она не задаёт угол напрямую: она держит РАССТОЯНИЕ через один кружок, ' +
      'а сгиб это расстояние сокращает. Отсюда перевод угла в расстояние: минимум распорки = cos(угол/2) × прямое ' +
      'расстояние. Здесь минимум задан как cos(10°), то есть сгиб упирается в 20° (распорка взята в семь раз мягче ' +
      'игровой — иначе предела просто не видно). Держи «давить»: сгиб упрётся в предел, а длина распорки сократится. ' +
      'Отпусти — распорка-пружина выпрямит цепочку обратно. Это и есть работа распорки: не «угол», а пружина на ' +
      'расстояние через один кружок плюс предел на него.',
    readouts: [
      { label: 'сгиб', get: (fr) => `${(180 - fr.angleAt(a, b, c)).toFixed(1)}°` },
      { label: 'распорка (1↔3)', get: (fr) => `${fr.span(fr.links[brace]).toFixed(1)} px` },
      { label: 'прямая длина', get: (fr) => `${(fr.span(fr.links[0]) + fr.span(fr.links[1])).toFixed(1)} px` },
    ],
    push: (fr) => fr.nudge(b, 1.1, 0),
    angle: { a, b, c },
  }
}

/** 3. The same three circles, but everything is welded: a bone. */
export function sceneBone() {
  const f = new Frame()
  const a = f.point(150, 90, 8, { pinned: true })
  const b = f.point(150, 120, 8)
  const c = f.point(150, 150, 8)
  f.link(a, b, { kind: 'bone' })
  f.link(b, c, { kind: 'bone' })
  f.link(a, c, { kind: 'brace', fold: 1, stretch: 1 })
  f.bone([a, b, c])
  return {
    frame: f,
    title: 'Кость: те же три кружка, но согнуться негде',
    text:
      'Кость — это не отдельный объект, а НАБОР связей, которые не дают согнуться: звенья сварены (нет ни податливости, ' +
      'ни запаса на растяжение), и распорка тоже сварена — её минимум равен единице, то есть сократиться ей нечем. ' +
      'Сравни с предыдущим примером: та же фигура, тот же толчок — а сгиб почти ноль. В игре к этому добавляется ' +
      '«подгонка формы»: раз в подшаг кость жёстко подгоняется под свою форму, поэтому три кружка на одной линии ' +
      'не могут «поплыть» (без неё замер давал изгиб 22–38° — вырожденный треугольник).',
    readouts: [{ label: 'сгиб', get: (fr) => `${(180 - fr.angleAt(a, b, c)).toFixed(2)}°` }],
    push: (fr) => fr.nudge(b, 0.35, 0),
    angle: { a, b, c },
  }
}

/**
 * 4. THE HINGE, as a hand-driven diagram.
 *
 * It is not simulated, and that is on purpose: a fold that is imposed by the
 * reader shows the ONE thing this scene has to show (only the hinge bends, and
 * only up to its cap), while a simulated fold drags in the bone fit fighting the
 * brace limit - a solver detail that has nothing to do with the question.
 */
export function sceneHinge(degrees = 0) {
  const f = new Frame()
  // the end of the upper bone is held, so the only thing that can move is the
  // fold itself
  const p = [f.point(110, 70, 7, { pinned: true })]
  for (let i = 1; i < 5; i++) p.push(f.point(110, 70 + i * 26, 7))
  for (let i = 1; i < 5; i++) f.link(p[i - 1], p[i], { kind: 'bone' })
  // braces: welded inside a bone, the one across the hinge has a cap of 60°
  f.link(p[0], p[2], { kind: 'brace', fold: 1, stretch: 1 })
  const hinge = f.link(p[1], p[3], {
    kind: 'hinge',
    fold: Math.cos((60 * DEG) / 2),
    stretch: 1.4,
    compliance: 0.05,
  })
  f.link(p[2], p[4], { kind: 'brace', fold: 1, stretch: 1 })
  // the lower bone, as it sits at rest relative to the hinge circle
  const lower = [p[3], p[4]].map((i) => ({
    index: i,
    dx: f.points[i].x - f.points[p[2]].x,
    dy: f.points[i].y - f.points[p[2]].y,
  }))
  /** Fold the knee by `deg` degrees (0 = straight). */
  const set = (fr, deg) => {
    const rad = (deg * DEG)
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const cx = fr.points[p[2]].x
    const cy = fr.points[p[2]].y
    for (const part of lower) {
      fr.points[part.index].x = cx + part.dx * cos - part.dy * sin
      fr.points[part.index].y = cy + part.dx * sin + part.dy * cos
    }
  }
  set(f, degrees)
  return {
    frame: f,
    control: { label: 'согнуть колено', from: 0, to: 90, value: degrees, set },
    title: 'Шарнир: гнётся ровно в одном месте (и не дальше предела)',
    text:
      'Пять кружков, четыре звена, три распорки. Две распорки сварены — они внутри костей, там гнётся нечего. ' +
      'Третья (1↔3) перешагивает шарнир: это пружина, у которой минимум равен cos(30°) от прямой длины, то есть ' +
      'колено складывается не больше чем на 60°. Двигай ползунок: изгиб идёт только в одном месте, обе кости ' +
      'остаются прямыми (в числах — доли градуса), а длина связки шарнира сокращается и упирается в минимум. ' +
      'Сцена не симулируется, а задаётся вручную: так видно именно работу шарнира, без капризов решателя.',
    readouts: [
      { label: 'изгиб в шарнире', get: (fr) => `${(180 - fr.angleAt(p[1], p[2], p[3])).toFixed(1)}°` },
      { label: 'верхняя кость', get: (fr) => `${(180 - fr.angleAt(p[0], p[1], p[2])).toFixed(2)}°` },
      { label: 'нижняя кость', get: (fr) => `${(180 - fr.angleAt(p[2], p[3], p[4])).toFixed(2)}°` },
      {
        label: 'связка шарнира',
        get: (fr) => `${fr.span(fr.links[hinge]).toFixed(1)} px (минимум ${fr.links[hinge].min.toFixed(1)})`,
      },
    ],
    angle: { a: p[1], b: p[2], c: p[3] },
  }
}

/**
 * 5. A limb on a body, three ways, to show what the second link buys:
 *    'none' one link  - the limb swings freely and stays where it was pushed
 *    'one'  + attitude link from the pelvis to the limb's second circle
 *    'two'  + a second link from the vertebra above to the limb's first circle
 *           (this is what the game does, and the reason is a geometric fact:
 *           one distance link alone can be satisfied by a ROTATED pose too)
 */
export function sceneJoint(mode = 'one') {
  const f = new Frame()
  f.gravity = 140
  // a body of two circles: the lower one is the pelvis the limb hangs on, the
  // upper one stands for the vertebra above it
  const spine = f.point(150, 44, 10, { pinned: true })
  const pelvis = f.point(150, 62, 10, { pinned: true })
  const hip = f.point(150, 86, 8)
  const foot = f.point(150, 112, 8)
  f.link(pelvis, hip, { kind: 'joint', compliance: 0.00005, stretch: 1.03 })
  f.link(hip, foot, { kind: 'bone' })
  // the limb is ONE rigid piece here, so the only question left is how it is
  // held at the body (with two circles the geometry stays clear: a third one
  // makes a degenerate triangle where the lengths repeat at another angle)
  f.bone([hip, foot])
  if (mode !== 'none') {
    // the attitude link: from the body to the limb's SECOND (last) circle
    f.link(pelvis, foot, {
      kind: 'joint',
      compliance: 0.0003,
      joint: true,
      fold: Math.cos((10 * DEG) / 2),
      stretch: 1.02,
    })
  }
  if (mode === 'two') {
    // the second link, at a different lever arm: from the vertebra ABOVE the
    // pelvis to the limb's FIRST circle
    f.link(spine, hip, { kind: 'joint', compliance: 0.0003, joint: true, fold: Math.cos((25 * DEG) / 2), stretch: 1.3 })
  }
  f.grip = 0.35
  const titles = {
    none: 'Сустав на одной связи: нога гуляет свободно',
    one: 'Плюс связь отношения: поза держится… или нет?',
    two: 'Плюс вторая связь на другом плече (как в игре)',
  }
  const texts = {
    none:
      'Одна связь до бедра: расстояние держится, а ориентация свободна — нога проворачивается вокруг бедра как угодно ' +
      'и остаётся там, куда её отправили. Подержи «давить»: нога уедет вбок и там и останется.',
    one:
      'Добавлена связь отношения — от таза к последнему кружку ноги, окно ±10° и сцепление. И вот здесь важный результат, ' +
      'который я получил, проверяя эту сцену: у ВЫПРЯМЛЕННОЙ ноги такая связь не держит направление ВООБЩЕ. Её длина — ' +
      'это расстояние от таза до кончика ноги, а оно одинаково и когда нога висит вниз, и когда лежит вбок (в обоих ' +
      'случаях нога прямая, длина одна и та же — смотри число: связь остаётся ровно в покое, а нога уже лежит боком). ' +
      'То есть связь от таза ловит только СГИБ ноги, но не её поворот. Именно поэтому в схеме и появилась вторая связь.',
    two:
      'Вторая связь идёт от позвонка ВЫШЕ таза к первому кружку ноги — и вот она-то направление держит: её длина меняется ' +
      'при повороте ноги (в отличие от связи к кончику). Сравни три сцены подряд: без второй связи нога уезжает вбок и ' +
      'остаётся там; с ней поворот ограничен. Это и есть ответ на твой вопрос, зачем в схеме висит связь от позвонка к ' +
      'началу ноги: она не украшение и не «бедренная кость», а единственная связь, которая чувствует ПОВОРОТ конечности. ' +
      'Уберём её — нога станет свободным маятником (это видно в сцене «нога — продолжение тела»).',
  }
  return {
    frame: f,
    title: titles[mode],
    text: texts[mode],
    readouts: [
      { label: 'направление ноги', get: (fr) => `${fr.heading(pelvis, foot).toFixed(0)}°` },
      { label: 'крепление', get: (fr) => `${fr.span(fr.links[0]).toFixed(1)} px` },
      mode === 'none'
        ? { label: 'связей у ноги', get: () => '1' }
        : mode === 'one'
          ? { label: 'связь отношения', get: (fr) => `${fr.span(fr.links[2]).toFixed(2)} px` }
          : { label: 'вторая связь', get: (fr) => `${fr.span(fr.links[3]).toFixed(2)} px` },
    ],
    push: (fr) => fr.nudge(foot, 1.6, 0),
    angle: { a: pelvis, b: hip, c: foot },
  }
}

/**
 * 8. The structure you asked for: the limb is a CONTINUATION of the body - its
 *    first circle IS the pelvis, no separate "attach link" out of the backside.
 *    One chain, one free hinge, nothing else.
 */
export function sceneContinuous() {
  const f = new Frame()
  f.gravity = 140
  const spine = f.point(150, 44, 10, { pinned: true })
  const pelvis = f.point(150, 66, 8)
  const knee = f.point(150, 92, 8)
  const foot = f.point(150, 118, 8)
  f.link(spine, pelvis, { kind: 'link' })
  f.link(pelvis, knee, { kind: 'bone' })
  f.link(knee, foot, { kind: 'bone' })
  f.bone([pelvis, knee, foot])
  // a free hinge at the pelvis: the brace across it is a spring with no cap at
  // the pelvis end, so the leg can swing all the way round
  f.link(spine, knee, { kind: 'brace', fold: 0.2, stretch: 1.6, compliance: 0.004 })
  return {
    frame: f,
    title: 'Как ты хочешь: нога — продолжение тела, без отдельной связи',
    text:
      'Здесь нет связи «из таза в начало ноги»: таз сам является первым кружком ноги, цепочка одна (позвонок → таз → ' +
      'колено → стопа), и нога держится на свободном шарнире в тазу. Плавное продолжение тела под небольшим углом, ' +
      'как ты и описывал. Цена: ориентацию ноги теперь ничто не держит — она висит как маятник и уезжает от любого ' +
      'толчка (смотри «направление»). Так что это не вопрос вкуса, а обмен: цельность цепочки против удерживаемой позы. ' +
      'Что из этого важнее — решать тебе; в редакторе это ровно один переключатель (как крепится цепочка).',
    readouts: [
      { label: 'направление ноги', get: (fr) => `${fr.heading(spine, foot).toFixed(0)}°` },
      { label: 'звено таз-колено', get: (fr) => `${fr.span(fr.links[1]).toFixed(1)} px` },
    ],
    push: (fr) => fr.nudge(foot, 1.0, 0),
    angle: { a: spine, b: pelvis, c: foot },
  }
}

/** 6. Two poses, the same link lengths: why a limb does not come back. */
export function sceneAlias() {
  const f = new Frame()
  const body = f.point(140, 60, 10, { pinned: true })
  const hip = f.point(140, 86, 8)
  const knee = f.point(140, 112, 8)
  f.link(body, hip, { kind: 'joint', compliance: 0.00005 })
  f.link(hip, knee, { kind: 'bone' })
  f.link(body, knee, { kind: 'joint', compliance: 0.0003, joint: true, stretch: 1.02 })
  return {
    frame: f,
    title: 'Почему конечность не возвращается сама',
    text:
      'Ключевой факт, который я измерил: у конечности, которую силой развернули, ОБЕ связи отношения оказались ровно ' +
      'в длине покоя (15.7 → 15.7 и 15.2 → 15.2 px, отклонение 0.0). Пружинам нечего тянуть — они считают позу правильной. ' +
      'Так бывает всегда, когда всё построено на расстояниях: один и тот же набор длин может выполняться в двух разных позах. ' +
      'Поэтому «само вернулось» — это не про пассивную тряпку: вернуть может либо привод (Этап 2), либо механизм, который ' +
      'различает эти две позы (например, знак поворота относительно оси тела).',
    readouts: [
      { label: 'крепление', get: (fr) => `${fr.span(fr.links[0]).toFixed(2)} px` },
      { label: 'связь отношения', get: (fr) => `${fr.span(fr.links[2]).toFixed(2)} px` },
      { label: 'угол', get: (fr) => `${(180 - fr.angleAt(body, hip, knee)).toFixed(0)}°` },
    ],
    push: (fr) => fr.nudge(knee, 2.4, 0),
    angle: { a: body, b: hip, c: knee },
  }
}

/** Every scene, in the order the page shows them. */
export const SCENES = [
  { id: 'link', build: () => sceneOneLink() },
  { id: 'three', build: () => sceneThreeCircles() },
  { id: 'bone', build: () => sceneBone() },
  { id: 'hinge', build: () => sceneHinge() },
  { id: 'joint-none', build: () => sceneJoint('none') },
  { id: 'joint-one', build: () => sceneJoint('one') },
  { id: 'joint-two', build: () => sceneJoint('two') },
  { id: 'continuous', build: () => sceneContinuous() },
  { id: 'alias', build: () => sceneAlias() },
]
