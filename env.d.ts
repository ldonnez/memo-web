/// <reference types="vite-plugin-pwa/client" />

declare module '*.css' {}

declare module '@fig/lezer-bash' {
  import type { LRParser } from '@lezer/lr'
  export const parser: LRParser
}

interface Highlight {
  constructor(...ranges: Range[])
  add(...ranges: Range[]): void
  delete(...ranges: Range[]): void
  has(range: Range): boolean
  clear(): void
  readonly size: number
  readonly type: 'highlight'
}

declare namespace CSS {
  const highlights: Map<string, Highlight>
}
