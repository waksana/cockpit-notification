# 构建、配套宿主与安装

**当前源码 0.1.17 要求 shared-surfaces v1，不设候选缓存。** 当前源码的回复判定为所有模型统一的无工具回复直接入账（不看 phase）。
The build consumes published `@waksana/cockpit-module-sdk@0.2.0` from
`https://npm.pkg.github.com`; it does not export types from a host checkout.
The exact integration host is `7d69b6f348e17f098bc5562fdbec317e8e2e4ba6`,
recorded separately in [`tooling/integration-host.json`](../tooling/integration-host.json).
SDK semver is independent of host versions and does not prove host compatibility.
会话计数复用 `ck-badge` 的基础排版，但保留计数专用圆形/胶囊几何、防压缩、
业务颜色、等宽数字、非交互语义与 stale 标签；不能直接套用可换行文字标签的尺寸。
激活在注册任何贡献前额外要求 `context.uiSurfaceVersion === 1`；缺少或不支持时明确拒绝。
增量同步、菜单、已读判定与未读底色策略保持不变。
需要宿主提供的通用模块事件及菜单注册，历史 Cockpit 0.2.3 Release 不具备这些能力。
源码配套宿主要求 Web API v2 的 state 服务、组件 middleware 及 `context.menuVersion === 1`；
公共 UI v1、模块控制事件观察、invalidate 提示及窄作用域 worker 入口保持不变。
The SDK package version and resolution are pinned in `package.json` and `pnpm-lock.yaml`.
Runtime capability checks remain mandatory; old UI v1 alone does not prove that
surface/badge styles, menus, state services or module events exist.
前端 context/返回声明均为 `apiVersion: 2`；包与后端 API 仍为 v1。
本次是明确的配套升级，不提供旧 Web 插口兼容层；模块核销回执和同步消息使用 0.1.1 格式。

