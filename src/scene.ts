import type { Input } from './input'

export interface GameContext {
  ctx: CanvasRenderingContext2D
  input: Input
  /** Virtual resolution the game renders at. */
  width: number
  height: number
}

export interface Scene {
  update(dt: number, game: GameContext): void
  render(game: GameContext): void
}
