# 文档索引

**当前为 0.1.0 开发源码，尚未发布、安装。** 通用插口需要配套宿主变更；
具体源码覆盖和平台限制见实现说明。

每个主题保留一个权威位置；先区分已确认需求、开发源码和平台边界。

| 文档 | 性质 | 负责内容 |
| --- | --- | --- |
| [项目入口](../README.md) | 当前状态 | 目标、命名、实现进度与入口 |
| [产品要求](requirements.md) | 已确认要求 | U、计数范围、阅读后清除、红线几何、通知关联与跨端一致性 |
| [未读、快照与推送状态机](state-machines.md) | 状态契约 | 内存运行代、逐消息核销、完整快照、前端同步、延迟 push、角标与通知清理、并发时序 |
| [模块与宿主边界](integration.md) | 实现边界 | 双方所有权、配套接口、历史分页、PWA 与权限边界 |
| [后续体验与平台问题](design-questions.md) | 未覆盖边界 | provider 差异、真实设备阅读与推送、长期运行及单独发布授权 |
| [首版实现](implementation.md) | 开发源码 / 能力边界 | 已落定的原生兼容判定、阅读条件、接口、容量与 PWA 保证范围 |
| [构建与安装](installation.md) | 工程契约 | 固定 SDK、锁定依赖、打包、配套宿主和运行配置 |
| [开发原则](../CONTRIBUTING.md) | 协作约定 | 语义正确、隔离、范围、许可与变更方式 |

## 维护规则

1. 用户已确认的行为只在产品要求维护；不要从某个实现方便与否倒推需求。
2. 尚未确定的存储、事件、API、阈值和部署方案写在待细化设计，不伪装为现有接口。
3. 具体问题和排查证据可以进 issue 或 PR；产品正文不复制大量聊天或临时诊断记录。
4. 本体的通用 UI/模块契约由本体文档维护；这里引用它，不复制一份类型声明。
5. 需求、源码完成、合并、发布、安装、实际运行是不同状态，分别如实记录。
6. 状态转移、逻辑 schema 和竞态结果只在状态机正文维护，其他文档引用它，
   不分别维护互相漂移的伪代码。成熟 IM 只作为设计依据，不复制其完整同步架构。

宿主参考：
[产品边界](https://github.com/waksana/cockpit/blob/main/docs/product-requirements.md)、
[模块契约](https://github.com/waksana/cockpit/blob/main/docs/module-contract-draft.md)、
[公共 UI 指南](https://github.com/waksana/cockpit/blob/main/docs/module-ui-guide.md)、
[交互语义与结构要求](https://github.com/waksana/cockpit/blob/main/docs/DEVELOPMENT.md#interaction-semantics-and-structural-correctness)。
