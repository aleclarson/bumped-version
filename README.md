# bumped-version

Compute the next publish version for a package from its current `package.json` version and
conventional commit subjects since the last release tag.

Use it when you want a small, synchronous version calculator for release scripts that already use
git tags and conventional commit subjects. It is especially useful for repositories where only
commits touching the package directory should affect that package's next version.

Do not use it if you need changelog generation, tag creation, prerelease channels, custom commit
type rules, workspace graph analysis, or package-manager-aware publishing. `bumped-version` only
answers: "what version should this package publish next?"

## Requirements

- Node.js with ESM support.
- A publishable `package.json` with an `x.y.z` version. `private: true` packages are rejected.
- Git history and release tags. Single-package repositories use the bare version tag, such as
  `1.2.3`; monorepo package directories use `<unscoped-name>@<version>`, such as
  `widget@1.2.3`.
- Conventional commit subjects starting with `fix`, `feat`, `docs`, or `refactor`, with optional
  scopes and `!` breaking markers.

## Tradeoff

The library favors a predictable, narrow rule set over configurability. You get deterministic
version bumps from commit history with no runtime dependencies, but you do not get knobs for custom
release policies.

## Install

```
pnpm add bumped-version
```

## CLI

This demonstrates the core decision: only release-relevant commits since the package's release tag
are considered, and the result is printed without mutating files or tags.

```sh
bumped-version packages/widget
# 1.3.0
```

Use `--verbose` to see the package read and git commands used during the calculation.

```sh
bumped-version --verbose packages/widget
```

## API

```ts
import { getBumpedVersion } from 'bumped-version'
import { fileURLToPath } from 'node:url'

const version = getBumpedVersion({
  packageDir: fileURLToPath(new URL('./packages/widget', import.meta.url)),
})

console.log(version)
```

`getBumpedVersion` runs git synchronously by default. Tests or controlled environments can provide a
`git(args)` adapter and a `verbose(message)` callback.

## Version Rules

- `0.0.0` returns `0.1.0` without reading git history.
- Breaking `fix!`, `feat!`, `docs!`, or `refactor!` commits bump `1.x` packages to the next major
  version and `0.x` packages to the next minor version.
- `feat` commits bump `1.x` packages to the next minor version and `0.x` packages to the next patch
  version.
- Other included `fix`, `docs`, and `refactor` commits bump the patch version.
- Commits scoped as `(ci)` are ignored.
- If no included commits remain, the current version is returned.
