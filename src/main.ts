import './style.css'
import { Engine } from './engine'
import { HelloWorldScene } from './scenes/helloWorld'

const canvas = document.querySelector<HTMLCanvasElement>('#game')!

const engine = new Engine(canvas, new HelloWorldScene(), {
  width: 320,
  height: 180,
})

engine.start()
