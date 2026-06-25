import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  entry: ['src/index.ts'],
  ignore: ['tests/**/*.ts'],
  ignoreExportsUsedInFile: true,
}

export default config
