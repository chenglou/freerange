import type {KnipConfig} from 'knip'

const config: KnipConfig = {
  entry: ['demo/index.ts', 'src/index.ts'],
  ignore: ['tests/**/*.ts'],
  ignoreExportsUsedInFile: true,
}

export default config
