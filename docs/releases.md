# 版本发行

正式资产是 `cockpit-notification-X.Y.Z.tgz` 和同名 `.sha256`，不是 npm 包或源码 ZIP。
Release workflow 复用原生 CI 检查链，并发布该次检查生成的原始 artifact。

1. 通过 PR 更新版本与发行说明，核对独立 SDK 包锁定与集成宿主配对，并合入 main。
2. 确认该精确 main SHA 的 Required checks 成功；不能用 PR 的临时 merge SHA 冒充 main。
3. 创建指向该 SHA 的 annotated `vX.Y.Z` tag 并推送。
4. Release workflow 在 tag SHA 上运行相同 CI，下载
   `cockpit-notification-<完整源 SHA>-linux-x64` artifact，并确认只包含对应 tgz 和 checksum。
5. workflow 运行 `scripts/check-release.mjs`，核对 tag/version/release notes、main 来源、
   manifest、Node、SDK registry/version/integrity、集成宿主 identity、文件清单及全部摘要。
6. `scripts/publish-release.mjs` discovers the unique exact-tag Release through the
   authenticated, fully paginated releases list (including drafts), not the published-tag
   endpoint. It creates a draft only when that successful listing proves absence.
   An existing complete draft can resume without creating or uploading anything.
7. The workflow reads the selected Release and all its assets by numeric ID, downloads
   assets by ID, compares their bytes with the checked CI artifact, and repeats package,
   source and remote tag verification. Only then does it publish that same Release ID
   as a stable Latest Release. The publish job never rebuilds or repackages.
8. 回读正式 Release、tag 和资产摘要，保留本次源码/SDK/宿主/包 identity。

版本 tag 不移动或删除；同版本资产不覆盖、不使用 clobber。命令超时或网络失败后，
先查询远端实际状态再决定，不假设远端没有发布，不盲目重试变更请求。
CI artifact 只保留有限时间，Release 资产独立保留。

<a id="atomic-release-publication"></a>
正式、非 draft、非 prerelease 且资产完整的 Release 才是发布就绪信号。workflow
在远端资产回读和复验前保持 draft；部分上传或失败的 draft 留作诊断，不得被自动
删除或覆盖。创建、上传、转正式或最终回读出现失败/未知结果时，先读取远端真实状态，
不得盲目重跑变更请求。

### Draft recovery

The `contents: write` workflow token must be able to see drafts. A lookup failure,
including 404, is not proof of absence. All listing pages must succeed and exactly
one matching `tag_name` must exist before recovery; duplicate matches, prereleases,
already-published Releases, missing/extra/duplicate assets, unfinished uploads and
different bytes stop without writes. Partial drafts require maintainer investigation;
the workflow does not complete, delete or replace their assets.

Recovery requires the original checked artifact for the exact tag/source/version.
The remote tag must still resolve to that source on main; `target_commitish` is not
source evidence because GitHub ignores it when the tag already exists. Package
manifest, receipt, SDK identity, checksums and both downloaded asset bytes must
match. A fresh build that produces different bytes cannot replace the draft.
The unique Release ID and complete asset metadata are read again before publishing,
then read and downloaded again after publication.

After a create/upload/publish command fails or times out, the script performs only
a read-only discovery for diagnostics and fails the run, even if it observes a
complete draft or published Release. Inspect the authenticated paginated list and
the exact Release/asset IDs before deciding whether a later run is appropriate.
There are no mutation retries, tag moves, asset overwrites or published-Release edits.
A single-request HTTPS transport creates drafts, uploads assets by Release ID and
publishes by ID; it does not follow redirects or retry transport/5xx failures.
The workflow deliberately avoids `gh release create` asset uploads, whose internal
retry loop can repeat an uncertain upload. `gh api` is used only for reads.
A failed final readback is not proof that publication failed. An old tag executes
its old workflow: merging this fix does not repair or authorize rerunning historical
tag workflows, moving tags, or publishing any existing draft.

After a joint deployment with the host, tag and release the accepted commit per Cockpit's [release after a joint deployment](https://github.com/waksana/cockpit/blob/main/docs/releasing.md#release-after-acceptance) policy.

Historical 0.1.0 paired with Cockpit 0.2.3. Current 0.1.18 source requires
shared-surfaces v1; see the [installation guide](installation.md) for pairing.
Versions 0.1.16 and 0.1.17 were published under their own tags. Version 0.1.18
prepares a fresh patch identity for the SDK migration and awaits joint-deployment
acceptance before publication under the policy above.
The SDK version, registry resolution and integrity are locked separately from the exact
integration host in `tooling/integration-host.json`. Never infer host compatibility from
SDK semver or backdate a new capability into a historical Release.
不打入私有配置、订阅、未读数据或额外 React。许可随包内 dist/licenses 交付。
发布不安装、不申请设备权限、不改变正在运行的服务；安装和重启需要另外授权。
