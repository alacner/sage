# Sage 文档索引

当前客户端：0.6.860 / SDK 1.5。后续新项目文档统一放在 `docs/`，不散落源码目录或仓库根目录。
运行时必须随包提供的 `SKILL.md`、生成的 SDK 文档副本不作为另一份维护源。

## 当前入口

| 读者 / 目的 | 文档 |
| --- | --- |
| 使用 Sage | [中文帮助](HELP.zh-CN.md) / [English help](HELP.en.md) |
| 根据具体案例二次开发 | [场景化二次开发手册](EXTENSION_COOKBOOK.md) |
| 查看已实现扩展机制与边界 | [扩展架构与接入](EXTENSIBILITY.md) |
| 查询 hooks、events、策略及 UI 插槽 | [扩展点完整清单与迁移](PLUGIN_EXTENSION_CATALOG.md) |
| 安装、开发、调试插件 | [插件手册](PLUGIN_MANUAL.md) / [English](PLUGIN_MANUAL.en.md) |
| 提供引擎状态栏单色图标 | [插件手册：单色图标](PLUGIN_MANUAL.md#41-插件自带单色图标sdk-15) / [图标字段约束](PLUGIN_API_REFERENCE.md#57-单色图标manifesticon) |
| 查询基础 SDK 与宿主 API | [API 参考](PLUGIN_API_REFERENCE.md)，新场景以二开手册及 schema 为准 |
| 下载中心与镜像源 | [配置、更新清单与安装兼容](website/DOWNLOAD_MIRRORS.md) |
| 临时图片上传 | [附件上传使用、接口与部署](website/TEMP_IMAGES.md) |
| 外置敏感信息插件 | `resources/plugins-external/sage.snippets` 与 `resources/plugins-external/sage.mfa` |
| 网站技能市场 | [市场接口、发布与运维](website/SKILL_MARKET.md) |
| API 直连请求身份 | [User-Agent 选项、版本与自定义](settings/API_USER_AGENT.md) |
| 桌面截图与屏幕分析 | [内置桌面观察技能](skills/DESKTOP_OBSERVATION.md) |
| Mac 按芯片更新 | [Apple 芯片与 Intel 的清单和兼容](packaging/MAC_UPDATE_MANIFESTS.md) |
| 构建和交付 | [打包规范](PACKAGING.md) / [发布包体积控制](packaging/SIZE_CONTROL.md) |

## 专题

- [0.6.860 iOS 本地通知与个人开发团队签名修复](quality/0.6.860/REVIEW.md)

- [0.6.859 本轮功能、关联返修与标准复验](quality/0.6.859/REVIEW.md)

- [0.6.848 三端功能清单、插件专项与三轮审查](quality/0.6.848/REVIEW.md) / [标准与客观评分边界](quality/0.6.848/STANDARDS.md)

- [2026-10-01 剩余 12 个原路径补齐与 Git 历史缺口](recovery/20261001-remaining-recovery.md)
- [0.6.822 首次迁移恢复核查（历史）](recovery/20261001-recovery-audit.md)
- [项目目录移动：对话、任务归属与授权重新确认](recovery/PROJECT_RELOCATION.md)

- [新版配置引导：中继、API、CLI、模型与帮助](quality/ONBOARDING_V2.md)
- [桌面蒙版截屏、可调选区、标注与复制保存](quality/SCREENSHOT_RECOVERY.md)
- [Dock 空白图标：实际绘制回调、日志与注册核验](quality/DOCK_ICON_RECOVERY.md)

- [桌面宠物、四边四角探头与消息气泡](pet/README.md) / [定时通知可读摘要](pet/NOTIFICATION_SUMMARIES.md)
- [macOS 前台快捷键拦截与权限](quality/FOREGROUND_SHORTCUTS.md)

- [Fn 语音和截屏默认快捷键](quality/INPUT_SHORTCUTS_0.6.794.md)

- [0.6.792 对话语音与截屏快捷键](quality/INPUT_SHORTCUTS_0.6.792.md)

- [0.6.790 插件、任务授权、Git、快捷键与帮助核验](quality/EXPERIENCE_REVIEW_0.6.790.md)
- [帮助编制规范与主题目录](help/AUTHORING.md)

- [0.6.789 桌面与网站体验、性能和安全检查](quality/WORKSPACE_REVIEW_0.6.789.md)

- [Specs / Docs 外置插件与证书设置](WORKFLOW_PLUGINS.md)

- [对话交互](conversation/INTERACTIONS.md)

- [对话式授权](conversation/AUTHORIZATION.md)

- [对话工具显示名称](conversation/TOOL_NAMES.md)

- [对话底部合并状态条](testing/ACTIVITY_CAPSULE.md)

- [Electron 验证技能与执行方法](testing/ELECTRON_VALIDATION.md)

- [悬浮浏览器预览、Agent 联动与截图显示](BROWSER_PREVIEW.md)
- [Qoder CLI 后端](QODER_CLI.md)
- [内置模块与随包依赖检查](BUILTIN_DEPENDENCIES.md)
- [窗口级模态蒙版](WINDOW_OVERLAYS.md)

- [复合提供商的混合协议兼容、编辑与旧配置迁移](website/COMPOSITE_PROVIDER_COMPATIBILITY.md)

- [历史归档：长连接模型提供商与接入协议（已移除）](website/archive/PERSISTENT_PROVIDERS.md)

- [定时任务：关联对话、归档暂停、推荐案例与执行记录](SCHEDULED_TASKS.md)

- [词元活跃度彩蛋游戏](ACTIVITY_GAMES.md)

- [专家团主子任务交互](EXPERT_TASK_INTERACTION.md)
- [界面交互调整：悬浮提示、左栏配色与布局及对话变更汇总](INTERFACE_REFINEMENTS.md)
- [模型选择、强度继承与复合模型活动日期配置](MODEL_SELECTION.md)

- [多条记忆与标签融合](MEMORY_FUSION.md)

- [第三方模型 API 可读别名与兼容策略](website/MODEL_API_ALIASES.md)
- [中继客户端服务鉴权、发布归属与审计](website/CLIENT_SERVICE_AUTH.md)
- [网站模型价格数据：采集口径、规范模型并表与告警](website/MODEL_PRICES.md)

- [澄清交互、上下文计量与对话回归](CHAT_TIMELINE_REVIEW.md)

- Git：[仓库浏览](GIT_BROWSER.md)；配色扩展见二开手册场景一。
- 后端：[非内置引擎开发与 hooks](BACKEND_ENGINES.md)、[Codex CLI](CODEX_CLI.md)。
- 安全：[授权配置与单次 AI 预审](SECURITY_CONFIGURATION.md)、[审批策略](SECURITY_POLICIES.md)、[配置档位](SECURITY_PROFILES.md)、[命令预审](COMMAND_PRE_REVIEW.md)。
- 协作：[定时/渠道/对话手册](SCHEDULE_CHANNEL_CONVERSATION_MANUAL.md)、[链路走查](THREE_WAY_INTEGRATION_DEEP_DIVE.md)、[定时交互实现说明](SCHEDULED_TASKS_CONVERSATIONAL.md)。
- 文件：[图片预览、提交方式与自动视觉解读](IMAGE_PREVIEW.md)。
- 样例：[项目笔记](plugin-examples/local.notes/README.md)、[模型摘要](plugin-examples/local.summary/README.md)。

## 设计和历史记录

- [模块内存与资源生命周期审查](quality/MEMORY_REVIEW.md)：0.6.805 修复、压力测试、缓存边界与网站部署范围。

这些文件保留当时的分析或方案，不应直接解释为当前版本全部行为：

- [早期插件设计](PLUGIN_PLATFORM_DESIGN.md)：旧“当前缺口”已经部分实现，当前契约见扩展架构。
- [沙箱设计草案](SANDBOX_DESIGN.md)：草案不是授权策略；以当前安全文档和执行器为准。
- [对话时间线审查](CHAT_TIMELINE_REVIEW.md)、[设置可靠性审查](settings-integrity-review.md)：特定日期的验证记录。
- [0.1.0 旧使用手册](archive/USER_GUIDE.md)、[0.1.0 旧完整手册](archive/SAGE_COMPLETE_MANUAL.md)：已归档，不再当作当前用户入口。
- [对话删除修复记录](archive/FIX_CONVERSATION_DELETE.md)、~~[移动端阶段总结](archive/MOBILE_IMPLEMENTATION_SUMMARY.md)~~（文件已缺失，保留条目作为历史记录）：保留历史证据。

## 维护规则

1. 新文档先在本索引登记，并写清适用版本、实际能力和未实现边界。
2. 当前手册优先修订，不为每次小改动复制一套“最新版大全”。
3. 归档保留内容和明确状态，不删除有价值的历史；搬迁后检查相对链接和打包读取路径。
4. 敏感配置、真实 Token、用户会话和机器私有路径不进入样例。
5. Markdown 样例应标明是完整文件还是字段/函数片段；大模型不能把设计草案当成可调用 API。

本轮已修正插件手册 SDK/版本标记和 Git 配色说明，更新打包入口，并新增逐场景手册。
旧专题未做逐行重验，因此没有将其一律标注为“已验证 0.6.521”。
## 模型与文件界面

- [模型类型检测与展示](MODEL_TYPES.md)；[中继共享缓存接口与部署](website/MODEL_TYPE_CACHE.md)
- [Markdown 标签页名称](MARKDOWN_TABS.md)
- [图表与内容图片复制](IMAGE_COPY.md)

- [AI 预审检查项编辑](security/REVIEW_CHECKS.md)

- [0.6.846 模型目录修复与打包](releases/0.6.846.md)
- [0.6.845 历史交付范围](releases/0.6.845.md)
