import {verifyFitFiles} from './src/check.ts'

const firstWaveDemoPaths = [
  '../vibescript/demos/draggable-cards/swap-layout.ts',
  '../vibescript/demos/life-calendar/grid-sizing.ts',
  '../vibescript/demos/nicer-hacker-news/hn-thread-layout.ts',
  '../vibescript/demos/photo-gallery/layout-model.ts',
  '../vibescript/demos/photo-gallery/prompt-layout.ts',
  '../vibescript/demos/scroll-anchor/anchor-layout.ts',
  '../pretext/pages/demos/dynamic-layout.ts',
  '../pretext/pages/demos/rich-note.model.ts',
  '../pretext/pages/demos/wrap-geometry.ts',
]

const expectedPassCount = 72
const report = await verifyFitFiles(firstWaveDemoPaths)

console.log(JSON.stringify(report, null, 2))

if (report.phase !== 'ready') {
  process.exitCode = 1
} else if (report.summary.pass !== expectedPassCount) {
  console.error(`Expected ${expectedPassCount} passing demo checks, got ${report.summary.pass}`)
  process.exitCode = 1
}
