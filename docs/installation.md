# 构建、配套宿主与安装

**当前源码 0.1.9 配套 Cockpit 0.2.4，使用暖黄色小圆角未读底色与 1.6 秒淡出。** 增量同步、会话徽标与精简入口保持不变，本次无需宿主改动。
需要宿主提供的通用模块事件及菜单注册，历史 Cockpit 0.2.3 Release 不具备这些能力。
源码配套宿主要求 Web API v2 的 state 服务、组件 middleware 及 `context.menuVersion === 1`；
公共 UI v1、模块控制事件观察、invalidate 提示及窄作用域 worker 入口保持不变。
准确的宿主提交与包版本固定在 [`tooling/host-sdk.json`](../tooling/host-sdk.json)，
不能把旧的 0.2.x 包视为自动兼容。
SDK 类型基线仍来自 pin 指定的干净 0.2.3 开发提交，不是历史 0.2.3 Release；
Cockpit 0.2.4 包含该接口，版本发行未改变菜单类型或模块协议。
前端 context/返回声明均为 `apiVersion: 2`；包与后端 API 仍为 v1。
本次是明确的配套升级，不提供旧 Web 插口兼容层；模块核销回执和同步消息使用 0.1.1 格式。

已发行 0.1.0 的安装说明使用其 tag 文档；delta 和新回执格式不是该版本的现有能力。
0.1.9 的目标正式安装包为 [v0.1.9 Release](https://github.com/waksana/cockpit-notification/releases/tag/v0.1.9)
中的 `cockpit-notification-0.1.9.tgz` 与同名 `.sha256`；仅在该 Release 及资产实际发布后下载，
并执行 `sha256sum -c cockpit-notification-0.1.9.tgz.sha256`。本说明不宣称已发布或部署。
若资产尚未发布或下载失败，不使用旧包、CI 临时 artifact 或源码 ZIP 冒充正式安装包。
已安装模块版本的摘要不可更换；内容改变必须使用新版本，不能覆盖原有版本的包。

## 从源码构建

Node **24.20.0**，pnpm **10.34.5**。先准备 pin 指向的干净本体源码：

```sh
node scripts/sdk.mjs prepare /absolute/clean/pinned/cockpit
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

SDK 导出自真实 `packages/module-api` 及依赖的 protocol，不手抄接口，
不复制另一工作树的 node_modules。更换 pin 要重新导出并核对来源。

后端、前端和 worker 分别打包。React/ReactDOM 由宿主提供，不随模块重复打包；
后端 Web Push 的运行依赖打入产物，第三方许可随 `dist/licenses` 交付。
worker 不需要外部 CDN、动态 import 或模块私有脚本服务。

## 可追溯的模块包

源码需先提交且保持干净，再从同一源码重新 build：

```sh
pnpm package
pnpm verify:package module-output/cockpit-notification-0.1.9.tgz
```

`module-output` 必须是不存在的新目录，或给 package 命令传一个新的输出路径。
打包只包含 manifest、dist、许可证和 `module-build.json`；不包括测试、源码、
SDK、开发依赖、密钥、设备订阅或未读数据。
源码、SDK 或 dist 在 build 后变更会使 receipt 校验失败，不手写来源凭据绕过。

CI 对 PR/main 执行固定 SDK 准备、冻结安装、类型/测试、构建、打包与真实宿主的合成模块接入。
首版由维护者将已通过 main CI 的原始 artifact 发布到固定 tag，不重新构建；
具体来源核对见[版本发行](releases.md)。当前没有自动部署，CI artifact 不是线上已经安装的证明。

## 安装

使用 pin 对应的兼容宿主包，通过它的原生模块安装命令启用可信本地包；
宿主与模块可以先安装，下次启动时必须一起使用配套版本：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts install \
  /absolute/path/cockpit-notification-0.1.9.tgz --trust-local-code --enable
```

本体管理模块包与数据根；模块不读取或迁移 Copilot native home。
冷加载，下次本体启动生效。安装、退出、重启需要单独明确授权。

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
