// Whole writes to a file descriptor the sweep child's parent reads through a pipe. Bun gives the child a non-blocking pipe,
// so writeSync throws EAGAIN while the pipe is full, e.g. after project code writes 1 MB per call; the child then waits 1 ms
// and retries instead of dying on its own protocol line.
import {writeSync} from 'node:fs'

export const MAX_PIPE_WAITS = 60_000 // 1 ms each, about 60 s; the parent's heartbeat or output cap stops a child sooner

const pause = new Int32Array(new SharedArrayBuffer(4))

/** Writes every byte of `data` to `fd`, waiting 1 ms after each EAGAIN, at most `maxWaits` times in one write. */
export function writeAll(fd: number, data: string | Uint8Array, maxWaits = MAX_PIPE_WAITS): void {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data
  let offset = 0
  let waits = 0
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset)
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EAGAIN' || waits >= maxWaits) throw error
      waits += 1
      Atomics.wait(pause, 0, 0, 1)
    }
  }
}
