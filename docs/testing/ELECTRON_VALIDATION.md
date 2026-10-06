# Electron 验证技能

适用：Sage 0.6.753 起，技能包 1.0.1。技能名 `electron-validation`，随包技能 ID `sage.electron-validation`。

## 使用

从技能市场或离线技能包安装 `sage.electron-validation`，然后为当前项目启用。源码位于 `resources/plugins-external/sage.electron-validation`，不会随 Sage DMG 作为内置插件分发。对话中输入：

> 使用 electron-validation 验证这个 Electron 项目。先列出可观察的验收条件，再运行真实 Electron 测试，提供日志、截图和未覆盖项。重点检查控制中输入锁、暂停接管和恢复。

发布的技能包将技能与执行器一起分发，无需安装 Codex 技能，也不依赖 Sage 源码仓库。修改规范来源 `docs/testing/electron-validation/` 后，运行 `node scripts/sync-electron-validation-skill.cjs` 更新外置插件包副本。

Sage Agent 的执行闭环：

1. 用 Skill 读取 `electron-validation`。
2. 用 Plugin 调用 `{"action":"call","plugin":"sage.electron-validation","service":"validation","method":"prepare","args":{}}`，获得随包执行器的路径、源码和用法。
3. 用 Write 将返回源码写到当前项目的 `.sage/electron-validation/1.0.1/run.cjs`；已存在且内容不同的文件保留，改用新路径。
4. 为目标项目选择或编写真实 Electron 测试，通过 Bash 执行下方命令。
5. 用 Read 读取报告和日志，按需读取截图；根据失败修复并重跑，最后报告证据与边界。

插件只返回自身携带的执行器，不申请写入或命令权限。写文件和执行沿用 Sage 正常工具及项目审批，不通过插件绕过。目标项目仍需 Node.js、Electron 依赖、图形会话和对应测试；技能不附带通用于所有应用的测试断言。没有这些工具或运行环境时应报告缺失条件。

在 Sage 源码根目录运行：

```sh
npm run test:electron-validation
node scripts/test-electron-validation-skill.cjs
```

需要已安装的项目依赖、可运行的 Electron 和图形会话。Linux CI 需要可用的显示服务器（例如项目已有的 Xvfb）；本次只验证 macOS arm64。`SAGE_TEST_ELECTRON` 可显式指定兼容的开发版 Electron 可执行文件；不要填写安装版 Sage 二进制来假装运行此 fixture。若出现 ENOENT，先检查 `node -p 'require("electron")'` 指向的文件和锁定的 Electron 版本。

技能源：[electron-validation/SKILL.md](electron-validation/SKILL.md)，执行器维护源：[scripts/run.cjs](electron-validation/scripts/run.cjs)。Sage 包中的技能正文与 `plugin.js` 内嵌执行器均由以下命令生成，构建检查两者一致性：

```sh
node scripts/sync-electron-validation-skill.cjs
```

由 Agent 写入执行器后，其他 Electron 项目可直接运行自己的测试：

```sh
node .sage/electron-validation/1.0.1/run.cjs \
  --project . --timeout 120000 \
  -- node scripts/your-electron-test.cjs
```

这条命令不引用 Sage 或 Codex 的安装路径。插件导出为离线技能包时，执行器也随 `plugin.js` 一起导出。Sage 自身的 `test-browser-agent.cjs` 是该项目测试，不随技能包提供；其他项目使用自己的测试。

执行器不依赖第三方模块，不通过 shell 拼接命令。每次在系统临时目录产生独立报告，`ELECTRON_VALIDATION_OUTPUT` 传给测试脚本以集中保存证据；Sage fixture 已接入。其他脚本需要自行写入该目录或输出其证据路径。POSIX 下清理该次启动的进程组；Windows 仅清理直接子进程，需要测试框架负责其后代进程。

## 成熟方案与选择

| 方案 | 用途 | Sage 本次采用 |
| --- | --- | --- |
| Electron 原生集成 harness | 精确控制主进程、webview、IPC、隔离目录 | 保留并增强已有 browser-agent 测试 |
| Playwright Electron | 完整窗口、定位器、等待断言和 E2E | 技能提供迁移指导；本次未引入或宣称跑过 |
| WebdriverIO Electron service | 已有 WebDriver 体系和桌面应用生命周期管理 | 技能支持复用；本次未引入或宣称跑过 |

