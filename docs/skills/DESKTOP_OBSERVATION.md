# 桌面截图与屏幕分析

适用版本：0.6.840 起。

内置 `desktop-observation` 技能随客户端分发，按请求自动加载，也可以显式要求使用该技能。项目和全局同名技能仍可覆盖内置定义。

- “给我桌面截张图”：调用 `Desktop` 的 `capture`，直接在对话中返回图片。
- “分析下桌面”“我想知道桌面在干什么”：调用 `Desktop` 的 `analyze`，截取一次后，用已配置的视觉模型分析这同一张图，再说明可见内容。

截图复用现有 macOS 系统截屏能力，遵循屏幕录制权限。分析使用 Sage 的视觉模型配置；分析失败时保留成功截取的图片并说明原因。仅截图不会调用视觉分析，也不会上传图片到公共图床。

截图作为对话图片附件显示。手机仅通过现有鉴权连接按需获取同一条 assistant 消息中实际 Desktop 工具生成的截图，支持点击查看；消息清单只返回图片描述，不携带整张图的 base64。截图不能证明不可见的后台活动；技能不自动控制桌面或连续监控。

运行时入口：[desktop-observation/SKILL.md](../../resources/skills/desktop-observation/SKILL.md)。

CLI 模式要求 Sage 0.6.840 起。已安装 Claude CLI 引擎 1.0.5 的用户需导入本次提供的 `sage.engine-claude-1.0.6.sageplugin` 并保持启用；Codex / Qoder 动态获取宿主工具目录，无需升级引擎插件。
