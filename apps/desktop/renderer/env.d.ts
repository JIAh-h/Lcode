import type { LcodeBridge } from '../electron/preload.ts'

declare global {
  interface Window {
    lcode: LcodeBridge
  }
}

export {}
