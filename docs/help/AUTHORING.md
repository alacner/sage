# Sage 帮助语料编制计划（Help Authoring Plan）

本文件是应用内帮助（AboutModal → Sage 帮助）语料的**预检配置**，角色等同于 repowiki 的 `wiki_plan.yaml`：
它定义主题白名单、分组树、页面模板与刷新纪律。改动 `src/help/topics.json` 前先读这里；
`scripts/test-help.cjs` 会用测试守护本计划的硬性条款。

## 1. 数据源与生成链

- **唯一事实源**：`src/help/topics.json`（应用内语料，双语）。
- `docs/HELP.zh-CN.md` / `docs/HELP.en.md` 由 `node scripts/gen-help.cjs` 再生成，
  **禁止手改**；CI/提交前用 `node scripts/gen-help.cjs --check` 校验同步。
- 应用内渲染（`src/components/AboutModal.tsx`）按 `## ` 切分检索段落：
  每个主题**至少一个 `## ` 节**，搜索才能精确落到节。

## 2. 主题树白名单

新增主题 = 在 `src/help/topics.json` 与本清单同时登记，并把 id 加进 `scripts/test-help.cjs` 的
`TOPIC_IDS` 白名单。数组顺序即导航分组顺序（首现分组定序）。

| # | 分组 zh / en | 主题 id |
|---|---|---|
| 1 | 快速开始 / Getting started | overview, onboarding |
| 2 | 对话与模型 / Chat & models | chat-intro, chat-search, chat-experts, chat-resume, chat-tools, chat-capabilities, context-strategy |
| 3 | 模型与提供商 / Models & providers | model-providers, model-composite |
| 4 | 编辑器与文件 / Editor & files | editor-intro, editor-syntax, editor-ctxmenu |
| 5 | 插件与扩展 / Plugins & extensions | plugins, plugin-activation, plugin-market, extension-platform, dev-quickstart, dev-services, dev-ui, dev-lifecycle, dev-release, skills, hooks, mcp-servers, engine-plugins |
| 6 | 内置模块 / Built-in modules | browser-plugin, git-plugin, git-recovery, project-wiki, terminal-panel, desktop-pet |
| 7 | 自动化与渠道 / Automation & channels | scheduled-intro, scheduled-authorization, channels-intro, channels-feishu, channels-relay |
| 8 | 工作流 / Workflows | spec-intro, spec-create, spec-refine, spec-execute, spec-retro, loop-intro |
| 9 | 安全与授权 / Security | sandbox-intro, sandbox-network |
| 10 | 数据、排查与设置 / Data, diagnostics & settings | monitor-intro, troubleshooting, data-storage, memory-merge, data-cleanup, settings-backup, update-intro, appearance, multi-window, voice-input, screenshot, shortcuts |

Backlog（候选，未立项）：多窗口实时协作增强、终端分屏。

## 3. 页面模板（每主题）

```markdown
# {标题}            ← 必须与 title 完全一致
{一段定位：是什么 + 什么时候用，2-3 句}

## 使用             ← 编号步骤；界面路径用「设置 → 通用」格式
## 配置             ← 有配置项时；写清默认值与生效时机
## 边界与注意        ← 权限、安全、易误解点、与相邻功能的区别
## 相关主题          ← 纯文本列出其他主题标题（应用内无锚点，不要加链接）
```

- 小节按需取舍，但每主题 ≥1 个 `## ` 节；节标题用动词或名词短语，≤10 字。
- 陈述以**代码/界面证据**为准：功能说法能在设置页、源码或 docs/ 设计文档中找到出处；
  不写"即将支持"的计划性内容。
- 数字与默认值（保留份数、MB、天数等）必须与实现一致；改动实现时同步刷新本语料。

## 4. 双语与术语

- zh/en 的 `title`、`summary`、`content` 各自独立成文，不逐字对译，但信息对等。
- `keywords` 为**跨语言共享**字符串：中英都放，空格分隔，10–25 个，
  覆盖功能别名、界面入口名、用户可能输入的动词/名词。
- 术语表：Skills→「技能」；Hooks→保留英文「Hooks（钩子）」；Spec/Loop 保留英文；
  提供商/中继/渠道照此表；zh 文案不用「您」，用「你」。

## 5. 检索机制备忘（src/help/search.ts）

- 本地 BM25 + 字面直接命中 + 同义词组扩展，无模型/远程依赖。
- zh 按 CJK bigram 切词：关键词多写 2 字词组；英文按 `[a-z0-9._-]+` 切。
- 字面命中（query 是正文/标题子串）加 20 分并标「直接匹配」；
  因此精确路径名（如 `settings.json.history`、`.sage/chats`）值得写进正文。
- 同义词组在 `search.ts` 的 `synonyms` 里维护；新主题有高频同义词时同步增补。

## 6. 工作流

1. 改 `src/help/topics.json` → `node scripts/gen-help.cjs` → `node scripts/test-help.cjs` → `npm run typecheck`。
2. 提交时语料、再生成文档、测试三件套同库提交。
3. 版本发布无额外步骤（语料随应用打包）。
4. **新鲜度审计**：新功能落地、设置入口改名、默认值变更时，同步刷新对应主题；
   每个补丁版本发布前抽查本计划第 2 节白名单与实际功能对位情况。
