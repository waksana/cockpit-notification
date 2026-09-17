# 模块与宿主协作边界

**当前阶段：0.1.0 开发源码已接线，尚未发布或部署。**
需要配套的 [waksana/cockpit#26](https://github.com/waksana/cockpit/pull/26)；
准确构建契约以 `tooling/host-sdk.json` 固定的源码为准，不能假定旧宿主包具有这些接口。

## 1. 所有权

| 内容 | 所有者 |
| --- | --- |
| 原生消息、历史、ask 身份与回答状态 | Copilot，经本体公开契约适配 |
| 逐消息未读记录、会话 U、全站 U | Notification 模块 |
| 推送订阅、投递记录、通知与消息关联 | Notification 模块 |
| Chat 正文渲染、分页与唯一滚动控制 | 本体 |
| 基础消息、会话状态、全局操作组件 | 本体公开组件契约 |
| 注册 state 服务与组件 middleware | 本体统一 Web 运行时，业务实现属于模块 |
| 标记何时出现、读后确认与通知策略 | 模块 |
| Service Worker 的稳定 URL、资源校验和限定作用域 | 本体公开机制 |
| worker 注册、更新、设备订阅和通知权限交互 | 模块；生命周期受浏览器规则约束 |
| 通知处理逻辑与数据 | 模块 |

本体不获得“通知业务排空后才能退出”的新职责，不等待推送服务确认，也不加入模块保活逻辑。

## 2. 当前可复用能力

模块复用宿主现有能力：

- 本地可信模块包、后端主进程 import、前后端同包、统一端口、冷加载。
- 模块命名空间 HTTP 路由、静态资源、错误报告和终止信号。
- 已加载原生 session 的事件观察。
- 共享 React、公共 Module UI v1 样式与通用 `createPortal`。
- 基础草稿 state、模块自有草稿 schema 和组件；Markdown link/image 保留独立渲染注册，
  原生历史附件走组件 middleware。草稿附件列表属于文件模块，不由通知模块或本体创建。

配套宿主新增通用接口，不包含未读账本或推送业务：

- Web API v2：context 与返回声明都要求 `apiVersion: 2`，旧 Web 插口不保留兼容层。
- `context.state.register` 注册已有 UnreadStore 与 DeviceBridge 等共享状态服务；
  不按消息重复创建 store 或发 HTTP，不把未读写入本体原生数据。
- `components` 注册 message/sessionStatus/globalActions middleware，
  使用基础 props 的身份、完成事实、正文 bodyRef、children/adornment 组合原组件。
- `context.state.host` 提供当前会话、前后台和连接状态；`onInvalidate` 接收既有模块变化提示。
- 后端 `controlEvents` 观察已有会话控制投影；`invalidate()` 复用已有 SSE，
  不增加 graceful 等待。
- manifest 声明 `frontend.worker`；宿主校验并服务稳定、窄作用域 worker 资源，
  不自动注册 worker，也不申请通知权限。

实时观察不等于可恢复的完整事件订阅，不能保证自动发现宿主外产生的所有历史。
接口、版本和最小能力检查见固定 SDK 与[实现说明](implementation.md)。

## 3. 逐消息展示与可见性

本体给模块提供稳定的原生消息/宿主请求身份、当前 session 和必要呈现生命周期信息，
让模块只关注自己尚未读的条目，不扫描完整历史，也不依赖正文私有选择器。

红线作为真实 adornment 节点放在正文的现有呈现父节点中、与正文并列，
使用外侧留白，不包裹或替换正文，也不改变 Markdown 首末子元素的排版。
计数数字属于附加展示，不挤掉已有会话标题或原生待回答状态。
Middleware 增强的是 React 组件，不为它增加 HTML 包装层或空占位容器。
正文、卡片、输入框与 dialog 的视觉几何保持不变，原有 refs/children/actions 必须组合保留。

模块依据 message 的 bodyRef 观察真实裁剪、遮挡和稳定可见时间；宿主不决定“已读”。
页面进入后台、组件卸载、路由变化会取消对应观察，不继续产生旧的可见确认。
600ms 阅读阈值与 150ms 批量窗口均在模块内部，不硬编码进本体。
原生问答选择独立的请求草稿，不清空或借用缓存的普通 prompt 草稿。
这不改变 ask 的通知身份和阅读规则：核销提醒不等于回答，结束/替换仍按原生控制事实撤销提醒。

## 4. 按需快照与新消息告知

模块后端是 U 与已读记录的权威；前端可以保留当前展示快照与必要在途状态，
不能悄悄各自维护永久独立的计数。

网页初始化、回前台、切会话与重连取完整快照；自己的批量核销直接返回新快照。
不需要每条消息先 GET 再确认已读，不主动广播每次核销，也不后台轮询。
其他客户端的已读可以等下一次成功同步再体现。

现有 `/events` 主要提供 session 元数据，具体聊天流服务当前可见会话。
不能据此推断前端已收到所有 session 的最终回复 ID，更不能用活动时间变化代替计数。
为及时发现其他会话新增 U，模块插入完成后通过已有 SSE 发送
`module/invalidated { moduleId }` 通用状态变化提示，可见前端合并触发快照读取。
提示不携带未读集合或聊天正文，不能用它自行增减 U。

不为每个 session 或每条消息新开连接，避免放大 HTTP/1.1 多标签页连接池占满问题。
状态机的完整快照、代际、旧响应和 dirty 合并规则见[网页状态机](state-machines.md#client)。

原生最终回复与 ask 的统计只能通过固定 SDK 的公开事件核对；模块只登记本运行代的新实时事件，
不做停机补读、不从 native home 扫盘恢复。读取 cursor 仍只是原生分页位置，不是已读状态。
模块重启清零以及推送配置的独立稳定来源见[内存生命周期](state-machines.md#restart)。

## 5. 历史位置与导航

未读数量与红线不依赖旧消息已经加载；用户可以正常向上翻阅，复用本体已有分页。

首版不新增“首条未读”定位或自动翻页。通知点击进入对应会话，不把“进入会话”当成 READ；
具体消息出现并满足呈现规则后再核销。现有 Chat 保留唯一滚动控制器。

当前 SDK 主要提供 opaque cursor 分页，没有现成的按任意 messageId 直接读取附近内容的公开接口。
不能将 UUID 自行拼成 cursor；很远的目标可能需要读取中间历史，不能承诺秒跳。
未来若增加定位入口，需要另行明确成本上限与取消方式，不影响当前按消息身份计数。

## 6. PWA 与系统通知

网页 U、PWA 图标和系统通知是同一状态的不同消费者，能力不相同。

- 使用支持的 Badging API 提交全站 U；为零时明确清除角标。角标不会自动清理通知。
- 以用户明确操作申请通知权限，不在模块加载时自动弹系统授权框。
- 通知通过本应用的 Service Worker 注册产生，并在 `data` 中携带消息/session 关联身份。
- 清理时只查询并关闭本应用、相应消息及版本范围内的通知，不清理其他应用或其他会话；
  不能用一个总数判断具体哪条已读。
- Safari 的 `tag` 支持不足以作为通知替换/去重的唯一依据；应评估 `getNotifications()`、
  `data` 与 `close()` 的组合，并以实际支持平台检验。
- iOS/iPadOS 16.4 起支持主屏幕 Web App 的 Web Push 和 Badging；仍受用户权限与系统设置影响，
  不能把普通浏览器标签页与安装后的 PWA 混为一种身份。
- Web Push 的后台执行和可见通知要求不允许无限制的静默跨设备同步；
  不给 READ 额外发送清除 push，不承诺另一台休眠设备的通知及角标被立即清空。

后台 PWA 不运行完整 Chat 或未读账本，收到 push 时只处理该条通知与所带总数；
打开后统一应用权威完整快照并清理旧通知。generation/revision 与消息 createdRevision
避免旧总数倒退、旧快照误清新通知。具体规则只在[PWA 状态机](state-machines.md#pwa)维护。

宿主稳定 worker URL 为 `/_modules/workers/cockpit-notification/worker.js`，
scope 限于该模块目录；应用部署前缀保留。模块页面通过 MessageChannel 与该注册通信，
不要求 worker 控制 Chat。不引入离线页面缓存或全站请求代理。
旧 worker 通过宿主 bootstrap 发现当前成功加载模块的摘要绑定 API；
运行诊断不等于模块被停用。跨代需要新完整快照确认，同代普通 push 不额外 GET。
升级与停用受浏览器执行时机约束，详见[安装说明](installation.md)。

参考：
[WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)、
[WebKit Badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)、
[WebKit Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)、
[Chrome Badging](https://developer.chrome.com/docs/capabilities/web-apis/badging-api)、
[Notifications 标准](https://notifications.spec.whatwg.org/)、
[MDN 浏览器兼容数据](https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json)。

浏览器支持表会变化；这里记录设计限制，不代替发布时的能力检测和真机覆盖。

## 7. 成熟 IM 的参考边界

Matrix 的 `/sync` 提供初始状态及后续同步；TDLib向客户端提供会话未读计数与阅读更新。
这些产品不要求 UI 只靠当前已渲染消息猜出全局未读。Element/TDLib 的提醒抑制与延迟也
与已读状态分工，通知本身不是未读账本。

本模块只借鉴统一状态、身份、幂等与快照校正。普通 Matrix/TDLib 阅读回执常表示
“读到该消息及之前”，不能用来替代本模块“只核销看到的具体消息”的要求。
其持久历史/增量补差体系也不直接搬入本模块；内存重启清零是刻意的产品取舍。

参考：
[Matrix sync](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3sync)、
[Matrix receipts](https://spec.matrix.org/latest/client-server-api/#receipts)、
[TDLib 接口定义](https://github.com/tdlib/td/blob/d1085f9cebc5a62379991ae1652673954f229c1f/td/generate/scheme/td_api.tl)、
[Element 通知策略](https://github.com/element-hq/element-web/blob/26771fd3b1576f8b35928ce8bba33a2ab6e7def4/apps/web/src/Notifier.ts#L500-L594)、
[TDLib 通知延迟](https://github.com/tdlib/td/blob/d1085f9cebc5a62379991ae1652673954f229c1f/td/telegram/NotificationManager.cpp#L841-L877)。
