# Qoder CLI 后端

适用 Sage 0.6.743，`sage.engine-qoder` 1.0.0。

## 安装与使用

1. 按 [Qoder 官方安装说明](https://docs.qoder.com/cli/installation)安装 CLI，并在终端执行 `qodercli login`。
2. 在 Sage 全局插件页离线安装 `sage.engine-qoder-1.0.0.sageplugin`，启用后在「设置 → 通用 → 后端引擎」选择 Qoder CLI。
3. 可执行文件路径留空会探测 `qodercli` / `qoder`；也可指定绝对路径。模型留空使用 CLI 默认值。

插件与 CLI 分别安装；插件不随 DMG 自动安装。宿主包含官方 Qoder Agent SDK 1.0.50，需配套本次 Sage 版本。已验证本机 CLI 1.1.63 初始化和 MCP 注册。检测成功不代表账号、模型或额度可用。

使用已有 CLI 登录状态，不复制 Sage API 密钥，不自动切换到其他计费引擎。可以直接要求「用 Browser 打开本地页面并验收」。工具与 API 引擎共享审批、浏览器会话归属和截图验收。

## 恢复与取消

- 正常续聊复用 Qoder 会话 ID，不重复注入历史。每次启动重新注册最新 Sage MCP 工具。
- 取消仍保存已收到的会话 ID、文字与工具记录，下一轮可继续。修改历史、切换引擎或上下文不匹配时，以 Sage 的文字和工具记录建立新上下文。
- 本地 Qoder 会话缺失时，只有存在 Sage 历史才重建，并在对话中提示；没有历史就报错。原图片不会凭文件名重新上传。
- 取消会打断审批等待、屏蔽迟到回调，并终止 CLI 进程组；macOS 上 TERM 后一秒仍存活的进程组会收到 KILL。已经完成的外部副作用不能回滚，不自动重跑失败整轮。
- 原生工具、额外 MCP 和用户/项目 CLI 设置加载关闭。仅注册 Sage 工具，每个工具在服务端重新检查审批。项目技能由 Sage 提供。

Qoder credits 不等于美元；未报告美元账单时不做虚构换算。

## 验证与边界

`node scripts/test-qoder-bridge.cjs` 验证真实 SDK schema、文本去重、恢复、工具审批、取消、迟到回调与错误。`--local` 额外验证已安装 CLI 的初始化和 MCP 注册，不发起模型请求。浏览器真实 Electron 回归见[预览文档](BROWSER_PREVIEW.md)。这些检查不代表已验证所有账号、模型或真实视觉服务。

接口依据：[Qoder TypeScript SDK](https://docs.qoder.com/cli/sdk/references-typescript)、[非交互模式](https://docs.qoder.com/cli/run-in-scripts)。