已发行 0.1.0 的安装说明使用其 tag 文档；delta 和新回执格式不是该版本的现有能力。
0.1.17 的目标正式安装包为未来 [v0.1.17 Release](https://github.com/waksana/cockpit-notification/releases/tag/v0.1.17)
中的 `cockpit-notification-0.1.17.tgz` 与同名 `.sha256`；仅在该 Release 及资产实际发布后下载，
并执行 `sha256sum -c cockpit-notification-0.1.17.tgz.sha256`。本说明不宣称已发布或部署。
若资产尚未发布或下载失败，不使用旧包、CI 临时 artifact 或源码 ZIP 冒充正式安装包。
已安装模块版本的摘要不可更换；内容改变必须使用新版本，不能覆盖原有版本的包。

## Build from source

Use Node **24.20.0**, pnpm **10.34.5**, TypeScript **5.9.3** and NodeNext resolution.
The supported SDK peers are Node types 22-25 and matching React/types 18 or 19;
this repository locks its own type dependencies and checks declarations without
`skipLibCheck`. Backend/common/worker code does not need a React runtime.

The repository `.npmrc` maps only `@waksana` to GitHub Packages. Put the following
literal placeholder in a trusted **user-level** npm config, outside this checkout
(or select such a file with `NPM_CONFIG_USERCONFIG`):

```ini
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Supply `NODE_AUTH_TOKEN` only through the environment, using an authorized classic
PAT with `read:packages` and access to the package. Never commit or print the token.
pnpm 10.34.5 deliberately ignores credential expansion in a project `.npmrc`.
Public npm packages on GitHub Packages still require authentication; an access
failure must be resolved explicitly, not bypassed with local tarballs or another registry.
No host checkout, SDK generation, type symlink, or peer-resolution override is needed:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

Use the public root for common types, `/backend` for backend contracts,
`/frontend` for frontend contracts, and `/runtime` for runtime constants such as
`MAX_MODULE_EVENT_BYTES`. Do not import private SDK paths or host source.
pnpm may install optional SDK peers, including React, into the development graph;
their presence is not a runtime requirement or permission to bundle them.

The backend, frontend and worker are bundled separately. The frontend uses
`context.react`, not a second React/ReactDOM instance. Build guards reject React,
Zod, host implementation and native SDK code in every bundle. Only public SDK
runtime constants are bundled; Web Push dependencies and their licenses ship
with the backend. The worker needs no CDN or dynamic script import.

## 可追溯的模块包

源码需先提交且保持干净，再从同一源码重新 build：

```sh
pnpm package
pnpm verify:package module-output/cockpit-notification-0.1.17.tgz
```

`module-output` 必须是不存在的新目录，或给 package 命令传一个新的输出路径。
打包只包含 manifest、dist、许可证和 `module-build.json`；不包括测试、源码、
SDK、开发依赖、密钥、设备订阅或未读数据。
The receipt records the actual installed SDK name/version, registry tarball,
lockfile SHA-512 integrity and an inventory of installed package bytes. It does
not require host source or a generated SDK pin. Source, installed SDK, resolution
or dist changes after build invalidate the receipt; never hand-edit it.

CI installs the frozen registry dependency and builds/packages **before** checking
out any host source. `actions/setup-node` supplies the trusted npm auth config for
`https://npm.pkg.github.com`; only the install step receives
`NODE_AUTH_TOKEN: ${{ github.token }}`, with `contents: read` and `packages: read`.
The package must grant this repository read access. A local PAT install does not
prove Actions access; the exact PR head must pass its real workflow.

Only the later integration stage checks out the exact paired host and restores
its own frozen dependencies. To run that stage locally after committing/building:

```sh
pnpm --dir /absolute/clean/paired/cockpit install --frozen-lockfile --ignore-scripts
timeout 300 node --import /absolute/clean/paired/cockpit/apps/server/node_modules/tsx/dist/loader.mjs \
  scripts/integration.mjs /absolute/clean/paired/cockpit \
  module-output/cockpit-notification-0.1.17.tgz
```

The script rejects a dirty or different host commit and verifies the archive.
It isolates `HOME`, `COPILOT_HOME` and `COCKPIT_HOME`, uses synthetic events and
in-process HTTP injection, and never starts a native session or production service.
Changing the SDK pin or integration pairing requires a fresh compatibility run;
neither change alone establishes compatibility.

首版由维护者将已通过 main CI 的原始 artifact 发布到固定 tag，不重新构建；
具体来源核对见[版本发行](releases.md)。当前没有自动部署，CI artifact 不是线上已经安装的证明。

## 安装

仅支持 Linux：私有存储依赖 POSIX 属主/权限与 `O_NOFOLLOW`。其他平台启动时明确报
`UNSUPPORTED_PLATFORM`，而不是误导性的隐私错误；Windows 请按宿主
[WSL2 指南](https://github.com/waksana/cockpit/blob/main/docs/install.md#windows-wsl2) 在 WSL2 中运行。

使用 pin 对应的兼容宿主包，通过它的原生模块安装命令启用可信本地包；
宿主与模块可以先安装，下次启动时必须一起使用配套版本：

```sh
node --enable-source-maps apps/server/dist/module-cli.js install \
  /absolute/path/cockpit-notification-0.1.17.tgz --trust-local-code --enable
```

本体管理模块包与数据根；模块不读取或迁移 Copilot native home。
冷加载，下次本体启动生效。安装、退出、重启需要单独明确授权。
新版不通过热替换清理正在运行的旧宿主错误，也不恢复旧版已丢弃的回复证据；
详见[回复证据生命周期与旧错误](implementation.md#回复证据生命周期与旧错误)。

## 数据与通知授权

未读、核销凭据和待发任务仅在内存。模块重新激活清空旧 U。
VAPID 与设备订阅属于私有模块配置，保存在本模块 `dataRoot`，不能公开给 bootstrap 或日志。
只有 VAPID 公钥和必要参数允许返回给客户端。

用户通过汉堡菜单中的“开启通知 / 关闭通知”操作管理本设备推送；
菜单注册需要本模块 pin 对应的配套宿主；旧 `globalNavigation` 包装不再保留，
模块不在初次加载时自动弹出浏览器授权。
使用浏览器支持的 HTTPS/PWA 环境；拒绝权限时普通未读功能仍可使用。
取消本设备订阅在模块界面执行；它不清其他设备，也不删除原生消息。

worker 由宿主在 `/_modules/workers/cockpit-notification/worker.js` 服务，
scope 限于该模块目录，不接管应用页面，不缓存聊天和 API。
浏览器现有 worker/订阅不会随服务进程停止自动消失。
停用模块之前应先取消不再需要的设备订阅；离线设备的清理和旧版本 worker 更新有浏览器执行限制。

真实 Apple/Google/Mozilla 投递需要有效订阅、网络和平台权限。
合成 fixture 只证明代码路径与数据边界，不代表设备已收到通知。
