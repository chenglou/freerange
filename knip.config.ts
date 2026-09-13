import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  entry: [
    'demo/index.ts',
    'mutation-instrument/report.ts', // also runnable on its own, to rewrite an existing run's report
    'mutation-instrument/run.ts',
    'mutation-instrument/witness-run.ts',
    'mutation-instrument/witness.ts', // spawned by witness-run.ts by path, not imported
    'mutation-instrument/worker.ts', // spawned by run.ts by path, not imported
    'src/index.ts',
    'video_exp_0/index.ts',
    'video_exp_1/index.ts',
  ],
  ignore: [
    '.claude/workflows/**', // named Workflow scripts, invoked by the agent harness, not imported
    'tests/**/*.ts',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
