// Child processes of the parents (run.ts, scoring.ts, witness-run.ts): one `bun worker.ts <job>` per job, JSON lines on
// stdout, killed after a heartbeat timeout or a hard limit.
import {realpathSync} from 'node:fs'
import {decodeJson, encodeJson} from './encode.ts'
import type {ChildLine, DoneLine, Job} from './types.ts'

const WORKER = realpathSync(new URL('./worker.ts', import.meta.url).pathname)

export type ChildRun = {exitCode: number | null; timedOut: string | null; stderr: string; done: DoneLine | null; ms: number}

export async function runChild(job: Job, hardLimitMs: number, heartbeatTimeoutMs: number, onLine: (line: ChildLine) => void): Promise<ChildRun> {
  const childStart = performance.now()
  const child = Bun.spawn(['bun', WORKER, encodeJson(job)], {stdout: 'pipe', stderr: 'pipe'})
  let lastSeen = performance.now()
  let timedOut: string | null = null
  let done: DoneLine | null = null
  const timer = setInterval(() => {
    const now = performance.now()
    if (now - lastSeen > heartbeatTimeoutMs) timedOut ??= `no output for ${Math.round((now - lastSeen) / 1000)} s`
    if (now - childStart > hardLimitMs) timedOut ??= `past the hard limit of ${Math.round(hardLimitMs / 1000)} s`
    if (timedOut != null) child.kill('SIGKILL')
  }, 500)
  const stderrText = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    lastSeen = performance.now()
    pending += decoder.decode(chunk.value, {stream: true})
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = decodeJson(pending.slice(0, newline)) as ChildLine
      pending = pending.slice(newline + 1)
      if (line.type === 'done') done = line
      onLine(line)
      newline = pending.indexOf('\n')
    }
  }
  const exitCode = await child.exited
  clearInterval(timer)
  const stderr = await stderrText
  return {exitCode, timedOut, stderr: stderr.slice(-4000), done, ms: performance.now() - childStart}
}
