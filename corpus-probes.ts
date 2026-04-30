import * as ts from 'typescript'

export type CorpusSweep = {
  name: string
  paths: string[]
}

export const corpusRoot = '/Users/chenglou/github/freerange-corpus'

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']
const ignoredDirectoryGlobs = [
  '**/.git/**',
  '**/.next/**',
  '**/build/**',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/out/**',
  '**/tmp/**',
]

export function corpusRootExists(root = corpusRoot) {
  return ts.sys.directoryExists(root)
}

export function discoverCorpusSweeps(root = corpusRoot): CorpusSweep[] {
  if (!corpusRootExists(root)) return []

  const files = ts.sys.readDirectory(root, sourceExtensions, ignoredDirectoryGlobs)
    .map(normalizePath)
    .filter(isRuntimeSourcePath)
    .filter(hasFitComment)
    .sort(compareText)
  const groups = new Map<string, CorpusSweep>()

  for (const file of files) {
    const projectName = corpusProjectName(root, file)
    const configFile = nearestConfigFile(file)
    const name = corpusSweepName(root, projectName, configFile)
    const group = groups.get(name) ?? {name, paths: []}
    group.paths.push(file)
    groups.set(name, group)
  }

  return Array.from(groups.values())
    .map(group => ({...group, paths: group.paths.sort(compareText)}))
    .sort((left, right) => compareText(left.name, right.name))
}

function hasFitComment(file: string) {
  return ts.sys.readFile(file)?.includes('@fit') === true
}

function isRuntimeSourcePath(file: string) {
  return !file.endsWith('.d.ts')
    && !file.endsWith('.d.mts')
    && !file.endsWith('.d.cts')
}

function nearestConfigFile(file: string) {
  const configFile = ts.findConfigFile(dirname(file), fileExists, 'tsconfig.json')
  return configFile == null ? null : normalizePath(configFile)
}

function fileExists(file: string) {
  return ts.sys.fileExists(file)
}

function corpusProjectName(root: string, file: string) {
  return relativePath(root, file).split('/')[0] ?? '<root>'
}

function corpusSweepName(root: string, projectName: string, configFile: string | null) {
  if (configFile == null) return projectName
  const configDir = dirname(configFile)
  const relativeConfigDir = relativePath(root, configDir)
  if (relativeConfigDir === projectName) return projectName
  return relativeConfigDir.startsWith(`${projectName}/`)
    ? `${projectName}:${relativeConfigDir.slice(projectName.length + 1)}`
    : projectName
}

function relativePath(root: string, file: string) {
  const normalizedRoot = normalizePath(root).replace(/\/$/, '')
  const normalizedFile = normalizePath(file)
  return normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile
}

function dirname(path: string) {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/')
}

function compareText(left: string, right: string) {
  return left.localeCompare(right)
}
