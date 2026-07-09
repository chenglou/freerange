import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  entry: ['demo/index.ts', 'src/index.ts', 'survey.ts'],
  ignore: [
    '.claude/workflows/**', // named Workflow scripts, invoked by the agent harness, not imported
    'tests/**/*.{ts,tsx}',
  ],
  // Nothing imports @types/react by name: the compiler resolves it implicitly for
  // react/jsx-runtime when single-file analysis checks a .tsx source.
  ignoreDependencies: ['@types/react'],
  ignoreExportsUsedInFile: true,
}

export default config
