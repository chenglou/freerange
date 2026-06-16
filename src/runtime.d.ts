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
  export function test(name: string, run: () => void | Promise<void>, timeout?: number): void
}
