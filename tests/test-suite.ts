import {test} from 'bun:test'

export type TestSuite = {
  fail(): void
}

export function testSuite(name: string, run: (suite: TestSuite) => void | Promise<void>) {
  test(name, async () => {
    let failed = false
    await run({
      fail() {
        failed = true
      },
    })
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (failed) throw new Error(`${name} failed; see diagnostics above`)
  }, 300_000)
}