依据：[Electron 官方自动化测试指南](https://www.electronjs.org/docs/latest/tutorial/automated-testing)、[Playwright Electron API](https://playwright.dev/docs/api/class-electron)、[Electron webContents API](https://www.electronjs.org/docs/latest/api/web-contents)。Playwright 的 Electron 支持仍标记为 experimental；使用项目兼容版本，不直接升级已有依赖。

## 证据与验收范围

`report.json` 保存命令数组、工作目录、Node/系统/架构、起止时间、退出码、信号及 `passed / failed / timeout / interrupted / launch-error`。这是进程结论，**不自动等同 Electron 覆盖率**。同时读取：

- `stdout.log` / `stderr.log`：原始执行日志。
- `sage-agent-browser-*/evidence.json`：真实 Electron/Chromium 版本、断言分组、替身和未覆盖项。测试未启动或超时可能没有此文件，不能补判成功。
- `locked.png` / `paused.png` / `full-window-mask.png`：真实窗口截图；失败时尽可能保存 `failure.png`。

当前验证：shield/inert/tabIndex/命中测试/焦点隔离、锁定期间 Agent 填写和点击、暂停解锁并拒绝 Agent 操作、继续重锁、任务结束解锁、所有权、取消、视口和表单保留、跨会话恢复、全窗口蒙版。

替身：应用 store、PluginSlot、宿主窗口查找和视觉模型。实际使用生产 BrowserWorkspace、WindowOverlay、browser-agent 和预览桥接。窗口是隐藏的 fixture shell；这不是完整 Sage 启动测试。DOM 命中测试不等同真实系统鼠标事件，调用暂停函数不等同点击标题栏按钮。截图生成不等同视觉模型验收。

若需求要求人工鼠标/键盘实际路由，需补充 host window 合成事件与解锁后的正向对照，再断言 guest 收到的事件计数/输入结果；直接向 guest 注入会绕过遮罩。若要求发布安装体验，另外运行打包应用启动与 OS 层交互检查。

## 维护与验证

`test-electron-validation-skill.cjs` 验证执行器成功、非零退出、超时、启动失败，以及真实 Sage PluginManager 的打包安装、启用、技能读取和禁用；另外导出并重新导入离线包，在没有 Sage/Codex 源码的临时项目中获取、写入和运行随包执行器，核对成功及失败报告。默认命令另行运行真实 Electron fixture，二者不可互相替代。

修改技能源后同步副本；修改测试断言后同步 evidence 的范围说明。发布遵循 [打包规范](../PACKAGING.md)。本技能本身不强制其他项目生成 DMG。

## 验证记录

2026-09-27，macOS arm64，Electron 31.7.7：离线技能包导入/调用/写入执行器/进程报告测试通过；真实 Sage 沙箱插件运行时调用 `validation.prepare`，在不含 Sage/Codex 源码的临时项目中运行随包执行器和真实 Electron 页面断言通过，生成报告与截图。此页面测试验证分发执行链路，不代表任意应用的验收覆盖。

本轮闭环报告目录：系统临时目录下 `electron-validation-PuDX7u`；浏览器 Agent 集成回归目录：`electron-validation-97Ma1e`。这些是可清理的本机执行证据，长期复核请重新运行：

```sh
node scripts/test-electron-validation-skill.cjs
node scripts/test-electron-validation-runtime.cjs
npm run test:electron-validation
```

本机默认 Electron 可执行文件缺失，实际运行使用 `SAGE_TEST_ELECTRON=/private/tmp/sage-preview-electron-runtime/Electron.app/Contents/MacOS/Electron` 指定已有且签名校验通过的开发运行时。其他机器使用其项目安装的 Electron；不要依赖这个临时绝对路径。本轮没有执行 OS 级键鼠、完整应用 E2E 或真实视觉模型验收。之前额外安装的本机 Codex 技能已移除。
