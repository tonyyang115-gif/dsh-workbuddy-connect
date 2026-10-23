# DSH WorkBuddy Connect — source archive

This public repository stores both the original upstream source snapshot and the WorkBuddy-adapted source snapshot, so they can be retrieved together without connecting to the original upstream repository.

## Contents

- [`upstream/`](upstream/): all 134 tracked upstream files at commit `c0ed88e3712d3bb2e2deff5fddec1181e6222973`.
- [`adapted/`](adapted/): all 143 tracked and current non-ignored adaptation files, version `0.7.9+dshfix.5`.
- [`UPSTREAM.md`](UPSTREAM.md): provenance, validation, shallow-history limitation, and portability notes.

These are file snapshots. Nested `.git` databases and installed dependencies are excluded. The local source checkouts were shallow clones, so this repository does not claim to contain the complete commit histories. No remote to the original upstream is configured, and updates are manual.

## Which copy should I use?

Use `adapted/` for the WorkBuddy-compatible plugin. Use `upstream/` only to compare against the original source. Keep future plugin changes in `adapted/`; record and review any later upstream refresh before updating `upstream/`.

## Portability note

The adaptation was checked on Node.js 24.14.1: both TypeScript checks passed, Vitest reported 1042 passed and 7 skipped, and the build completed. A clean dependency install/build was not verified: the maintenance environment still relies on an undeclared temporary `unrun` build-tool link, which remains a deferred follow-up. See [`UPSTREAM.md`](UPSTREAM.md) before treating a fresh clone as a reproducible build environment.
