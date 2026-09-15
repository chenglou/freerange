import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  entry: ['demo/index.ts', 'eval/build-corpus.ts', 'eval/dev-oracle/oracle.ts', 'eval/lib/runtime-child.ts', 'eval/score.ts', 'src/index.ts', 'video_exp_0/index.ts', 'video_exp_1/index.ts'],
  ignore: [
    '.claude/workflows/**', // named Workflow scripts, invoked by the agent harness, not imported
    'eval/dev-oracle/tests/**/*.ts',
    'eval/tests/**/*.ts',
    'tests/**/*.ts',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
