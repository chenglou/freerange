import {verifyFitFiles} from './src/check.ts'

const demoContractPaths = [
  '../vibescript/demos/draggable-cards/swap-layout.ts',
  '../vibescript/demos/gesture-flick-snap-target/snap-layout.ts',
  '../vibescript/demos/life-calendar/grid-sizing.ts',
  '../vibescript/demos/mobile-test-standalone/index.ts',
  '../vibescript/demos/nicer-hacker-news/hn-thread-layout.ts',
  '../vibescript/demos/photo-gallery/layout.ts',
  '../vibescript/demos/photo-gallery/prompt-layout.ts',
  '../vibescript/demos/predictive-keyframes/index.ts',
  '../vibescript/demos/scroll-anchor/anchor-layout.ts',
  '../pretext/pages/demos/bubbles-shared.ts',
  '../pretext/pages/demos/dynamic-layout.ts',
  '../pretext/pages/demos/markdown-chat.model.ts',
  '../pretext/pages/demos/rich-note.model.ts',
  '../pretext/pages/demos/wrap-geometry.ts',
]

const expectedPassCount = 122
const report = await verifyFitFiles(demoContractPaths)

if (report.phase !== 'ready' || report.summary.pass !== expectedPassCount) {
  console.error(JSON.stringify(report, null, 2))
}
if (report.phase !== 'ready') {
  process.exitCode = 1
} else if (report.summary.pass !== expectedPassCount) {
  console.error(`Expected ${expectedPassCount} passing demo checks, got ${report.summary.pass}`)
  process.exitCode = 1
} else {
  console.log(`demo contracts: ${report.summary.pass} pass, 0 fail, 0 unknown`)
}
