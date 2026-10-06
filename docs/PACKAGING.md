# Sage 打包与交付规范

适用：0.6.x。仓库根目录是以下命令的工作目录。

## 每次需求完成

1. 保留其他人的未提交改动，只提交本轮相关内容。
2. 将版本增加到下一个 `0.6.x`，同步 `package.json` 与 `package-lock.json`。
3. 运行改动相关测试与 `npm run typecheck`；检查 `git diff --check`。
4. 提交源码、文档及版本，然后构建，确保 `build-info.json` 指向这次提交。

```sh
npm run dist:dmg
```

此命令先构建前端/主进程/引擎，再通过 electron-builder 生成 DMG，并生成自动更新清单。
产物在 `release/`；文件名包含版本与架构。不要把旧 DMG 改名当作新版本。
当前机器构建的 arm64 包只代表 arm64 验证，不宣称已经验证 x64。

## 核验

用实际产物文件名替换示例版本：

```sh
bash tools/verify-dmg.sh release/Sage-0.6.521-arm64.dmg
codesign --verify --deep --strict release/mac-arm64/Sage.app
```

核对挂载镜像内只有一个 Sage.app、版本正确、app.asar 存在、不包含项目/用户数据。
检查 Resources 下 build-info 的提交号，插件与 SDK 文档是否齐全；最后卸载镜像。
本地 ad-hoc 签名验证成功不等同于 Apple Developer ID 签名或公证。

卸载核验镜像后检查失效 Sage 注册条目。数据库不可用、注销失败或仍有失效记录时必须报告失败，不能把受限环境返回的空列表当成清理完成；仅处理已不存在的路径。图标的绘制与现场核验边界见 [Dock 图标诊断](quality/DOCK_ICON_RECOVERY.md)。

## 更新与部署

DMG 构建只生成文件，不自动部署网站或上传更新。
只有获得明确发布要求后才把 DMG 与对应更新清单上传；不要上传不匹配的版本/摘要。
网站开发/部署说明和技能市场接口见 [技能市场](website/SKILL_MARKET.md)。

`scripts/sign-local.sh --no-build` 只适合重新签名已有构建，**不能用于代码修改后的交付**。
旧流程完整记录保存在 [归档](archive/PACKAGING.legacy.md)，不再作为首选说明。

交付时提供版本、Git 提交、DMG 绝对路径、已运行测试及未完成项。

## Electron 运行程序（0.6.834 起）

桌面使用 Electron 43.7.7，要求 macOS 12 或更新系统，开发构建要求 Node 22.12.0 或更新版本。Electron 42 起 npm 包不再自动下载运行程序，首次安装依赖后执行 `npx install-electron`；然后按上文构建。附件引用通过 preload 的 `webUtils.getPathForFile` 桥获取路径，不再读取已删除的 `File.path`。

官方原始运行程序需与其 `SHASUMS256.txt` 核对。原始 ZIP 的 linker ad-hoc 签名没有应用资源封套，不能将其作为已受 Gatekeeper 信任的发行 App。Sage 打包阶段生成本地开发签名，并保留隔离及来源属性；此签名不能代替 Developer ID 和 Apple 公证。若 macOS 报 Malware，停止运行并核查来源与系统日志，不清除隔离或关闭系统保护来绕过。

桌面和移动端可采用不同补丁版本，各自更新清单独立发布。本次移动端为 0.6.833，桌面运行程序迁移为 0.6.834。
