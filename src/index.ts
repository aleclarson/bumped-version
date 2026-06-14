#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

type PackageJson = {
  name?: unknown
  version?: unknown
  private?: unknown
}

type GitCommand = (args: string[]) => string

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/
const commitTypePattern = /^(fix|feat|docs|refactor)(?:\([^)]*\))?!?:/
const ciCommitPattern = /^\w+\(ci\)/
const breakingCommitPattern = /^(fix|feat|docs|refactor)(?:\([^)]*\))?!:/
const featCommitPattern = /^feat(?:\([^)]*\))?!?:/

export function getBumpedVersion(
  packageDir: string,
  git: GitCommand = (args) =>
    execFileSync('git', args, {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
) {
  const packageJson = readPackageJson(packageDir)

  if (packageJson.private === true) {
    throw new Error('package.json must not have private: true')
  }

  if (typeof packageJson.version !== 'string') {
    throw new Error('package.json must have a string version')
  }

  const versionMatch = versionPattern.exec(packageJson.version)
  if (!versionMatch) {
    throw new Error('package.json version must use x.y.z semver')
  }

  if (packageJson.version === '0.0.0') {
    return '0.1.0'
  }

  const tagName = getTagName(packageDir, packageJson)
  const tagCommit = git(['rev-list', '-n', '1', tagName])

  if (!tagCommit) {
    throw new Error(`tag not found: ${tagName}`)
  }

  git(['merge-base', '--is-ancestor', tagCommit, 'HEAD'])

  const repoRoot = git(['rev-parse', '--show-toplevel'])
  const packagePathspec = relative(repoRoot, packageDir) || '.'
  const subjects = git([
    'log',
    `${tagCommit}..HEAD`,
    '--format=%s',
    '--extended-regexp',
    '--grep=^(fix|feat|docs|refactor)(\\([^)]*\\))?!?:',
    '--',
    packagePathspec,
  ])
    .split('\n')
    .map((subject) => subject.trim())
    .filter(Boolean)
    .filter((subject) => commitTypePattern.test(subject))
    .filter((subject) => !ciCommitPattern.test(subject))

  return bumpVersion(packageJson.version, subjects)
}

function readPackageJson(packageDir: string) {
  const packageJsonPath = resolve(packageDir, 'package.json')

  let packageJson: PackageJson
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  } catch (error) {
    throw new Error(`failed to read package.json in ${packageDir}`, {
      cause: error,
    })
  }

  return packageJson
}

function getTagName(packageDir: string, packageJson: PackageJson) {
  if (existsSync(resolve(packageDir, '.git'))) {
    return packageJson.version as string
  }

  if (typeof packageJson.name !== 'string') {
    throw new Error('package.json must have a string name for monorepo tags')
  }

  const unscopedName = packageJson.name.replace(/^@[^/]+\//, '')
  return `${unscopedName}@${packageJson.version}`
}

function bumpVersion(version: string, subjects: string[]) {
  const versionMatch = versionPattern.exec(version)
  if (!versionMatch) {
    throw new Error('package.json version must use x.y.z semver')
  }

  let major = Number(versionMatch[1])
  let minor = Number(versionMatch[2])
  let patch = Number(versionMatch[3])
  const hasBreakingCommit = subjects.some((subject) => breakingCommitPattern.test(subject))
  const hasFeatCommit = subjects.some((subject) => featCommitPattern.test(subject))

  if (major === 0) {
    if (hasBreakingCommit) {
      minor += 1
      patch = 0
    } else if (hasFeatCommit || subjects.length > 0) {
      patch += 1
    }

    return `${major}.${minor}.${patch}`
  }

  if (hasBreakingCommit) {
    major += 1
    minor = 0
    patch = 0
  } else if (hasFeatCommit) {
    minor += 1
    patch = 0
  } else if (subjects.length > 0) {
    patch += 1
  }

  return `${major}.${minor}.${patch}`
}

export function main(argv = process.argv.slice(2)) {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
  })

  if (positionals.length > 1) {
    throw new Error('usage: bumped-version [package-dir]')
  }

  return getBumpedVersion(resolve(positionals[0] ?? process.cwd()))
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  try {
    console.log(main())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
