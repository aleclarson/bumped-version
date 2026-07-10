#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type PackageJson = {
  name?: unknown
  version?: unknown
  private?: unknown
}

/**
 * Synchronous git adapter used by {@link getBumpedVersion}.
 *
 * Receives git arguments without the leading `git` executable name and returns stdout as a string.
 */
export type GitCommand = (args: string[]) => string

/**
 * Inputs for {@link getBumpedVersion}.
 */
export type GetBumpedVersionInput = {
  /**
   * Allow version inference when `package.json` has `private: true`.
   *
   * Private packages are rejected by default. Enable this for repositories that use a private
   * manifest to track a release version without publishing that manifest as a package.
   */
  allowPrivate?: boolean

  /**
   * Repository-relative path whose commits should affect the computed version.
   *
   * For example, use `template/` to version a root manifest from commits that touch only that
   * directory. By default, commits are filtered to `packageDir`.
   */
  commitPath?: string

  /**
   * Directory that contains the `package.json` whose next version should be computed.
   *
   * Git commands run from this directory by default, so in a monorepo this should be the
   * package directory rather than the repository root.
   */
  packageDir: string

  /**
   * Optional git adapter used by tests or callers that need to run git in a custom environment.
   *
   * The adapter receives the git arguments without the leading `git` executable name and must
   * return stdout as a string. The default adapter runs `git` synchronously in `packageDir`.
   */
  git?: GitCommand

  /**
   * Receives progress messages, including default git commands, when the caller wants trace output.
   */
  verbose?: (message: string) => void
}

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/
const commitTypePattern = /^(fix|feat|docs|refactor)(?:\([^)]*\))?!?:/
const ciCommitPattern = /^\w+\(ci\)/
const breakingCommitPattern = /^(fix|feat|docs|refactor)(?:\([^)]*\))?!:/
const featCommitPattern = /^feat(?:\([^)]*\))?!?:/

/**
 * Computes the next publish version for a package from its current `package.json` version and
 * conventional commit subjects since the package's release tag.
 *
 * By default, the package must be publishable (`private` must not be `true`); callers can opt in
 * to private manifests with `allowPrivate`. Its version must use `x.y.z` semver. A `0.0.0`
 * package returns `0.1.0` without reading git history. Other packages look up the current release
 * tag, ensure it is an ancestor of `HEAD`, then scan commits that touched `commitPath` or, by
 * default, `packageDir`.
 *
 * Included commit types are `fix`, `feat`, `docs`, and `refactor`; `(ci)`-scoped commits are
 * ignored. Breaking included commits bump the major version for `1.x` packages and the minor
 * version for `0.x` packages. Feature commits bump the minor version for `1.x` packages and the
 * patch version for `0.x` packages. Other included commits bump the patch version.
 */
export function getBumpedVersion(input: GetBumpedVersionInput) {
  const { packageDir } = input
  const verbose = input.verbose ?? (() => {})
  const git =
    input.git ??
    ((args) => {
      verbose(`git ${args.join(' ')}`)
      return execFileSync('git', args, {
        cwd: packageDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    })

  verbose(`reading package in ${packageDir}`)
  const packageJson = readPackageJson(packageDir)

  if (packageJson.private === true && !input.allowPrivate) {
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
    verbose('package version is 0.0.0; returning initial release version 0.1.0')
    return '0.1.0'
  }

  verbose(`current package version is ${packageJson.version}`)
  const { tagName, tagCommit } = findReleaseTag(packageDir, packageJson, git, verbose)

  verbose(`found release tag ${tagName} at commit ${tagCommit}`)
  git(['merge-base', '--is-ancestor', tagCommit, 'HEAD'])

  const commitPath = input.commitPath ? `:(top,literal)${input.commitPath}` : '.'
  verbose(
    input.commitPath
      ? `scanning commits that touched ${input.commitPath}`
      : 'scanning commits that touched the package directory',
  )
  const subjects = git([
    'log',
    `${tagCommit}..HEAD`,
    '--format=%s',
    '--extended-regexp',
    '--grep=^(fix|feat|docs|refactor)(\\([^)]*\\))?!?:',
    '--',
    commitPath,
  ])
    .split('\n')
    .map((subject) => subject.trim())
    .filter(Boolean)
    .filter((subject) => commitTypePattern.test(subject))
    .filter((subject) => !ciCommitPattern.test(subject))

  verbose(`found ${subjects.length} release-relevant commit${subjects.length === 1 ? '' : 's'}`)
  const bumpedVersion = bumpVersion(packageJson.version, subjects)
  verbose(`computed bumped version ${bumpedVersion}`)

  return bumpedVersion
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

function getTagNames(packageDir: string, packageJson: PackageJson) {
  const version = packageJson.version as string
  const versionTags = [version, `v${version}`]

  if (existsSync(resolve(packageDir, '.git'))) {
    return versionTags
  }

  if (typeof packageJson.name !== 'string') {
    throw new Error('package.json must have a string name for monorepo tags')
  }

  const unscopedName = packageJson.name.replace(/^@[^/]+\//, '')
  return versionTags.map((versionTag) => `${unscopedName}@${versionTag}`)
}

function findReleaseTag(
  packageDir: string,
  packageJson: PackageJson,
  git: GitCommand,
  verbose: (message: string) => void,
) {
  const tagNames = getTagNames(packageDir, packageJson)

  for (const tagName of tagNames) {
    verbose(`looking up release tag ${tagName}`)

    try {
      const tagCommit = git(['rev-list', '-n', '1', tagName])
      if (tagCommit) {
        return { tagName, tagCommit }
      }
    } catch (error) {
      if (tagName === tagNames.at(-1)) {
        throw new Error(`tag not found: ${tagNames.join(' or ')}`, { cause: error })
      }
    }
  }

  throw new Error(`tag not found: ${tagNames.join(' or ')}`)
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

/**
 * CLI entrypoint used by the `bumped-version` binary.
 *
 * Accepts an optional package directory positional argument, `--allow-private`,
 * `--commit-path <path>`, and `--verbose`/`-v`. Returns the computed version string; the executable
 * wrapper prints it to stdout and writes thrown error messages to stderr.
 */
export function main(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'allow-private': {
        type: 'boolean',
      },
      'commit-path': {
        type: 'string',
      },
      verbose: {
        type: 'boolean',
        short: 'v',
      },
    },
  })
  const verbose = values.verbose
    ? (message: string) => process.stderr.write(`${message}\n`)
    : () => {}

  if (positionals.length > 1) {
    throw new Error('usage: bumped-version [package-dir]')
  }

  return getBumpedVersion({
    allowPrivate: values['allow-private'],
    commitPath: values['commit-path'],
    packageDir: resolve(positionals[0] ?? process.cwd()),
    verbose,
  })
}

function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined) {
  if (!argvPath) {
    return false
  }

  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath)
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  try {
    console.log(main())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
