declare const Bun: {
  argv: string[]
  env: Record<string, string | undefined>
  file(path: string | URL): {
    text(): Promise<string>
  }
  write(path: string | URL, data: string): Promise<number>
  spawnSync(options: {
    cmd: string[]
    cwd?: string
    stdout?: 'pipe'
    stderr?: 'pipe'
  }): {
    exitCode: number
    stdout: Uint8Array
    stderr: Uint8Array
  }
}

declare const process: {
  exitCode?: number
  execPath: string
}

declare module 'bun:test' {
  type Matchers<T> = {
    readonly not: Matchers<T>
    toBe(expected: T): void
    toBeDefined(): void
    toContain(expected: T extends string ? string : T extends readonly (infer Item)[] ? Item : never): void
    toEqual(expected: unknown): void
    toHaveLength(expected: number): void
    toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): void
  }

  export function expect<T>(actual: T): Matchers<T>
  export function describe(name: string, register: () => void): void
  export function setDefaultTimeout(milliseconds: number): void
  export function test(name: string, run: () => void | Promise<void>, timeout?: number): void
}
