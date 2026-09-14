// Runs one command in its own process group, so a timeout can stop every process the command started, and records the
// command's peak resident set size through `/usr/bin/time -l`. Every stream is capped: output past the cap is dropped,
// the result says so, and the last bytes are kept so the `time -l` summary at the end of stderr stays readable.
import {spawn} from 'node:child_process'

export type RunLimits = {
  timeoutMs: number
  maxOutputBytes: number
}

export type MeasuredRun = {
  command: string[]
  cwd: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  spawnError: string | null
  wallMs: number
  maxRssBytes: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

const tailBytes = 8192

class CappedOutput {
  private readonly head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer = Buffer.alloc(0)
  truncated = false

  constructor(private readonly capBytes: number) {}

  push(chunk: Buffer): void {
    let rest = chunk
    if (this.headBytes < this.capBytes) {
      const kept = rest.subarray(0, this.capBytes - this.headBytes)
      this.head.push(kept)
      this.headBytes += kept.length
      if (kept.length === rest.length) return
      rest = rest.subarray(kept.length)
    }
    this.truncated = true
    const joined = Buffer.concat([this.tail, rest])
    this.tail = joined.subarray(Math.max(0, joined.length - tailBytes))
  }

  text(): string {
    const head = Buffer.concat(this.head).toString('utf8')
    return this.truncated ? `${head}\n[output truncated]\n${this.tail.toString('utf8')}` : head
  }
}

// macOS `time -l` prints e.g. `  219054080  maximum resident set size`, in bytes. The last match wins, because a nested
// `time -l` inside the command would print its own summary first.
export function parseMaxRssBytes(stderr: string): number | null {
  let bytes: number | null = null
  for (const match of stderr.matchAll(/(\d+)\s+maximum resident set size/g)) bytes = Number(match[1])
  return bytes
}

export function runMeasured(command: string[], cwd: string, limits: RunLimits, measure = true): Promise<MeasuredRun> {
  const argv = measure ? ['/usr/bin/time', '-l', ...command] : command
  const started = performance.now()
  return new Promise(resolve => {
    const stdout = new CappedOutput(limits.maxOutputBytes)
    const stderr = new CappedOutput(limits.maxOutputBytes)
    let timedOut = false
    let spawnError: string | null = null
    const child = spawn(argv[0]!, argv.slice(1), {cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => {
      timedOut = true
      stopGroup(child.pid)
    }, limits.timeoutMs)
    child.on('error', error => {
      spawnError = error.message
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const stderrText = stderr.text()
      resolve({
        command,
        cwd,
        exitCode: code,
        signal,
        timedOut,
        spawnError,
        wallMs: performance.now() - started,
        maxRssBytes: measure ? parseMaxRssBytes(stderrText) : null,
        stdout: stdout.text(),
        stderr: stderrText,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      })
    })
  })
}

function stopGroup(pid: number | undefined): void {
  if (pid == null) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group already exited between the timer firing and the kill.
  }
}
