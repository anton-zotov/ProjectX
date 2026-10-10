import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModules, makeElement } from './helpers.mjs'

const INPUT = '/src/input.ts'
const { mods, close } = await loadModules([INPUT])
const { Input } = mods[INPUT]
test.after(close)

const makeTarget = () => makeElement('window')

test('keys are tracked on keydown and released on keyup', () => {
  const target = makeTarget()
  const input = new Input(target)

  assert.equal(input.isDown('ArrowLeft'), false)
  target.dispatch('keydown', { code: 'ArrowLeft' })
  assert.equal(input.isDown('ArrowLeft'), true)
  assert.equal(input.isDown('ArrowRight'), false, 'other keys stay untouched')

  target.dispatch('keyup', { code: 'ArrowLeft' })
  assert.equal(input.isDown('ArrowLeft'), false)
})

test('axis() returns a normalized -1 / 0 / 1 value', () => {
  const target = makeTarget()
  const input = new Input(target)

  assert.equal(input.axis('ArrowLeft', 'ArrowRight'), 0)
  target.dispatch('keydown', { code: 'ArrowRight' })
  assert.equal(input.axis('ArrowLeft', 'ArrowRight'), 1)
  target.dispatch('keydown', { code: 'ArrowLeft' })
  assert.equal(input.axis('ArrowLeft', 'ArrowRight'), 0, 'both keys cancel out')
  target.dispatch('keyup', { code: 'ArrowRight' })
  assert.equal(input.axis('ArrowLeft', 'ArrowRight'), -1)

  target.dispatch('keydown', { code: 'ArrowDown' })
  assert.equal(input.axis('ArrowUp', 'ArrowDown'), 1)
  target.dispatch('keydown', { code: 'ArrowUp' })
  assert.equal(input.axis('ArrowUp', 'ArrowDown'), 0)
})

test('losing focus releases every held key (no stuck movement)', () => {
  const target = makeTarget()
  const input = new Input(target)

  target.dispatch('keydown', { code: 'ArrowLeft' })
  target.dispatch('keydown', { code: 'ArrowUp' })
  target.dispatch('blur')

  assert.equal(input.isDown('ArrowLeft'), false)
  assert.equal(input.isDown('ArrowUp'), false)
  assert.equal(input.axis('ArrowLeft', 'ArrowRight'), 0)
})
