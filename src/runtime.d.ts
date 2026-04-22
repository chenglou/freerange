declare const Bun: {
  argv: string[]
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
