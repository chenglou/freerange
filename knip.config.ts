import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  entry: ['{demo,src,video_exp_0,video_exp_1}/index.ts', 'eval/lib/runtime-child.ts', 'eval/score.ts'],
  ignore: [
    '.claude/workflows/**', // named Workflow scripts, invoked by the agent harness, not imported
    'eval/examples/**', // corpus trees the scorer copies and analyzes, not imported
    'eval/tests/**/*.ts',
    'tests/**/*.ts',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
