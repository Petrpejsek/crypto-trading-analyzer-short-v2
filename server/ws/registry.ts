import type { WsCollector } from './wsCollector'

let current: WsCollector | null = null

export function setCollector(c: WsCollector) {
  current = c
}

export function getCollector(): WsCollector | null {
  return current
}


