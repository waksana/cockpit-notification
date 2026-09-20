# 版本发行

正式资产是 `cockpit-notification-X.Y.Z.tgz` 和同名 `.sha256`，不是 npm 包或源码 ZIP。
首版复用现有 main CI 的原始 artifact，由维护者发布，不新增另一套构建链。

1. 通过 PR 更新版本、发行说明和配套宿主 SDK pin，并合入 main。
2. 取得该精确 main SHA 的成功 push CI；不能用 PR 的临时 merge SHA artifact 冒充 main。
3. 下载 `cockpit-notification-<完整源 SHA>` artifact，确认只包含对应 tgz 和 checksum。
4. 在相同干净源码下运行 `node scripts/verify-package.mjs ARCHIVE SOURCE_SHA`，
   核对 manifest、版本、源码、Node、SDK pin、文件清单及全部摘要。
5. 创建指向该 SHA 的 annotated `vX.Y.Z` tag 并推送；复核远端 tag 解引用后仍为该 SHA，
   且该提交属于 main 历史。tag/version/发行说明标题必须一致。
6. 用 `gh release create --verify-tag --latest --notes-file docs/release-notes.md`
   发布原始 tgz 与 checksum，不在发布时重建或修改资产。
7. 回读 Release、tag 和资产摘要，保留本次源码/SDK/包身份。

版本 tag 不移动或删除；同版本资产不覆盖、不使用 clobber。命令超时或网络失败后，
先查询远端实际状态再决定，不假设远端没有发布，不盲目重试变更请求。
CI artifact 只保留有限时间，Release 资产独立保留。

已发行 0.1.0 配套当时的 Cockpit 0.2.3；当前 0.1.12 源码继续配套 Cockpit 0.2.4，
无需为此次连续可见阅读规则修改宿主或 SDK pin。0.1.12 的实际发布状态须另行核对；SDK 类型基线的完整 SHA 以
`tooling/host-sdk.json` 为准，不把开发提交的新能力追记为旧 Release 的事实。包和 SDK 类型来自固定源，
不打入私有配置、订阅、未读数据或额外 React。许可随包内 dist/licenses 交付。
发布不安装、不申请设备权限、不改变正在运行的服务；安装和重启需要另外授权。
