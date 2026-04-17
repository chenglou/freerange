declare const Bun: {
  argv: string[]
  file(path: string | URL): {
    text(): Promise<string>
  }
}

declare const process: {
  exitCode?: number
}
