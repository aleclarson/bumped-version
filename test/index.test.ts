import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { getBumpedVersion, main } from '../src/index'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    execFileSync('rm', ['-rf', dir])
  }
})

describe('getBumpedVersion', () => {
  it('returns 0.1.0 early for 0.0.0 packages', () => {
    const packageDir = createPackage({ version: '0.0.0' })

    expect(
      getBumpedVersion(packageDir, () => {
        throw new Error('git should not be called')
      }),
    ).toBe('0.1.0')
  })

  it('uses plain version tags when the package directory is a git repo', () => {
    const packageDir = createPackage({ version: '1.2.3' })
    mkdirSync(join(packageDir, '.git'))
    const calls: string[][] = []

    const version = getBumpedVersion(packageDir, (args) => {
      calls.push(args)
      if (args[0] === 'rev-list') return 'abc123'
      if (args[0] === 'rev-parse') return packageDir
      if (args[0] === 'log') return 'fix: patch bug'
      return ''
    })

    expect(version).toBe('1.2.4')
    expect(calls[0]).toEqual(['rev-list', '-n', '1', '1.2.3'])
  })

  it('uses unscoped name tags when the package directory is inside a monorepo', () => {
    const packageDir = createPackage({
      name: '@scope/widget',
      version: '1.2.3',
    })
    const repoRoot = join(packageDir, '..', '..')
    const calls: string[][] = []

    getBumpedVersion(packageDir, (args) => {
      calls.push(args)
      if (args[0] === 'rev-list') return 'abc123'
      if (args[0] === 'rev-parse') return repoRoot
      if (args[0] === 'log') return ''
      return ''
    })

    expect(calls[0]).toEqual(['rev-list', '-n', '1', 'widget@1.2.3'])
    expect(calls.at(-1)).toContain('packages/widget')
  })

  it('bumps major for breaking commits', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(getBumpedVersion(packageDir, createGit(packageDir, 'feat!: rewrite API'))).toBe('2.0.0')
  })

  it('bumps minor for feature commits', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(getBumpedVersion(packageDir, createGit(packageDir, 'feat(ui): add option'))).toBe(
      '1.3.0',
    )
  })

  it('bumps patch for non-feature included commits and filters ci commits', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(
      getBumpedVersion(packageDir, createGit(packageDir, 'docs: update readme\nfix(ci): pipeline')),
    ).toBe('1.2.4')
  })

  it('returns current version when no included commits exist', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(getBumpedVersion(packageDir, createGit(packageDir, 'fix(ci): pipeline'))).toBe('1.2.3')
  })

  it('treats 0.x.y as x major and y as minor or patch', () => {
    const packageDir = createPackage({ version: '0.4.7' })

    expect(getBumpedVersion(packageDir, createGit(packageDir, 'feat!: rewrite API'))).toBe('0.5.0')
    expect(getBumpedVersion(packageDir, createGit(packageDir, 'feat: add option'))).toBe('0.4.8')
    expect(getBumpedVersion(packageDir, createGit(packageDir, 'refactor: simplify'))).toBe('0.4.8')
  })
})

describe('main', () => {
  it('parses an optional package directory positional', () => {
    const packageDir = createPackage({ version: '0.0.0' })

    expect(main([packageDir])).toBe('0.1.0')
  })
})

function createPackage(packageJson: { name?: string; version: string; private?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'bumped-version-'))
  const packageDir = packageJson.name?.includes('widget') ? join(root, 'packages', 'widget') : root

  tempDirs.push(root)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageJson.name ?? 'bumped-version-test',
      version: packageJson.version,
      private: packageJson.private,
    }),
  )

  return packageDir
}

function createGit(packageDir: string, subjects: string) {
  return (args: string[]) => {
    if (args[0] === 'rev-list') return 'abc123'
    if (args[0] === 'rev-parse') return packageDir
    if (args[0] === 'log') return subjects
    return ''
  }
}
