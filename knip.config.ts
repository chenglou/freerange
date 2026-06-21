import type {KnipConfig} from 'knip'

// fr.ts is the published CLI (binary in package.json). bun-run scripts in package.json
// are auto-detected. The remaining listed entries are pattern fixtures loaded by file
// path, so they have no incoming module imports.
//
// ignoreExportsUsedInFile silences "exported but only used in this file" noise.
// Real dead code (unused files, unused exports, unused deps/binaries) still gets flagged.
const config: KnipConfig = {
  entry: [
    'snapshot.ts',
    'tests/orchestration/fixtures/*.ts',
    // Fixture files loaded by file path inside test suites
    'tests/patterns/patterns.ts',
    'tests/patterns/loop-patterns.ts',
    'tests/patterns/previous-index-patterns.ts',
    'tests/patterns/negative-patterns.ts',
    'tests/patterns/negative-shadowed-catalog.ts',
    'tests/imports/adjacent-summary-patterns.ts',
    'tests/imports/import-patterns.ts',
    'tests/imports/import-pattern-*.{ts,tsx}',
    'tests/imports/negative-adjacent-summary.ts',
    'tests/imports/negative-import-*.ts',
    'tests/interpreter-matrix/interpreter-matrix-*.ts',
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
