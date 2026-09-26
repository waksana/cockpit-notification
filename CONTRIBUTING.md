# 参与开发

Current source is 0.1.18 and requires shared-surfaces v1; see the [installation guide](docs/installation.md) for the exact host pairing.
发布状态以对应 GitHub Release 为准。先阅读[产品要求](docs/requirements.md)、
[状态机](docs/state-machines.md)和[实现边界](docs/implementation.md)。
未完成的平台覆盖不能因为类型或合成测试通过就宣传为已验证。

## 变更范围

- 用短期分支与 PR 提交有明确范围的变更。实现开始前先细化原生事件契约及宿主配套边界。
- 未读与通知数据属于模块，原生状态仍属于 Copilot。本体通用改动在本体仓库单独提交。
- 公共 UI、图标与交互语义遵循宿主
  [模块 UI 指南](https://github.com/waksana/cockpit/blob/main/docs/module-ui-guide.md)及
  [开发原则](https://github.com/waksana/cockpit/blob/main/docs/DEVELOPMENT.md#interaction-semantics-and-structural-correctness)。
  可见外观、控件语义、焦点、状态和事件归属必须自洽，不仅是鼠标能点击。
- 未读底色通过公共 `MessageProps.className` 增强，保留传入的 `style`、bodyRef、children/adornment
  和可访问性属性；不增加包装、间距或布局变化，不修改宿主或关闭 `content-visibility: auto` 性能优化。
  主题色、过渡与减少动态效果规则见产品要求；ask 只保留计数和阅读观察，不高亮。
- 文档区分现状、已确认需求和待定方案；不通过改文档掩盖实现缺口。
- 共享样式迁移必须保留组件的语义几何：文字标签、未读计数和无数字圆点不是同一变体。
  不用“已添加公共 class”代替行为验收，也不以“不能有专用样式”的测试删除既有保护。
  改动 badge 或公共样式时，运行[真实宿主 CSS 合成预览](docs/implementation.md#badge-geometry)，
  检查单/多位数字、窄行、浅深色、放大文字和祖先裁剪边界；不使用真实会话。
- 状态变更需同步检查不变量和乱序时序表，特别是核销先到、旧响应、推送迟到、
  重启清零与旧快照不能清理新通知；不要在多个页面复制各自一份转移规则。
- 使用 Node 24.20.0 和 pnpm 10.34.5，按[构建步骤](docs/installation.md)认证正式 SDK registry 并冻结安装依赖。
  修改后运行最小相关测试、`pnpm typecheck`，包需干净提交与同次 build receipt。
- 文档变更只做相关链接、锚点与事实检查，不为文档启动 native runtime 或生产服务。

## 隔离与数据

For a new checkout/worktree, follow the
[independent dependency setup](docs/installation.md#worktree-setup) and existing
authenticated build instructions. Plain documentation changes need no dependency
install or product build.

后续验证只使用合成 session、文件、工作区、通知和受控 provider。
不得读取真实 native home、会话历史、凭据、推送订阅或其他人的业务数据作为 fixture。
不把实验指向生产服务，不给真实 session 发测试 prompt 或回答 ask。

清理仅针对自己创建的具体资源。模块试验不授权停止、重启或修改共享服务。
不要提交密钥、设备标识、push endpoint、通知正文、用户截图或完整聊天记录。

## 许可与发布

### 安装版本不可变

不要求每个提交都升级版本。在为安装或部署打包之前，须与已经交付的版本比较：
包内容字节改变就必须使用新的 semver；兼容修复通常升级 patch。同一模块 ID 与版本
只能重现相同字节/摘要，source SHA 和 digest 是来源证据，不能替代版本或允许覆盖旧身份。

同步 `package.json`、`cockpit.module.json`、嵌入版本与适用的 lock 元数据，
更新当前源码配套说明和发行说明，保留历史发行事实。
The exact SDK package dependency is independent from the integration host pairing;
neither changes merely because a module version is prepared. Use public SDK entry
points and keep host React shared; do not reintroduce generated SDKs or host-source builds.
从最终干净提交重新构建并核对精确 CI 包；不能删除已安装目录或强制绕过安装器来复用版本。
版本准备和合并不自动授权 tag、Release、安装或重启。

一方源码按 `GPL-3.0-only` 标注，保留 [LICENSE](LICENSE)。
引入第三方包或资源时核对固定版本并保留许可，不能因为宿主已有某依赖就假定模块包无需声明。

包格式、验证命令与 CI 见构建指南；发行遵循[固定来源流程](docs/releases.md)，当前无自动部署。
合并、发布、安装和运行生效分别报告，前一步不是后一步的自动授权。
