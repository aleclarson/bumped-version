# bumped-version

Compute the next publish version for a package from its current `package.json` version and
conventional commit subjects since the last release tag.

Use it when you want a small, synchronous version calculator for release scripts that already use
git tags and conventional commit subjects. It is especially useful for repositories where only
commits touching a selected path should affect a package's next version.

Do not use it if you need changelog generation, tag creation, prerelease channels, custom commit
type rules, workspace graph analysis, or package-manager-aware publishing. `bumped-version` only
answers: "what version should this package publish next?"

## Requirements

- Node.js with ESM support.
- A `package.json` with an `x.y.z` version. `private: true` packages are rejected unless explicitly
  allowed.
- Git history and release tags. Single-package repositories use the bare version tag, such as
  `1.2.3`, or a `v`-prefixed version tag, such as `v1.2.3`; monorepo package directories use
  `<unscoped-name>@<version>`, such as `widget@1.2.3`, or `<unscoped-name>@v<version>`, such as
  `widget@v1.2.3`. An explicit tag prefix can override this derivation.
- Conventional commit subjects starting with `fix`, `feat`, `docs`, or `refactor`, with optional
  scopes and `!` breaking markers.

## Tradeoff

The library favors a predictable, narrow rule set with a few repository-layout options. You get
deterministic version bumps from commit history with no runtime dependencies, but you do not get
custom commit types or general release-policy configuration.

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

Use `--allow-private` when the manifest tracks a release version but is not itself published.

```sh
bumped-version --allow-private .
```

By default, commit history is filtered to the package directory. Use the repository-relative
`--commit-path` option when the version source lives elsewhere, such as a root manifest that tracks
only changes under `template/`.

```sh
bumped-version --allow-private --commit-path template/ .
```

Use `--tag-prefix` to override tag derivation. This Coreframe-style invocation reads the private
root version, considers only commits touching `template/`, and resolves version `1.0.0` from tag
`v1.0.0`.

```sh
bumped-version --allow-private --commit-path template/ --tag-prefix v .
```

## API

```ts
import { getBumpedVersion } from 'bumped-version'
import { fileURLToPath } from 'node:url'

const version = getBumpedVersion({
  allowPrivate: true,
  commitPath: 'template/',
  packageDir: fileURLToPath(new URL('.', import.meta.url)),
  tagPrefix: 'v',
})

console.log(version)
```

`getBumpedVersion` runs git synchronously by default. Tests or controlled environments can provide a
`git(args)` adapter and a `verbose(message)` callback. Private manifests remain rejected by default;
set `allowPrivate: true` only when `package.json` intentionally acts as a private release-version
source.

`commitPath` is repository-relative. When omitted, the git history filter remains the package
directory, preserving the default package-scoped behavior.

`tagPrefix` is prepended directly to the manifest version. When supplied, only that tag name is
looked up. When omitted, the default release tags described in Requirements are tried.

## Version Rules

- `0.0.0` returns `0.1.0` without reading git history.
- Breaking `fix!`, `feat!`, `docs!`, or `refactor!` commits bump `1.x` packages to the next major
  version and `0.x` packages to the next minor version.
- `feat` commits bump `1.x` packages to the next minor version and `0.x` packages to the next patch
  version.
- Other included `fix`, `docs`, and `refactor` commits bump the patch version.
- Commits scoped as `(ci)` are ignored.
- If no included commits remain, the current version is returned.
