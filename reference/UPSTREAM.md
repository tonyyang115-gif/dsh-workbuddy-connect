# Source provenance and portability

## Source snapshots

- `upstream/` contains all 134 tracked files exported from local upstream commit `c0ed88e3712d3bb2e2deff5fddec1181e6222973` (`corrinehu/dsh-workbuddy-connect`). File-by-file comparison against that local checkout passed.
- `adapted/` contains the complete current adaptation snapshot at version `0.7.9+dshfix.6` (143 files). It was prepared from local branch `fix/workbuddy-cn-channel-compat`, based at commit `885e5fb`, together with the current `.6` working-tree changes and rebuilt `lib/` output. The `.6` changes were uncommitted in the source checkout when this snapshot was prepared; this archive commit records the published files. Six lockfile specifiers were aligned to `package.json` for frozen-lockfile validation; the locked dependency versions were kept unchanged.
- Each source tree keeps its original license and notices. The package metadata inside `adapted/` still identifies the upstream project; this archive does not change runtime or package metadata.

## History and future updates

The local upstream and adaptation checkouts are shallow clones. Their available history stops at shallow boundaries, so it would be inaccurate to call it complete. This repository stores the full file snapshots but does not include nested Git databases or claim to preserve the complete commit histories.

No remote to the original upstream is configured. The GitHub repository is the only intended place to retrieve these snapshots. Updates are manual: review an upstream source change, update `upstream/` only when appropriate, apply and test adaptation changes in `adapted/`, and record the new source commit and validation here. There is no automatic fetch or merge from the original project.

The original `.github/workflows/` directories are retained inside `upstream/` and `adapted/` for completeness. They are nested snapshots, not active workflows at this repository's root.

## Validation and known limitation

On Node.js 22.14.0, both TypeScript checks passed, Vitest reported 1056 passed / 7 skipped (64 test files passed, 1 skipped), and the build completed. `pnpm install --lockfile-only --frozen-lockfile --ignore-scripts` also passed after the six lockfile specifiers were aligned; the locked package versions were unchanged. Typecheck, test, and build checks used the existing dependency installation; the standard `pnpm run check` wrapper was not used because pnpm had previously attempted to replace `node_modules` in the non-interactive maintenance shell.

A clean install and build from a fresh clone have not been verified. The maintenance environment has `node_modules/unrun` linked to `/tmp/wb-build-tools`, while `unrun` is not declared in the package manifest. That dependency issue was deliberately deferred, so this archive provides complete source-file snapshots but does not claim a reproducible clean build until that follow-up is addressed.

## Security and scope

This repository is public. The snapshots contain source-controlled project files only; they exclude nested Git databases, installed dependencies, local profiles, session data, maintenance reports, backups, and ignored local instructions. Test credentials are fixtures, not live credentials.
