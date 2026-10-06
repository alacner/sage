# Specs / Docs 外置插件与浏览器证书设置

适用：Sage 0.6.766，SDK 1.4。

## 安装与迁移

Specs、Docs 不再属于预置插件，也不随 DMG 自动安装。分别在设置 → 插件中选择本地安装，导入 `release/plugins/sage.specs-1.0.0.sageplugin`、`release/plugins/sage.docs-1.0.0.sageplugin`，审核权限后安装，并选择全局或项目启用。

首次安装会迁移原有内置插件的启用状态；卸载不会删除项目的 Specs、引导文件或 Wiki 数据。重新安装并启用即可继续使用。新建、分析和时间线从侧栏打开为独立工作区视图。

源码位于 `plugins/sage.specs/`、`plugins/sage.docs/`，用 `npm run build:workflow-plugins` 构建独立安装包。界面运行于隔离 iframe，通过受权限检查的工作流桥接调用宿主执行能力；执行引擎、文件持久化仍由宿主管理，不向插件传递模型密钥。

验证：`node scripts/test-workflow-plugins.cjs`；真实 Electron 界面测试：`node scripts/test-workflow-electron.cjs`。可通过 `SAGE_TEST_ELECTRON` 指定 Electron 可执行文件。

## 两个独立证书设置

设置 → 插件 → 浏览器配置：

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| 本机和内网 IP 证书错误自动放行 | 开启 | localhost、子域 .localhost、IPv4 回环/私网/链路本地、IPv6 回环/ULA/链路本地地址自动接受证书错误 |
| 强制忽略证书错误 | 关闭 | 开启后所有站点均忽略证书错误 |

私网判断针对 URL 中的 IP 字面量和 localhost，不根据域名 DNS 解析结果推断。公网默认显示风险页；手动接受风险后，仅批准该 HTTPS origin（协议、主机、端口），重启失效。已有明确保存的设置保留，不覆盖用户选择。

用户明确授权接受指定站点证书风险时，自动化工具可在 `open` 或 `navigate` 中传入完整 URL 和 `acceptCertificateRisk: true`，获得本次应用会话的同源许可。内置页面与后台自动化浏览器使用相同策略，放行后可继续填写与点击。

验证：`node scripts/test-browser-certificates.cjs`、`node scripts/test-browser-certificates-electron.cjs`。后者使用本机自签名 HTTPS 服务验证默认值、关闭内网放行、全站配置及同源手动授权。
