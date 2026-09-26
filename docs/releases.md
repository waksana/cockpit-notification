# Rolling and Milestone releases

## Cutover

The merge of the PR resolving [#49](https://github.com/waksana/cockpit-notification/issues/49)
switches this repository to Rolling. Every actually merged `main` PR, including
documentation and chores, independently runs `.github/workflows/release.yml`
(`Rolling`) against its exact `merge_commit_sha`. Unmerged PRs and historical
merges are not published. Historical tags, Releases and assets remain untouched;
the old tag-push publication trigger is retired.

The trigger uses the trusted base-repository `pull_request_target: closed`
context so merged fork PRs also receive publication permissions. Jobs are gated
on `merged == true` and check out only the accepted merge SHA, never an unmerged
PR head; the publication gate also checks that SHA belongs to main history.

Keep the Rolling workflow **path, name and run counter stable**. Its
`github.run_number` is the per-repository sequence; gaps are valid and reruns keep
the original number, PR event and SHA. There is no concurrency queue that replaces
pending runs or cancels earlier attempts. Failed attempts do not block later merges.
Consumers order successful releases by descriptor **sequence**, never completion
time, `published_at` or Latest.

## Identity and artifacts

Committed `package.json` and `cockpit.module.json` stay `0.0.0-dev`; no version PR,
release label, tag push or generated source commit is needed. Development bundles
export `buildVersion` as `dev+<shortSHA>` (unbundled source reports `dev+unknown`).
The isolated Actions build writes only ignored build outputs: its generated
manifest, receipt and bundled identity use `0.0.0-rolling.<sequence>`. The
immutable lightweight tag `v0.0.0-rolling.<sequence>` points to the exact merge.
SDK versioning and the integration-host pin are independent and unchanged.

Each successful Rolling contains exactly:

1. `cockpit-notification-0.0.0-rolling.<sequence>.tgz`
2. that archive's `.sha256`
3. `cockpit-deployment.json`
4. `cockpit-deployment.json.sha256`

The format-2/channel-rolling deployment descriptor is byte-identical in the
archive root and sidecar. It declares repository, tag, source SHA, product version,
positive sequence and archive name. The archive checksum is a standalone asset,
not a self-reference inside the archive. The build receipt inventories the
descriptor and all package files. Both checksums, inventory, version/source/tag
identity, sidecar equality and exact asset set are checked before and after
publication.

The module product is gated against source by `scripts/rolling-identity.mjs`:
backend/module API 1; frontend API 2, UI 1, UI surface 1 and menu 1; no host intents.
These become `module-api.v1`, `frontend-api.v2`, `ui.v1`, `uiSurface.v1`, `menu.v1`.
Notification keeps a private version-1 `push-config.json` subscription/VAPID store
and an in-memory unread ledger; it owns **no SQLite database or migration**.
Empty `databases`/`migrations` are not permission to discard private data. The
deployer must preserve the module data directory; this change neither transforms
data nor weakens ownership/mode checks. Changed source compatibility/storage
requirements require updating and reviewing the declaration, never guessed
compatibility, fictional migrations or a per-version local catalog.

## Publication and recovery

The reusable CI checks build the exact merged source, test it and exercise the
package through the pinned host. Publication downloads that original CI artifact;
it does not rebuild. PR title and **full body** become Release notes, followed by
deterministic PR/source/tag/version/sequence and asset names.

All writes use the existing single-attempt HTTPS transport: create the immutable
tag if absent, create a prerelease draft, upload all four assets, download/verify
their exact bytes and IDs, then PATCH the same Release to `draft:false`,
`prerelease:true`, `make_latest:false`. Rolling never claims Latest.

No write is automatically retried, including redirects, HTTP errors, timeouts or
lost acknowledgements. An uncertain operation is observed read-only and fails
closed; it may already have applied. Do not move/delete tags, overwrite assets,
use `--clobber`, or start a replacement release. Inspect the original run and exact
tag's paginated Release listing, including drafts. A separately authorized rerun
keeps its original identity: a complete byte-identical draft may finish publication;
a matching published Rolling is verified read-only. Partial/conflicting assets,
changed PR metadata or moved tags reject rather than repair. The historical
stable-release recovery script remains for explicitly authorized historical
operations; the new workflow never calls it in stable mode.

## Milestone promotion

Only upon explicit user selection, dispatch `.github/workflows/milestone.yml`
on `main`, supplying the same existing successful Rolling tag in both `tag` and
`confirm_tag`. No implicit newest-tag selection is supported.

The workflow checks the published release, exact tag/source, four assets,
checksums, descriptor and inventory; it repeats metadata and byte checks before
writing. Its only write is a PATCH to the **original Release ID** with
`prerelease:false, make_latest:true`. It then verifies the same identity and bytes
and the Latest endpoint. There is no build, tag/version change, asset replacement,
title/body edit or second Release. Non-Rolling tags, drafts, missing/changed assets,
identity races or an unconfirmed tag reject. Unknown write results are not retried.

## Verification and delivery boundaries

Use Node/pnpm and authenticated dependencies from the [build guide](installation.md).
Run `pnpm typecheck` and `pnpm test`; release tests cover workflow trigger/identity,
out-of-order sequence selection, isolated failures, immutable reruns, transport
uncertainty and promotion invariance. From a clean commit, `pnpm build`,
`pnpm package`, and `pnpm verify:package ARCHIVE` verify development packaging.
The Rolling CI supplies `ROLLING_SEQUENCE` consistently to build/package/verify.

Report merge, Rolling publication, Milestone promotion and external deployment
as separate facts. Merge authorization includes its automatic Rolling attempt,
not a successful release guarantee. PR-only/no-merge work stops before that
side effect. Release automation never installs, migrates data, restarts services
or contacts an external deployment service; those require separate authorization.
