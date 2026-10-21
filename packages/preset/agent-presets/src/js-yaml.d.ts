declare module 'js-yaml' {
  export function load(input: string): unknown
  export function dump(value: unknown, options?: { sortKeys?: boolean; noRefs?: boolean; lineWidth?: number }): string
}
