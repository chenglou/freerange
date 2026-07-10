import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  entry: ['demo/index.ts', 'src/index.ts'],
  ignore: [
    '.claude/workflows/**', // named Workflow scripts, invoked by the agent harness, not imported
    'tests/**/*.ts',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
