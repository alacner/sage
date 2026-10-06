# 内置模块与外置插件依赖

适用 Sage 0.6.743 及后续版本。

Sage 的内置宿主能力只有 Git 与 Browser。浏览器窗口和安全策略由内置 Browser 宿主实现；`sage.browser` 是面向插件的浏览器自动化 API 包，外置插件通过该包调用宿主能力。

从 0.6.850 起，内置网页的链接右键菜单提供“在外部浏览器中打开”。它只打开当前右键选中的有效 HTTP(S) 链接；普通点击仍在内置网页中导航，新标签页和复制链接操作继续保留。打开失败时菜单收起并显示错误提示，当前页面及其表单状态保留。回归检查：`node scripts/test-browser-link-context-menu.cjs` 使用真实 React 组件和 webview 菜单事件，系统浏览器调用使用替身。

`resources/plugins/sage.browser` 是随应用提供的 API 适配包，不包含 Chromium 或浏览器 UI。它只把插件调用转发给主进程 Browser 宿主；宿主继续执行权限、项目范围、隔离及审批检查。外置插件统一依赖 `sage.browser/automation`，不直接绑定 Browser 私有 host 路由。

以下 Sage 插件均为独立外置插件，源码位于 `resources/plugins-external/`，需要单独安装，不随 Sage DMG 自动安装：

| 外置插件 | 宿主/插件依赖 |
| --- | --- |
| `sage.delivery-loop` | Git、Browser 宿主 API |
| `sage.temp-image-upload` | 当前消息附件与上传宿主服务 |
| `sage.page-report` | `sage.browser` 服务包 |
| `sage.snippets` | `sage.browser` 服务包；使用宿主通用加密插件密钥存储 |
| `sage.mfa` | `sage.browser` 服务包；使用宿主通用加密插件密钥存储 |
| `sage.browser-acceptance` | Browser 宿主 API；提供可选浏览器验收技能及断言扩展点 |
| `sage.electron-validation` | Electron 验收技能与执行器 |
| `sage.mcp` | MCP 宿主服务；凭据和连接仍由宿主管理 |

外置插件必须在 manifest 中声明服务依赖和权限，并经安装授权后调用。宿主新增能力时通过插件 SDK 的 host service 或受控扩展点开放，同时验证权限、数据边界及返回值。Snippets 与 MFA 的专用记录格式、查找、TOTP 计算和安全填充逻辑都属于外置插件；宿主只提供与插件无关的 secret 类型配置存储、加密和遮盖能力。

`npm run check:bundled-plugins` 只校验随应用分发的插件闭包；`resources/plugins-external/` 下的插件独立打包发布，不随 DMG 分发。可选原生引擎仍按[外置引擎规则](BACKEND_ENGINES.md)独立安装和授权。
