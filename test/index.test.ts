import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBumpedVersion, main } from '../src/index'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    execFileSync('rm', ['-rf', dir])
  }
})

describe('getBumpedVersion', () => {
  it('rejects private packages by default', () => {
    const packageDir = createPackage({ version: '0.0.0', private: true })

    expect(() => getBumpedVersion({ packageDir })).toThrow(
      'package.json must not have private: true',
    )
  })

  it('allows private packages when explicitly enabled', () => {
    const packageDir = createPackage({ version: '0.0.0', private: true })

    expect(getBumpedVersion({ packageDir, allowPrivate: true })).toBe('0.1.0')
  })

  it('returns 0.1.0 early for 0.0.0 packages', () => {
    const packageDir = createPackage({ version: '0.0.0' })

    expect(
      getBumpedVersion({
        packageDir,
        git: () => {
          throw new Error('git should not be called')
        },
      }),
    ).toBe('0.1.0')
  })

  it('logs default git commands in verbose mode', () => {
    const packageDir = createPackage({ version: '0.1.0' })
    execFileSync('git', ['init'], { cwd: packageDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: packageDir })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: packageDir })
    execFileSync('git', ['add', 'package.json'], { cwd: packageDir })
    execFileSync('git', ['commit', '-m', 'chore: initial release'], { cwd: packageDir })
    execFileSync('git', ['tag', '0.1.0'], { cwd: packageDir })
    writeFileSync(join(packageDir, 'README.md'), 'docs')
    execFileSync('git', ['add', 'README.md'], { cwd: packageDir })
    execFileSync('git', ['commit', '-m', 'docs: update readme'], { cwd: packageDir })
    const messages: string[] = []

    expect(
      getBumpedVersion({
        packageDir: realpathSync(packageDir),
        verbose: (message) => messages.push(message),
      }),
    ).toBe('0.1.1')
    expect(messages).toContain('git rev-list -n 1 0.1.0')
    expect(messages.some((message) => message.startsWith('git log '))).toBe(true)
  })

  it('finds v-prefixed release tags when bare version tags are absent', () => {
    const packageDir = createPackage({ version: '1.2.3' })
    mkdirSync(join(packageDir, '.git'))
    const seenTags: string[] = []

    expect(
      getBumpedVersion({
        packageDir,
        git: (args) => {
          if (args[0] === 'rev-list') {
            seenTags.push(args[3])
            if (args[3] === 'v1.2.3') return 'abc123'
            throw new Error('tag not found')
          }
          if (args[0] === 'log') return 'fix: patch bug'
          return ''
        },
      }),
    ).toBe('1.2.4')
    expect(seenTags).toEqual(['1.2.3', 'v1.2.3'])
  })

  it('finds v-prefixed monorepo release tags when bare version tags are absent', () => {
    const packageDir = createPackage({ name: '@scope/widget', version: '1.2.3' })
    const seenTags: string[] = []

    expect(
      getBumpedVersion({
        packageDir,
        git: (args) => {
          if (args[0] === 'rev-list') {
            seenTags.push(args[3])
            if (args[3] === 'widget@v1.2.3') return 'abc123'
            throw new Error('tag not found')
          }
          if (args[0] === 'log') return 'fix: patch bug'
          return ''
        },
      }),
    ).toBe('1.2.4')
    expect(seenTags).toEqual(['widget@1.2.3', 'widget@v1.2.3'])
  })

  it('bumps major for breaking commits', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(getBumpedVersion({ packageDir, git: createGit(packageDir, 'feat!: rewrite API') })).toBe(
      '2.0.0',
    )
  })

  it('bumps minor for feature commits', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(
      getBumpedVersion({ packageDir, git: createGit(packageDir, 'feat(ui): add option') }),
    ).toBe('1.3.0')
  })

  it('bumps patch for non-feature included commits and filters ci commits', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(
      getBumpedVersion({
        packageDir,
        git: createGit(packageDir, 'docs: update readme\nfix(ci): pipeline'),
      }),
    ).toBe('1.2.4')
  })

  it('returns current version when no included commits exist', () => {
    const packageDir = createPackage({ version: '1.2.3' })

    expect(getBumpedVersion({ packageDir, git: createGit(packageDir, 'fix(ci): pipeline') })).toBe(
      '1.2.3',
    )
  })

  it('treats 0.x.y as x major and y as minor or patch', () => {
    const packageDir = createPackage({ version: '0.4.7' })

    expect(getBumpedVersion({ packageDir, git: createGit(packageDir, 'feat!: rewrite API') })).toBe(
      '0.5.0',
    )
    expect(getBumpedVersion({ packageDir, git: createGit(packageDir, 'feat: add option') })).toBe(
      '0.4.8',
    )
    expect(getBumpedVersion({ packageDir, git: createGit(packageDir, 'refactor: simplify') })).toBe(
      '0.4.8',
    )
  })
})

describe('main', () => {
  it('parses --allow-private', () => {
    const packageDir = createPackage({ version: '0.0.0', private: true })

    expect(main(['--allow-private', packageDir])).toBe('0.1.0')
  })

  it('parses an optional package directory positional', () => {
    const packageDir = createPackage({ version: '0.0.0' })

    expect(main([packageDir])).toBe('0.1.0')
  })

  it('writes progress to stderr when verbose mode is enabled', () => {
    const packageDir = createPackage({ version: '0.0.0' })
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    try {
      expect(main(['--verbose', packageDir])).toBe('0.1.0')
      expect(write).toHaveBeenCalledWith(`reading package in ${packageDir}\n`)
      expect(write).toHaveBeenCalledWith(
        'package version is 0.0.0; returning initial release version 0.1.0\n',
      )
    } finally {
      write.mockRestore()
    }
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
    if (args[0] === 'log') return subjects
    return ''
  }
}
