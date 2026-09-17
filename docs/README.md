# 文档索引

**当前只有文档，功能尚未实现。**

每个主题保留一个权威位置；先区分已确认需求、实现候选和未决问题。

| 文档 | 性质 | 负责内容 |
| --- | --- | --- |
| [项目入口](../README.md) | 当前状态 | 目标、命名、实现进度与入口 |
| [产品要求](requirements.md) | 已确认要求 | U、计数范围、阅读后清除、红线几何、通知关联与跨端一致性 |
| [模块与宿主边界](integration.md) | 边界 / 候选设计 | 双方所有权、现有接口差距、历史分页、PWA 与权限边界 |
| [待细化设计](design-questions.md) | 未决问题 | 原生最终回复判断、读取条件、初始化、恢复、通知投递和工程选型 |
| [开发原则](../CONTRIBUTING.md) | 协作约定 | 语义正确、隔离、范围、许可与变更方式 |

## 维护规则

1. 用户已确认的行为只在产品要求维护；不要从某个实现方便与否倒推需求。
2. 尚未确定的存储、事件、API、阈值和部署方案写在待细化设计，不伪装为现有接口。
3. 具体问题和排查证据可以进 issue 或 PR；产品正文不复制大量聊天或临时诊断记录。
4. 本体的通用 UI/模块契约由本体文档维护；这里引用它，不复制一份类型声明。
5. 需求、源码完成、合并、发布、安装、实际运行是不同状态，分别如实记录。

宿主参考：
[产品边界](https://github.com/waksana/cockpit/blob/main/docs/product-requirements.md)、
[模块契约](https://github.com/waksana/cockpit/blob/main/docs/module-contract-draft.md)、
[公共 UI 指南](https://github.com/waksana/cockpit/blob/main/docs/module-ui-guide.md)、
[交互语义与结构要求](https://github.com/waksana/cockpit/blob/main/docs/DEVELOPMENT.md#interaction-semantics-and-structural-correctness)。
