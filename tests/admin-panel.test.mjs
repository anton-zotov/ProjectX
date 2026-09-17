/**
 * The admin panel must FIT: every slider name and its number have to be inside
 * the panel, and the panel itself inside the screen. This is a regression guard
 * for a real bug - the rows were one line ("name | track | number"), the panel
 * was 235 px wide, and the numbers were pushed off the right edge of the screen
 * where nobody could see them.
 *
 * There is no browser in this project, so the fit is checked by measurement:
 * the panel's content box against an estimate of the text width in the panel's
 * monospace font. Deliberately generous (7.3 px per character at 12 px).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')

const CHAR_W = 7.3
const VALUE_CHAR_W = 6.7

const px = (value) => Number(String(value).replace('px', ''))
const rule = (selector) => {
  const at = CSS.indexOf(`${selector} {`)
  assert.ok(at >= 0, `the stylesheet has no rule for ${selector}`)
  return CSS.slice(at, CSS.indexOf('}', at))
}

test('the admin panel is narrow enough for a screen and scrolls instead of overflowing', () => {
  const panel = rule('#admin-panel')
  const width = px(/width:\s*([\d.]+px)/.exec(panel)?.[1] ?? 0)
  const maxWidth = /max-width:\s*([^;]+);/.exec(panel)?.[1] ?? ''
  const maxHeight = /max-height:\s*([^;]+);/.exec(panel)?.[1] ?? ''

  assert.ok(width > 0, 'the panel has a width')
  assert.match(maxWidth, /100vw/, 'the panel can never be wider than the window')
  assert.match(maxHeight, /100vh/, 'the panel can never be taller than the window')
  assert.match(panel, /overflow-y:\s*auto/, 'a tall panel scrolls rather than running off the bottom')
})

test('a slider row puts the number beside the name and the track on its own line', () => {
  const row = rule('.row')
  // Two lines: 'label value' over 'slider slider'. On one line the three parts
  // cannot fit, which is what pushed the numbers off the screen.
  assert.match(row, /display:\s*grid/, 'the row is a grid, not one long line')
  assert.match(row, /'label value'/, 'the name and the number share the first line')
  assert.match(row, /'slider slider'/, 'the track takes the whole second line')
  assert.match(rule(".row input[type='range']"), /width:\s*100%/, 'the track fills the panel, so it cannot overflow')
  assert.match(rule(".row input[type='range']"), /min-width:\s*0/, 'the track may shrink instead of pushing the number out')

  // A checkbox row stays one line: a box and a name.
  assert.match(rule('.row.check'), /display:\s*flex/)
})

test('every slider name and value fits into the panel', () => {
  const rows = HTML.match(/<label class="row">[\s\S]*?<\/label>/g) ?? []
  assert.ok(rows.length >= 8, `the panel has its sliders (${rows.length} rows found)`)

  const panel = rule('#admin-panel')
  const width = px(/width:\s*([\d.]+px)/.exec(panel)?.[1] ?? 0)
  const padding = /padding:\s*[\d.]+px\s+([\d.]+)px/.exec(panel)?.[1] ?? '0px'
  const content = width - 2 * px(padding)
  const gap = px(/gap:\s*[\d.]+px\s+([\d.]+)px/.exec(rule('.row'))?.[1] ?? 0)

  for (const row of rows) {
    const label = /<span>([^<]*)<\/span>/.exec(row)?.[1] ?? ''
    const value = /<output[^>]*>([^<]*)<\/output>/.exec(row)?.[1] ?? ''
    assert.ok(label.length > 0, 'every row is named')
    assert.ok(value.length > 0, `"${label}" shows its value instead of an empty box`)

    const needed = label.length * CHAR_W + value.length * VALUE_CHAR_W + gap
    assert.ok(
      needed < content,
      `"${label}" + "${value}" fits the panel (needs ~${needed.toFixed(0)} px of ${content} px)`,
    )
  }
})

test('the value of every slider is wired to a live readout', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const ids = [...HTML.matchAll(/id="(s-[a-z]+)"/g)].map((m) => m[1])
  const outputs = [...HTML.matchAll(/id="(o-[a-z]+)"/g)].map((m) => m[1])

  for (const id of ids) {
    if (id === 's-auto' || id === 's-tuning' || id === 's-skeleton' || id === 's-grid' || id === 's-quality' || id === 's-profiler') {
      continue // checkboxes have no number
    }
    const out = `o-${id.slice(2)}`
    assert.ok(outputs.includes(out), `${id} has a readout ${out}`)
    assert.ok(main.includes(out), `${out} is updated by the panel code`)
  }
})
