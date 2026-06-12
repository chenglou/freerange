import type {KnipConfig} from 'knip'

// fr.ts is the published CLI (binary in package.json). bun-run scripts in package.json
// are auto-detected. The remaining listed entries are scripts not in package.json or
// pattern fixtures loaded by file path (so they have no incoming module imports).
//
// ignoreExportsUsedInFile silences "exported but only used in this file" noise.
// Real dead code (unused files, unused exports, unused deps/binaries) still gets flagged.
const config: KnipConfig = {
  entry: [
    'verify-*.ts',
    'corpus-probes.ts',
    'snapshot.ts',
    // Fixture files loaded by file path inside test suites and the verify scripts
    'tests/patterns/patterns.ts',
    'tests/patterns/loop-patterns.ts',
    'tests/patterns/negative-patterns.ts',
    'tests/patterns/negative-shadowed-catalog.ts',
    'tests/imports/import-patterns.ts',
    'tests/imports/import-pattern-*.{ts,tsx}',
    'tests/imports/negative-import-*.ts',
    'tests/interpreter-matrix/interpreter-matrix-*.ts',
    'photo-gallery/index.ts',
    'tests/vocab/*.ts',
  ],
  ignoreDependencies: [
    // Workspace-package fixtures resolved via tsconfig paths
    '@fit-fixtures/.*',
  ],
  ignore: [
    // Workspace-package fixtures: source and generated .d.ts loaded via @fit-fixtures/* aliases
    'import-pattern-declared-package*/**',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
