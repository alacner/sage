import {runEngineTask} from './engine-task';
import {selectedEngine} from './engine-registry';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { runClaude, detectClaude } from './claude-bridge';
import { runPlanMode, runClaudeAPIAgentic, isAPIModeAvailable } from './claude-api-bridge';
import { resolveModel } from './model-resolver';
import { readSettings } from './main';
import { readDoc, writeDoc, saveSpecMeta, loadSpecMeta, readSteering, writeWiki, readPhaseChat, writePhaseChat } from './store';
import { withRetry } from './retry';
import { listDir } from './files';
import type { SpecMeta, TaskItem, SteeringDocs, WikiDepth, MonitorContext, SpecChatMessage } from '../shared/types';

type Lang = 'zh' | 'en';

/**
 * 解析项目主模型档案，返回可展开进 runPlanMode 的凭证/模型字段。
 * 命中档案时 forceApi=true，强制 plan 模式走 API 直连并使用档案凭证。
 */
async function planModelOpts(projectPath: string): Promise<{
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  protocol?: 'anthropic' | 'openai';
  forceApi?: boolean;
  relayTransport?: import("./relay-tls").RelayTransport;
}> {
  const resolved = await resolveModel({ projectPath });
  if (!resolved) return {};
  return {
    model: resolved.model,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    relayTransport:resolved.relayTransport,
    protocol: resolved.protocol,
    forceApi: resolved.fromProfile,
  };
}

/**
 * 执行单个任务的模型调用：与对话引擎一致的 CLI / API 直连路由。
 * - 命中项目模型档案 (forceApi) → 走 API 直连（协议由档案 protocol 决定）
 * - preferredBackend='api' → 走 Anthropic API 直连
 * - preferredBackend='cli' → 走 CLI
 * - auto（默认）→ CLI 可用时优先 CLI，否则 API
 * 任务执行阶段工具调用一律放行（permissionMode = acceptEdits/bypass）。
 */
export async function runTaskModel(opts: {
  cwd: string;
  prompt: string;
  permissionMode?: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';
  signal?: AbortSignal;
  onText: (chunk: string) => void;
  onSessionId?: (id: string) => void;
  resumeSessionId?: string;
  monitor?: MonitorContext;
}): Promise<{ text: string; error?: string; sessionId?: string }> {
  const resolved = await resolveModel({ projectPath: opts.cwd, task: opts.prompt });
  const forceAPI = !!resolved?.fromProfile;
  const useDirectAPI = forceAPI || await selectedEngine()==='api';
  if (!useDirectAPI) {
    return runEngineTask({
      cwd: opts.cwd,
      prompt: opts.prompt,
      permissionMode: opts.permissionMode ?? 'acceptEdits',
      signal: opts.signal,
      onText: opts.onText,
      onSessionId: opts.onSessionId,
      resumeSessionId: opts.resumeSessionId,
      monitor: opts.monitor,
    });
  }

  // API 直连：需要凭证
  const apiAvailable = forceAPI ? !!resolved : await isAPIModeAvailable();
  if (!apiAvailable) {
    return {
      text: '',
      error: '尚未配置可用的 API 模型，请在「设置 → 模型提供商」中添加提供商并配置模型。',
    };
  }

  if (resolved?.protocol === 'openai') {
    const { runOpenAIAPIAgentic } = await import('./openai-api-bridge');
    return runOpenAIAPIAgentic({
      cwd: opts.cwd,
      messages: [{ role: 'user', content: opts.prompt }],
      signal: opts.signal,
      model: resolved?.model,
      apiKey: resolved?.apiKey,
      baseUrl: resolved?.baseUrl,
      relayTransport:resolved?.relayTransport,
      canUseTool: async () => ({ allowed: true }),
      onText: opts.onText,
      onToolUse: () => {},
      onToolResult: () => {},
      onSessionId: opts.onSessionId,
      monitor: opts.monitor,
    });
  }

  return runClaudeAPIAgentic({
    cwd: opts.cwd,
    messages: [{ role: 'user', content: opts.prompt }],
    signal: opts.signal,
    model: resolved?.model,
    apiKey: resolved?.apiKey,
    baseUrl: resolved?.baseUrl,
    relayTransport:resolved?.relayTransport,
    canUseTool: async () => ({ allowed: true }),
    onText: opts.onText,
    onToolUse: () => {},
    onToolResult: () => {},
    onSessionId: opts.onSessionId,
    monitor: opts.monitor,
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/**
 * Render steering docs (product / tech / structure) into a markdown block
 * prepended to every spec phase prompt. Returns '' when nothing is set.
 */
function renderSteering(s: SteeringDocs): string {
  const cap = (txt: string): string =>
    txt.length > 4096 ? txt.slice(0, 4096) + '\n…(truncated)' : txt;
  const parts: string[] = [];
  if (s.product?.trim())   parts.push(`### Product\n${cap(s.product.trim())}`);
  if (s.tech?.trim())      parts.push(`### Tech\n${cap(s.tech.trim())}`);
  if (s.structure?.trim()) parts.push(`### Structure\n${cap(s.structure.trim())}`);
  if (parts.length === 0) return '';
  return `## Steering Context\n\n${parts.join('\n\n')}\n\n---\n\n`;
}

// ─── Bilingual Prompt Templates ─────────────────────────────────────────

const PROMPTS = {
  zh: {
    requirements: `你正在用 Spec 模式规划一个新的功能/任务。请阅读项目以理解上下文，然后产出 \`requirements.md\` 的内容。

格式要求（严格遵守，且不要在 markdown 之外加任何前后缀解释）：

# Requirements

## Overview
<2-4 句话总结要做什么、为什么做>

## User Stories
- **US-1** 作为 <角色>，我希望 <行为>，以便 <价值>。
  - **AC-1.1** WHEN <条件> THE SYSTEM SHALL <可观察行为>。
  - **AC-1.2** ...
- **US-2** ...

## Out of Scope
- <明确不在本次范围内的事项>

## Open Questions
- <需要用户澄清的歧义点；如无写"无"。>
`,
    design: `已经有了 requirements。请阅读项目代码（关注与本次需求相关的目录），然后产出 \`design.md\`。

格式要求（严格遵守 markdown，无任何额外解释）：

# Design

## Architecture
<本次改动涉及哪些模块/进程/层；用 ASCII 图或要点描述数据流>

## Data Model
<新增/修改的类型、表结构或 schema>

## Public Interfaces
<新增/修改的函数、API、IPC、CLI 等签名>

## Implementation Strategy
<分步骤说明如何把它落到代码里；说明需要修改哪些文件>

## Risks & Tradeoffs
- <潜在风险及对策>

## Test Plan
- <如何验证：单元测试、集成测试、手动验证步骤>
`,
    tasks: `已经有 requirements 和 design，请把工作拆成可独立执行的任务列表 \`tasks.md\`。

要求：
- 每个任务足够小，能在一次 claude 调用内完成（每任务改动不超过 ~200 行代码）
- 优先按功能模块纵向拆分，而非按层横向拆（例如：一个任务同时包含 model + API + UI，而非分成三个任务）
- 严格按下面的 YAML-in-markdown 格式输出，不要加额外解释
- task id 从 T1 起递增
- 每个任务必须包含 \`requirements\` 字段，列出实现的 User Story / Acceptance Criteria 编号；纯重构/基建无对应需求写 \`requirements: []\`
- 每个任务必须包含 \`verification\` 字段，列出验证步骤（如何确认任务已正确完成）

# Tasks

\`\`\`yaml
- id: T1
  title: <祈使句>
  files:
    - <相对路径1>
    - <相对路径2>
  requirements: [US-1.AC-1.2]
  verification: |
    <如何验证此任务已正确完成，比如：运行 xxx 测试、检查 UI 渲染>
  description: |
    <清楚描述要做什么、依据 design 的哪一部分；列出验收点>
- id: T2
  title: ...
  files: [...]
  requirements: [US-2.AC-2.1, US-2.AC-2.2]
  verification: |
    ...
  description: |
    ...
\`\`\`
`,
    intro: (meta: SpecMeta) => [
      `项目根目录: ${meta.projectPath}`,
      `Spec 标题: ${meta.title}`,
      '',
      '用户原始描述:',
      meta.description,
      '',
    ].join('\n'),
    existingReq: (doc: string) => `\n现有 requirements.md:\n\n${doc || '(空)'}\n`,
    existingDesign: (doc: string) => `\n现有 design.md:\n\n${doc || '(空)'}\n`,
    feedback: (fb: string) => `\n用户对上一轮内容的反馈（请据此修改）：\n${fb}\n`,
    execTask: (task: TaskItem) => [
      `你正在按照已批准的 spec 执行任务。请只完成下面这一个任务并提交修改。`,
      '',
      `## 当前任务: ${task.id} — ${task.title}`,
      task.description,
    ].join('\n'),
    execConstraints: [
      `执行约束：`,
      `- 只做这一个任务，不要扩散到其他任务`,
      `- 完成后用一句话总结你做了什么`,
      `- 如果发现 design 与现实代码冲突，直接停下并说明，不要硬改`,
    ].join('\n'),
    reqsHint: (reqs: string[]) => `\n实现需求: ${reqs.join(', ')}\n`,
    filesHint: (files: string[]) => `\n相关文件:\n${files.map((f) => `- ${f}`).join('\n')}\n`,
    retryLog: (taskId: string, reason: string, waitMs: number, attempt: number) =>
      `[retry] 任务 ${taskId} 网络/服务暂时不可用（${truncate(reason, 80)}）。${waitMs}ms 后第 ${attempt + 1} 次尝试…`,
    phaseRetryLog: (reason: string, waitMs: number, attempt: number) =>
      `[retry] 网络/服务暂时不可用（${truncate(reason, 80)}）。${waitMs}ms 后第 ${attempt + 1} 次尝试…`,
    startGen: (phase: string) => `开始生成 ${phase}`,
    startExec: '开始按 tasks 顺序执行',

    // ── Retro (逆向分析) ──
    retroIntro: (projectPath: string, scopePath?: string) => [
      `项目根目录: ${projectPath}`,
      scopePath ? `分析范围: ${scopePath}` : '分析范围: 整个项目',
      '',
      '【语言要求】请全部使用中文输出，包括标题、描述和代码注释。',
      '请仔细阅读上述范围内的所有源代码文件，理解其行为和接口。',
      '这是一次逆向分析——文档化现有代码的实际行为，而非定义新需求。',
      '【重要】你处于只读模式，不能写入文件。你只需将分析结果作为纯文本输出，系统会自动将内容保存到 .sage/specs/ 目录中对应的 .md 文件。严禁尝试写文件操作。',
      '【输出要求】直接输出 markdown 内容，不要加任何前后缀说明（如"等待批准"、"已写入文件"等）。系统收到你的文本后会自动保存，无需用户确认。',
      '',
    ].join('\n'),
    retroRequirements: `你正在对一个已有代码模块进行逆向 spec 分析。以纯文本形式输出 requirements 内容（markdown 格式）。

格式要求（严格遵守 markdown，不额外解释）：

# Requirements（逆向分析）

## Overview
<2-4 句话总结这个模块实际上在做什么、解决了什么问题>

## User Stories（从代码行为推断）
- **US-1** 作为 <角色>，系统提供了 <行为>，以便 <推断的价值>。
  - **AC-1.1** WHEN <从代码中观察到的触发条件> THE SYSTEM SHALL <代码实际表现出的行为>。
  - **AC-1.2** ...

## 当前实现边界
- <代码明确不处理的事项>
- <TODO/FIXME 暗示的不足>

## 潜在改进方向
- <基于代码分析发现的改进点>`,
    retroDesign: `已有逆向 requirements。请重新阅读代码，以纯文本形式输出 design 内容（markdown 格式）。

格式要求（严格遵守 markdown，无额外解释）：

# Design（逆向分析）

## Architecture
<当前代码的实际架构；用 ASCII 图描述模块关系和数据流>

## Data Model
<当前代码中定义的类型、接口、数据结构>

## Public Interfaces
<当前代码对外暴露的函数、API 等签名>

## 实现策略（现状）
<当前代码的组织方式：模块划分、文件职责、调用链>

## 已知风险与技术债
- <风险、hack、TODO>

## 测试覆盖
- <当前测试情况>
- <明显缺少测试的路径>`,
    retroTasks: `已有逆向 requirements 和 design。以纯文本形式输出改进任务列表（markdown 格式）。
代码已存在，任务聚焦于改进、重构、补全，而非从零实现。

要求：
- 每个任务聚焦一个具体改进点（重构、补测试、修隐患、提升性能等）
- 严格按 YAML-in-markdown 格式输出
- task id 从 T1 起递增
- 纯代码质量改进写 \`requirements: []\`

# Tasks（改进计划）

\`\`\`yaml
- id: T1
  title: <祈使句>
  files:
    - <相对路径>
  requirements: []
  verification: |
    <如何验证改进有效>
  description: |
    <现状问题、改进目标、具体做什么>
\`\`\``,

    // ── Optimize (优化审查) ──
    optimizeIntro: (projectPath: string, specCount: number) => [
      `项目根目录: ${projectPath}`,
      `当前共有 ${specCount} 个 spec 需要优化审查。`,
      '',
    ].join('\n'),
    optimizeReport: `你正在对一个项目的所有 spec 进行合并/优化审查。
请阅读所有现有 spec 的 requirements.md、design.md、tasks.md，找出不一致、重复、遗漏或冲突之处，然后产出优化报告。

格式要求（严格遵守 markdown，无额外解释）：

# Spec 优化报告

## 总览
<一段话总结整体健康状况>

## 重复/重叠
- <跨 spec 的重复需求，建议合并到哪个 spec>

## 冲突/不一致
- <相互矛盾的 spec，建议如何统一>

## 遗漏/盲区
- <没有 spec 覆盖但明显重要的领域>

## 优化建议
- <具体可执行的优化动作，每条指向受影响的 spec>

## 建议的下一步
- <优先级排序的 action items>`,

        // ── Wiki (项目文档) — 单 pass 深度控制 ──
    wikiIntro: (projectPath: string, fileTree: string) => [
      `项目根目录: ${projectPath}`,
      '',
      '项目文件结构:',
      fileTree,
      '',
    ].join('\n'),

    wikiRules: `【绝对规则】
- 只输出 markdown 内容本身，不加任何前缀解释、前后缀对话、或后续步骤建议
- 不要问用户任何问题，不要提供选项让用户选择
- 不要说"以上是…"、"接下来…"、"请选择…"等任何元评论
- 所有内容必须基于实际代码分析，不要编造
- 不要尝试写入任何文件
- 本章节内容必须完整输出，不要省略或截断`,

    wikiQuick: `你是一个技术文档工程师。请为项目生成一份简洁的 Wiki 文档（快速浏览级别）。

【绝对规则】
- 只输出 markdown 内容本身，不加任何前缀解释、前后缀对话、或后续步骤建议
- 不要问用户任何问题，不要提供选项让用户选择
- 不要说"以上是…"、"接下来…"、"请选择…"等任何元评论
- 直接以 ## 标题开始输出
- 所有内容必须基于实际代码分析，不要编造
- 不要尝试写入任何文件
- 必须输出所有列出的章节，不要省略或截断任何一个章节
- 如果内容较长，宁可每个章节精简也要保证所有章节都出现

【输出以下全部内容】

## 项目概述
<2-3 段话详细描述项目是什么、解决什么问题、面向谁、核心亮点>

## 技术栈
| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| <至少 4-5 行真实依赖> |

## 架构总览
\`\`\`mermaid
graph TB
    subgraph 核心架构
        A[入口] --> B[核心模块]
        B --> C[输出层]
    end
\`\`\`
<一段话解释架构图>

## 项目结构
<用缩进树形展示关键目录和文件，每个附一句话说明。至少 10 个真实路径>
`,

    wikiFine: `你是一个技术文档工程师。请为项目生成一份完整的项目 Wiki 文档（精细级别）。

【绝对规则】
- 只输出 markdown 内容本身，不加任何前缀解释、前后缀对话、或后续步骤建议
- 不要问用户任何问题，不要提供选项让用户选择
- 不要说"以上是…"、"接下来…"、"请选择…"等任何元评论
- 直接以 ## 标题开始输出
- 所有内容必须基于实际代码分析，不要编造
- 不要尝试写入任何文件
- 必须输出所有列出的章节，不要省略或截断任何一个章节
- 如果内容较长，宁可每个章节精简也要保证所有章节都出现

【输出以下全部内容，每个部分都要写完整，不要省略】

## 项目概述
<2-3 段话详细描述项目是什么、解决什么问题、面向谁、核心亮点>

## 技术栈
| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| <至少 5 行真实依赖> |

## 架构总览
\`\`\`mermaid
graph TB
    subgraph 核心架构
        A[入口] --> B[核心模块]
        B --> C[输出层]
    end
\`\`\`
<一段话解释架构图>

## 项目结构
<用缩进树形展示关键目录和文件，每个附一句话说明。至少 10 个真实路径>

## 架构详情

### 模块关系
\`\`\`mermaid
graph LR
    subgraph 前端
        UI[UI组件] --> Store[状态管理]
    end
    subgraph 主进程
        Bridge[桥接层] --> Engine[引擎层]
    end
    UI -->|IPC| Bridge
\`\`\`
<2-3 段话详细解释模块间的依赖和调用关系，使用真实模块名>

### 数据流
<为 2-3 条核心数据流各写一个 mermaid sequence diagram，每条用 2-3 句话说明>

### 依赖分析
<列出主要模块间的 import/依赖关系（至少 5 组），分析循环依赖等问题>

## 核心模块

### <真实模块名 1>
**职责：** <一句话>
**关键文件：** \`<真实路径>\` — <说明>
**核心接口：**
\`\`\`typescript
// 从代码中提取的真实接口
export interface RealInterface { ... }
\`\`\`
**实现要点：** <关键设计决策>
**与其他模块的关系：** <依赖描述>

### <真实模块名 2>
<同上格式>

<重复 3-5 个模块>
`,

    wikiUltra: `你是一个技术文档工程师。请为项目生成一份详尽的项目 Wiki 文档（魔鬼精细级别）。

【绝对规则】
- 只输出 markdown 内容本身，不加任何前缀解释、前后缀对话、或后续步骤建议
- 不要问用户任何问题，不要提供选项让用户选择
- 不要说"以上是…"、"接下来…"、"请选择…"等任何元评论
- 直接以 ## 标题开始输出
- 所有内容必须基于实际代码分析，不要编造
- 不要尝试写入任何文件
- 每个部分都要尽可能详细，不要省略
- 必须输出所有列出的章节，不要省略或截断任何一个章节
- 如果内容较长，宁可每个章节精简也要保证所有章节都出现

【输出以下全部内容】

## 项目概述
<3-4 段话详细描述项目是什么、解决什么问题、面向谁、核心亮点、发展历程>

## 技术栈
| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| <至少 6 行真实依赖，覆盖前后端、构建、数据库、测试等> |

## 架构总览
\`\`\`mermaid
graph TB
    subgraph 核心架构
        A[入口] --> B[核心模块]
        B --> C[输出层]
    end
\`\`\`
<详细解释架构图，说明各组件职责>

## 项目结构
<用缩进树形展示完整目录结构，每个目录和关键文件附说明>

## 架构详情

### 模块关系
\`\`\`mermaid
graph LR
    subgraph 前端
        UI[UI组件] --> Store[状态管理]
    end
    subgraph 主进程
        Bridge[桥接层] --> Engine[引擎层]
    end
    UI -->|IPC| Bridge
\`\`\`
<3-4 段话详细解释，使用真实模块名和文件路径>

### 数据流
<为 3-4 条核心数据流各写 mermaid sequence diagram，每条详细说明触发条件和流转过程>

### 依赖分析
<列出所有主要模块间的依赖关系，深入分析循环依赖、过度耦合等问题，给出改进建议>

## 核心模块

### <真实模块名 1>
**职责：** <详细描述>
**关键文件：**
- \`<真实路径>\` — <说明>
- \`<真实路径>\` — <说明>
**核心接口：**
\`\`\`typescript
// 从代码中提取的完整接口定义
export interface RealInterface {
  key: string;
  method(): void;
}
\`\`\`
**实现要点：**
- <关键设计决策和取舍>
- <算法或数据结构选择>
**与其他模块的关系：** <详细依赖描述>

### <真实模块名 2>
<同上格式>

<重复 5-8 个核心模块，每个都要详细>

## 开发指南

### 环境搭建
<基于实际配置写出真实的安装和启动命令、环境变量要求、版本要求>
\`\`\`bash
# 安装依赖
<真实命令>
# 启动开发服务器
<真实命令>
\`\`\`

### 构建与部署
<基于实际构建配置写出真实命令、产物位置、部署方式>

### 测试
<测试框架、运行命令、测试目录结构、覆盖率工具，基于实际配置>

### 代码规范
<基于 ESLint/Prettier/Husky/commitlint 实际配置>

### 常见问题
<基于项目结构分析出 5-8 个真实问题及解决方案>
`,

    // ── Wiki Multi-Pass Section Prompts (zh) ─
    wikiSections: {
      quick: [
        { id: 'overview', h: '## 项目概述', tpl: `<2-3 段话详细描述项目是什么、解决什么问题、面向谁、核心亮点>` },
        { id: 'stack', h: '## 技术栈', tpl: `| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| <至少 4-5 行真实依赖，从 package.json 等配置文件提取> |` },
        { id: 'arch', h: '## 架构总览', tpl: `\`\`\`mermaid
graph TB
    subgraph 核心架构
        A[入口] --> B[核心模块]
        B --> C[输出层]
    end
\`\`\`
<一段话解释架构图，基于实际代码>` },
        { id: 'structure', h: '## 项目结构', tpl: `<用缩进树形展示关键目录和文件，每个附一句话说明。至少 10 个真实路径>` },
      ],
      fine: [
        { id: 'overview', h: '## 项目概述', tpl: `<2-3 段话详细描述项目是什么、解决什么问题、面向谁、核心亮点>` },
        { id: 'stack', h: '## 技术栈', tpl: `| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| <至少 5 行真实依赖> |` },
        { id: 'arch', h: '## 架构总览', tpl: `\`\`\`mermaid
graph TB
    subgraph 核心架构
        A[入口] --> B[核心模块]
        B --> C[输出层]
    end
\`\`\`
<一段话解释架构图>` },
        { id: 'structure', h: '## 项目结构', tpl: `<用缩进树形展示关键目录和文件，每个附一句话说明。至少 10 个真实路径>` },
        { id: 'archDetail', h: '## 架构详情', tpl: `### 模块关系
\`\`\`mermaid
graph LR
    subgraph 前端
        UI[UI组件] --> Store[状态管理]
    end
    subgraph 主进程
        Bridge[桥接层] --> Engine[引擎层]
    end
    UI -->|IPC| Bridge
\`\`\`
<2-3 段话详细解释模块间的依赖和调用关系，使用真实模块名>

### 数据流
<为 2-3 条核心数据流各写一个 mermaid sequence diagram，每条用 2-3 句话说明>

### 依赖分析
<列出主要模块间的 import/依赖关系（至少 5 组），分析循环依赖等问题>` },
        { id: 'modules', h: '## 核心模块', tpl: `### <真实模块名 1>
**职责：** <一句话>
**关键文件：** \`<真实路径>\` — <说明>
**核心接口：**
\`\`\`typescript
// 从代码中提取的真实接口
export interface RealInterface { ... }
\`\`\`
**实现要点：** <关键设计决策>
**与其他模块的关系：** <依赖描述>

### <真实模块名 2>
<同上格式>

<重复 3-5 个模块>` },
      ],
      ultra: [
        { id: 'overview', h: '## 项目概述', tpl: `<3-4 段话详细描述项目是什么、解决什么问题、面向谁、核心亮点、发展历程>` },
        { id: 'stack', h: '## 技术栈', tpl: `| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| <至少 6 行真实依赖，覆盖前后端、构建、数据库、测试等> |` },
        { id: 'arch', h: '## 架构总览', tpl: `\`\`\`mermaid
graph TB
    subgraph 核心架构
        A[入口] --> B[核心模块]
        B --> C[输出层]
    end
\`\`\`
<详细解释架构图，说明各组件职责>` },
        { id: 'structure', h: '## 项目结构', tpl: `<用缩进树形展示完整目录结构，每个目录和关键文件附说明>` },
        { id: 'archDetail', h: '## 架构详情', tpl: `### 模块关系
\`\`\`mermaid
graph LR
    subgraph 前端
        UI[UI组件] --> Store[状态管理]
    end
    subgraph 主进程
        Bridge[桥接层] --> Engine[引擎层]
    end
    UI -->|IPC| Bridge
\`\`\`
<3-4 段话详细解释，使用真实模块名和文件路径>

### 数据流
<为 3-4 条核心数据流各写 mermaid sequence diagram，每条详细说明触发条件和流转过程>

### 依赖分析
<列出所有主要模块间的依赖关系，深入分析循环依赖、过度耦合等问题，给出改进建议>` },
        { id: 'modules', h: '## 核心模块', tpl: `### <真实模块名 1>
**职责：** <详细描述>
**关键文件：**
- \`<真实路径>\` — <说明>
- \`<真实路径>\` — <说明>
**核心接口：**
\`\`\`typescript
// 从代码中提取的完整接口定义
export interface RealInterface {
  key: string;
  method(): void;
}
\`\`\`
**实现要点：**
- <关键设计决策和取舍>
- <算法或数据结构选择>
**与其他模块的关系：** <详细依赖描述>

### <真实模块名 2>
<同上格式>

<重复 5-8 个核心模块，每个都要详细>` },
        { id: 'devGuide', h: '## 开发指南', tpl: `### 环境搭建
<基于实际配置写出真实的安装和启动命令、环境变量要求、版本要求>
\`\`\`bash
# 安装依赖
<真实命令>
# 启动开发服务器
<真实命令>
\`\`\`

### 构建与部署
<基于实际构建配置写出真实命令、产物位置、部署方式>

### 测试
<测试框架、运行命令、测试目录结构、覆盖率工具，基于实际配置>

### 代码规范
<基于 ESLint/Prettier/Husky/commitlint 实际配置>

### 常见问题
<基于项目结构分析出 5-8 个真实问题及解决方案>` },
      ],
    } as const,
  },

  en: {
    requirements: `You are using Spec mode to plan a new feature/task. Read the project to understand the context, then produce the contents of \`requirements.md\`.

Format requirements (strictly follow, no extra explanation outside markdown):

# Requirements

## Overview
<2-4 sentences summarizing what to do and why>

## User Stories
- **US-1** As a <role>, I want <behavior>, so that <value>.
  - **AC-1.1** WHEN <condition> THE SYSTEM SHALL <observable behavior>.
  - **AC-1.2** ...
- **US-2** ...

## Out of Scope
- <Items explicitly not in scope for this iteration>

## Open Questions
- <Ambiguous points requiring user clarification; write "None" if empty.>
`,
    design: `Requirements are already available. Read the project code (focus on directories relevant to this requirement), then produce \`design.md\`.

Format requirements (strictly follow markdown, no extra explanation):

# Design

## Architecture
<Which modules/processes/layers are involved; describe data flow with ASCII diagrams or bullet points>

## Data Model
<New or modified types, table structures, or schemas>

## Public Interfaces
<New or modified function signatures, APIs, IPC channels, CLI commands, etc.>

## Implementation Strategy
<Step-by-step plan for implementing in code; specify which files to modify>

## Risks & Tradeoffs
- <Potential risks and mitigations>

## Test Plan
- <How to verify: unit tests, integration tests, manual verification steps>
`,
    tasks: `Requirements and design are available. Break the work into independently executable tasks in \`tasks.md\`.

Requirements:
- Each task should be small enough to complete in a single Claude invocation (~200 lines of code changes max)
- Prefer vertical slicing by feature module, not horizontal slicing by layer (e.g., one task covers model + API + UI together, rather than three separate tasks)
- Strictly follow the YAML-in-markdown format below, no extra explanation
- Task IDs start from T1, incrementing
- Each task must include a \`requirements\` field listing the User Story / Acceptance Criteria IDs it implements; pure refactoring tasks use \`requirements: []\`
- Each task must include a \`verification\` field with steps to verify the task is correctly completed

# Tasks

\`\`\`yaml
- id: T1
  title: <imperative sentence>
  files:
    - <relative/path1>
    - <relative/path2>
  requirements: [US-1.AC-1.2]
  verification: |
    <How to verify this task is correctly completed, e.g.: run xxx test, check UI rendering>
  description: |
    <Clearly describe what to do, which part of the design it's based on; list acceptance points>
- id: T2
  title: ...
  files: [...]
  requirements: [US-2.AC-2.1, US-2.AC-2.2]
  verification: |
    ...
  description: |
    ...
\`\`\`
`,
    intro: (meta: SpecMeta) => [
      `Project root: ${meta.projectPath}`,
      `Spec title: ${meta.title}`,
      '',
      'User description:',
      meta.description,
      '',
    ].join('\n'),
    existingReq: (doc: string) => `\nExisting requirements.md:\n\n${doc || '(empty)'}\n`,
    existingDesign: (doc: string) => `\nExisting design.md:\n\n${doc || '(empty)'}\n`,
    feedback: (fb: string) => `\nUser feedback on the previous version (please revise accordingly):\n${fb}\n`,
    execTask: (task: TaskItem) => [
      `You are executing a task from an approved spec. Complete ONLY this single task and commit changes.`,
      '',
      `## Current task: ${task.id} — ${task.title}`,
      task.description,
    ].join('\n'),
    execConstraints: [
      `Execution constraints:`,
      `- Only work on this single task, do not expand into other tasks`,
      `- Summarize what you did in one sentence when done`,
      `- If you find the design conflicts with the actual code, stop and explain — do not force changes`,
    ].join('\n'),
    reqsHint: (reqs: string[]) => `\nImplements requirements: ${reqs.join(', ')}\n`,
    filesHint: (files: string[]) => `\nRelevant files:\n${files.map((f) => `- ${f}`).join('\n')}\n`,
    retryLog: (taskId: string, reason: string, waitMs: number, attempt: number) =>
      `[retry] Task ${taskId} service unavailable (${truncate(reason, 80)}). Retrying in ${waitMs}ms (attempt ${attempt + 1})…`,
    phaseRetryLog: (reason: string, waitMs: number, attempt: number) =>
      `[retry] Service unavailable (${truncate(reason, 80)}). Retrying in ${waitMs}ms (attempt ${attempt + 1})…`,
    startGen: (phase: string) => `Starting ${phase} generation`,
    startExec: 'Starting sequential task execution',

    // ─ Retro (reverse analysis) ──
    retroIntro: (projectPath: string, scopePath?: string) => [
      `Project root: ${projectPath}`,
      scopePath ? `Analysis scope: ${scopePath}` : 'Analysis scope: entire project',
      '',
      '[LANGUAGE REQUIREMENT] Respond entirely in English, including headings, descriptions, and code comments.',
      'Please carefully read all source files in the above scope and understand their behavior and interfaces.',
      'This is a reverse analysis — documenting what the code actually does, not defining new requirements.',
      '[IMPORTANT] You are in read-only mode and cannot write files. Simply output your analysis as plain text — the system will automatically save it to the corresponding .md files under .sage/specs/. Do NOT attempt any file write operations.',
      '[OUTPUT REQUIREMENT] Output ONLY the markdown content. Do NOT add any preface or suffix text (such as "waiting for approval", "file written", etc.). The system will auto-save your text without user confirmation.',
      '',
    ].join('\n'),
    retroRequirements: `You are performing a reverse spec analysis of existing code. Output requirements content as plain text (markdown format).

Format (strictly follow markdown, no extra explanation):

# Requirements (Reverse Analysis)

## Overview
<2-4 sentences summarizing what this module actually does and what problem it solves>

## User Stories (Inferred from code behavior)
- **US-1** As a <role>, the system provides <behavior> so that <inferred value>.
  - **AC-1.1** WHEN <observed trigger in code> THE SYSTEM SHALL <observed behavior>.
  - **AC-1.2** ...

## Current Implementation Boundaries
- <Things the code explicitly does not handle>
- <Shortcomings implied by TODOs/FIXMEs>

## Potential Improvements
- <Improvement points discovered from code analysis>`,
    retroDesign: `Requirements are available. Re-read the code and output design content as plain text (markdown format).

Format (strictly follow markdown, no extra explanation):

# Design (Reverse Analysis)

## Architecture
<Current architecture; use ASCII diagrams for module relationships and data flow>

## Data Model
<Types, interfaces, data structures defined in the code>

## Public Interfaces
<Functions, APIs, etc. exposed by the code>

## Implementation Strategy (Current)
<How the code is organized: modules, file responsibilities, call chains>

## Known Risks & Tech Debt
- <Risks, hacks, TODOs>

## Test Coverage
- <Current test situation>
- <Paths obviously missing tests>`,
    retroTasks: `Requirements and design are available. Output an improvement task list as plain text (markdown format).
The code already exists; tasks focus on improvements, refactoring, and completions — not building from scratch.

Requirements:
- Each task focuses on a specific improvement (refactor, add tests, fix risks, improve performance, etc.)
- Strictly follow YAML-in-markdown format
- Task IDs start from T1
- Pure code quality improvements use \`requirements: []\`

# Tasks (Improvement Plan)

\`\`\`yaml
- id: T1
  title: <imperative sentence>
  files:
    - <relative/path>
  requirements: []
  verification: |
    <How to verify the improvement is effective>
  description: |
    <Current problem, improvement goal, what to do>
\`\`\``,

    // ── Optimize ──
    optimizeIntro: (projectPath: string, specCount: number) => [
      `Project root: ${projectPath}`,
      `There are ${specCount} specs to review and optimize.`,
      '',
    ].join('\n'),
    optimizeReport: `You are reviewing and optimizing all specs for a project.
Read all existing specs' requirements.md, design.md, and tasks.md. Find inconsistencies, duplications, gaps, or conflicts, then produce an optimization report.

Format (strictly follow markdown, no extra explanation):

# Spec Optimization Report

## Overview
<One paragraph summarizing overall health>

## Duplications / Overlaps
- <Cross-spec duplicate requirements; suggest which spec to merge into>

## Conflicts / Inconsistencies
- <Contradictory specs; suggest how to unify>

## Gaps / Blind Spots
- <Important areas not covered by any spec>

## Optimization Suggestions
- <Specific actionable optimizations, each pointing to affected specs>

## Recommended Next Steps
- <Priority-ordered action items>`,

        // ── Wiki (Project Documentation) 
    wikiIntro: (projectPath: string, fileTree: string) => [
      `Project root: ${projectPath}`,
      '',
      'Project file structure:',
      fileTree,
      '',
    ].join('\n'),

    wikiRules: `[STRICT RULES]
- Output ONLY markdown content. No preamble, no meta-commentary, no follow-up questions.
- Never say "Here is", "The above covers", "Please choose next steps".
- All content must be based on actual code analysis, never fabricate.
- Do NOT attempt to write any files.
- This section must be complete, never omit or truncate content.`,

    wikiQuick: `You are a technical documentation engineer. Generate a concise project Wiki (quick overview level).

[STRICT RULES]
- Output ONLY markdown content. No preamble, no meta-commentary, no follow-up questions.
- Never say "Here is", "The above covers", "Please choose next steps".
- Start output directly with ## Project Overview.
- All content must be based on actual code analysis, never fabricate.
- Do NOT attempt to write any files.
- You MUST output ALL listed sections completely. Never omit or truncate any section.
- If content is long, prefer concise sections over missing ones — every section must appear.

[OUTPUT]

## Project Overview
<2-3 paragraphs: what the project is, what problem it solves, who it's for, key highlights>

## Tech Stack
| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| <At least 4-5 rows with real dependencies> |

## Architecture Overview
\`\`\`mermaid
graph TB
    subgraph Core Architecture
        A[Entry] --> B[Core Module]
        B --> C[Output Layer]
    end
\`\`\`
<One paragraph explaining the architecture diagram>

## Project Structure
<Tree structure showing key directories and files with one-line descriptions. At least 10 real paths>
`,

    wikiFine: `You are a technical documentation engineer. Generate a comprehensive project Wiki (detailed level).

[STRICT RULES]
- Output ONLY markdown content. No preamble, no meta-commentary, no follow-up questions.
- Never say "Here is", "The above covers", "Please choose next steps".
- Start output directly with ## Project Overview.
- All content must be based on actual code analysis, never fabricate.
- Do NOT attempt to write any files.
- Every section must be complete, do not skip or abbreviate.
- You MUST output ALL listed sections completely. Never omit or truncate any section.
- If content is long, prefer concise sections over missing ones — every section must appear.

[OUTPUT — include ALL sections below]

## Project Overview
<2-3 paragraphs: what the project is, what problem it solves, who it's for, key highlights>

## Tech Stack
| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| <At least 5 rows with real dependencies> |

## Architecture Overview
\`\`\`mermaid
graph TB
    subgraph Core Architecture
        A[Entry] --> B[Core Module]
        B --> C[Output Layer]
    end
\`\`\`
<One paragraph explaining the architecture diagram>

## Project Structure
<Tree structure showing key directories and files. At least 10 real paths>

## Architecture Details

### Module Relationships
\`\`\`mermaid
graph LR
    subgraph Frontend
        UI[UI Components] --> Store[State Management]
    end
    subgraph Main Process
        Bridge[Bridge Layer] --> Engine[Engine Layer]
    end
    UI -->|IPC| Bridge
\`\`\`
<2-3 paragraphs explaining module dependencies with real module names>

### Data Flow
<2-3 mermaid sequence diagrams for core data flow paths, each with 2-3 sentences>

### Dependency Analysis
<List main import/dependency relationships (at least 5 groups). Analyze circular dependencies.>

## Core Modules

### <Real Module Name 1>
**Responsibility:** <One sentence>
**Key Files:** \`<real path>\` — <description>
**Core Interfaces:**
\`\`\`typescript
// Real interface from code
export interface RealInterface { ... }
\`\`\`
**Implementation Notes:** <Key design decisions>
**Relationships:** <Dependencies description>

### <Real Module Name 2>
<Same format>

<Repeat for 3-5 modules>
`,

    wikiUltra: `You are a technical documentation engineer. Generate an exhaustive project Wiki (ultra-detailed level).

[STRICT RULES]
- Output ONLY markdown content. No preamble, no meta-commentary, no follow-up questions.
- Never say "Here is", "The above covers", "Please choose next steps".
- Start output directly with ## Project Overview.
- All content must be based on actual code analysis, never fabricate.
- Do NOT attempt to write any files.
- Every section must be as detailed as possible, never skip or abbreviate.
- You MUST output ALL listed sections completely. Never omit or truncate any section.
- If content is long, prefer concise sections over missing ones — every section must appear.

[OUTPUT — include ALL sections below]

## Project Overview
<3-4 paragraphs: what the project is, problem it solves, target audience, key highlights, evolution>

## Tech Stack
| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| <At least 6 rows covering frontend, backend, build, database, testing, etc.> |

## Architecture Overview
\`\`\`mermaid
graph TB
    subgraph Core Architecture
        A[Entry] --> B[Core Module]
        B --> C[Output Layer]
    end
\`\`\`
<Detailed explanation of architecture diagram and component responsibilities>

## Project Structure
<Full tree structure with descriptions for every directory and key file>

## Architecture Details

### Module Relationships
\`\`\`mermaid
graph LR
    subgraph Frontend
        UI[UI Components] --> Store[State Management]
    end
    subgraph Main Process
        Bridge[Bridge Layer] --> Engine[Engine Layer]
    end
    UI -->|IPC| Bridge
\`\`\`
<3-4 paragraphs detailed explanation with real module names and file paths>

### Data Flow
<3-4 mermaid sequence diagrams for core data flow paths, each with detailed trigger conditions>

### Dependency Analysis
<All major inter-module dependencies. Deep analysis of circular dependencies, coupling issues, with improvement suggestions>

## Core Modules

### <Real Module Name 1>
**Responsibility:** <Detailed description>
**Key Files:**
- \`<real path>\` — <description>
- \`<real path>\` — <description>
**Core Interfaces:**
\`\`\`typescript
// Complete interface definition from code
export interface RealInterface {
  key: string;
  method(): void;
}
\`\`\`
**Implementation Notes:**
- <Key design decisions and tradeoffs>
- <Algorithm or data structure choices>
**Relationships:** <Detailed dependency description>

### <Real Module Name 2>
<Same format>

<Repeat for 5-8 core modules, each detailed>

## Development Guide

### Environment Setup
<Real installation and startup commands based on actual config, env vars, version requirements>
\`\`\`bash
# Install dependencies
<real command>
# Start dev server
<real command>
\`\`\`

### Build & Deployment
<Real build commands, output locations, deployment methods based on actual config>

### Testing
<Test framework, run commands, test directory structure, coverage tools based on actual config>

### Code Standards
<Real code standards based on ESLint/Prettier/Husky/commitlint configuration>

### FAQ
<5-8 real questions developers might encounter based on project structure analysis, with solutions>
`,

    // ── Wiki Multi-Pass Section Prompts (en) ─
    wikiSections: {
      quick: [
        { id: 'overview', h: '## Project Overview', tpl: `<2-3 paragraphs: what the project is, what problem it solves, who it's for, key highlights>` },
        { id: 'stack', h: '## Tech Stack', tpl: `| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| <At least 4-5 rows with real dependencies from package.json etc> |` },
        { id: 'arch', h: '## Architecture Overview', tpl: `\`\`\`mermaid
graph TB
    subgraph Core Architecture
        A[Entry] --> B[Core Module]
        B --> C[Output Layer]
    end
\`\`\`
<One paragraph explaining the architecture diagram based on actual code>` },
        { id: 'structure', h: '## Project Structure', tpl: `<Tree structure showing key directories and files with one-line descriptions. At least 10 real paths>` },
      ],
      fine: [
        { id: 'overview', h: '## Project Overview', tpl: `<2-3 paragraphs: what the project is, what problem it solves, who it's for, key highlights>` },
        { id: 'stack', h: '## Tech Stack', tpl: `| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| <At least 5 rows with real dependencies> |` },
        { id: 'arch', h: '## Architecture Overview', tpl: `\`\`\`mermaid
graph TB
    subgraph Core Architecture
        A[Entry] --> B[Core Module]
        B --> C[Output Layer]
    end
\`\`\`
<One paragraph explaining the architecture diagram>` },
        { id: 'structure', h: '## Project Structure', tpl: `<Tree structure showing key directories and files. At least 10 real paths>` },
        { id: 'archDetail', h: '## Architecture Details', tpl: `### Module Relationships
\`\`\`mermaid
graph LR
    subgraph Frontend
        UI[UI Components] --> Store[State Management]
    end
    subgraph Main Process
        Bridge[Bridge Layer] --> Engine[Engine Layer]
    end
    UI -->|IPC| Bridge
\`\`\`
<2-3 paragraphs explaining module dependencies with real module names>

### Data Flow
<2-3 mermaid sequence diagrams for core data flow paths, each with 2-3 sentences>

### Dependency Analysis
<List main import/dependency relationships (at least 5 groups). Analyze circular dependencies.>` },
        { id: 'modules', h: '## Core Modules', tpl: `### <Real Module Name 1>
**Responsibility:** <One sentence>
**Key Files:** \`<real path>\` — <description>
**Core Interfaces:**
\`\`\`typescript
// Real interface from code
export interface RealInterface { ... }
\`\`\`
**Implementation Notes:** <Key design decisions>
**Relationships:** <Dependencies description>

### <Real Module Name 2>
<Same format>

<Repeat for 3-5 modules>` },
      ],
      ultra: [
        { id: 'overview', h: '## Project Overview', tpl: `<3-4 paragraphs: what the project is, problem it solves, target audience, key highlights, evolution>` },
        { id: 'stack', h: '## Tech Stack', tpl: `| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| <At least 6 rows covering frontend, backend, build, database, testing> |` },
        { id: 'arch', h: '## Architecture Overview', tpl: `\`\`\`mermaid
graph TB
    subgraph Core Architecture
        A[Entry] --> B[Core Module]
        B --> C[Output Layer]
    end
\`\`\`
<Detailed explanation of the architecture diagram, describing each component's role>` },
        { id: 'structure', h: '## Project Structure', tpl: `<Full directory tree with descriptions for each directory and key file>` },
        { id: 'archDetail', h: '## Architecture Details', tpl: `### Module Relationships
\`\`\`mermaid
graph LR
    subgraph Frontend
        UI[UI Components] --> Store[State Management]
    end
    subgraph Main Process
        Bridge[Bridge Layer] --> Engine[Engine Layer]
    end
    UI -->|IPC| Bridge
\`\`\`
<3-4 paragraphs with real module names and file paths>

### Data Flow
<3-4 mermaid sequence diagrams for core data flow paths, each with detailed trigger conditions and flow description>

### Dependency Analysis
<List all major module dependencies, analyze circular dependencies, over-coupling issues, with improvement suggestions>` },
        { id: 'modules', h: '## Core Modules', tpl: `### <Real Module Name 1>
**Responsibility:** <Detailed description>
**Key Files:**
- \`<real path>\` — <description>
- \`<real path>\` — <description>
**Core Interfaces:**
\`\`\`typescript
// Full interface definition from code
export interface RealInterface {
  key: string;
  method(): void;
}
\`\`\`
**Implementation Notes:**
- <Key design decisions and trade-offs>
- <Algorithm or data structure choices>
**Relationships:** <Detailed dependency description>

### <Real Module Name 2>
<Same format>

<Repeat for 5-8 core modules, each detailed>` },
        { id: 'devGuide', h: '## Development Guide', tpl: `### Environment Setup
<Real installation and startup commands, environment variable requirements, version requirements based on actual config>
\`\`\`bash
# Install dependencies
<real command>
# Start dev server
<real command>
\`\`\`

### Build & Deployment
<Real build commands, output locations, deployment methods based on actual config>

### Testing
<Test framework, run commands, test directory structure, coverage tools based on actual config>

### Code Standards
<Real code standards based on ESLint/Prettier/Husky/commitlint configuration>

### FAQ
<5-8 real questions developers might encounter based on project structure analysis, with solutions>` },
      ],
    } as const,
  },
} as const;

function getPrompts(lang?: string) {
  return PROMPTS[lang === 'en' ? 'en' : 'zh'];
}

// ─── Phase Prompt Building ──────────────────────────────────────────────

interface PhaseRunOptions {
  meta: SpecMeta;
  feedback?: string;
  signal?: AbortSignal;
  lang?: string;
  onText?: (chunk: string) => void;
  onLog?: (line: string) => void;
}

async function buildPhasePrompt(
  meta: SpecMeta,
  phase: 'requirements' | 'design' | 'tasks',
  lang: string | undefined,
  reqDoc?: string,
  designDoc?: string,
  feedback?: string,
): Promise<string> {
  const steering = renderSteering(await readSteering(meta.projectPath));
  const p = getPrompts(lang);
  const intro = p.intro(meta);
  const fb = feedback?.trim() ? p.feedback(feedback.trim()) : '';

  if (phase === 'requirements') {
    return `${steering}${intro}${fb}\n${p.requirements}`;
  }
  if (phase === 'design') {
    return `${steering}${intro}${p.existingReq(reqDoc ?? '')}${fb}\n${p.design}`;
  }
  return `${steering}${intro}${p.existingReq(reqDoc ?? '')}${p.existingDesign(designDoc ?? '')}${fb}\n${p.tasks}`;
}

// ─── Generate Phase ─────────────────────────────────────────────────────

export async function generatePhase(
  phase: 'requirements' | 'design' | 'tasks',
  opts: PhaseRunOptions,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const { meta } = opts;
  meta.phases[phase].status = 'generating';
  meta.phases[phase].error = undefined;
  meta.updatedAt = new Date().toISOString();
  await saveSpecMeta(meta);

  const reqDoc = phase !== 'requirements' ? await readDoc(meta.projectPath, meta.id, 'requirements') : undefined;
  const designDoc = phase === 'tasks' ? await readDoc(meta.projectPath, meta.id, 'design') : undefined;
  const prompt = await buildPhasePrompt(meta, phase, opts.lang, reqDoc, designDoc, opts.feedback);
  const p = getPrompts(opts.lang);

  let resumeSessionId: string | undefined;
  const r = await withRetry(
    async (attempt) =>
      runPlanMode({
        cwd: meta.projectPath,
        ...(await planModelOpts(meta.projectPath)),
        prompt,
        permissionMode: 'plan',
        signal: opts.signal,
        onText: opts.onText,
        onLog: opts.onLog,
        onSessionId: (id) => {
          resumeSessionId = id;
        },
        resumeSessionId: attempt > 1 ? resumeSessionId : undefined,
        monitor: {
          source: 'spec',
          specId: meta.id,
          projectPath: meta.projectPath,
          label: `${meta.title} · ${phase}`,
        },
      }),
    {
      signal: opts.signal,
      onRetry: ({ attempt, waitMs, reason }) => {
        opts.onLog?.(p.phaseRetryLog(reason, waitMs, attempt));
      },
    },
  );

  if ((!r.text || r.text.length < 20) && r.error) {
    meta.phases[phase].status = 'failed';
    meta.phases[phase].error = r.error ?? 'empty response';
    await saveSpecMeta(meta);
    return { ok: false, error: r.error ?? 'empty response' };
  }

  const content = stripFences(r.text);
  await writeDoc(meta.projectPath, meta.id, phase, content);

  if (phase === 'tasks') {
    meta.tasks = parseTasks(content);
  }

  meta.phases[phase].status = 'review';
  meta.phases[phase].generatedAt = new Date().toISOString();
  meta.phases[phase].stale = false;
  markDownstreamStale(meta, phase);
  meta.currentPhase = phase;
  meta.updatedAt = new Date().toISOString();
  await saveSpecMeta(meta);
  return { ok: true, content };
}

const PHASE_ORDER: ('requirements' | 'design' | 'tasks')[] = ['requirements', 'design', 'tasks'];

/**
 * 上游阶段文档变更后，把其后续【已生成过】的阶段标记为 stale（过时）。
 * 仅标记 status 不为 'pending' 的阶段——从未生成的阶段无所谓过时。
 */
export function markDownstreamStale(meta: SpecMeta, changedPhase: 'requirements' | 'design' | 'tasks'): void {
  const idx = PHASE_ORDER.indexOf(changedPhase);
  if (idx < 0) return;
  for (let i = idx + 1; i < PHASE_ORDER.length; i++) {
    const p = PHASE_ORDER[i];
    if (meta.phases[p].status !== 'pending') meta.phases[p].stale = true;
  }
}

// ─── Refine Phase via Chat (multi-turn) ─────────────────────────────────

interface RefineChatOptions {
  meta: SpecMeta;
  phase: 'requirements' | 'design' | 'tasks';
  message: string;
  signal?: AbortSignal;
  lang?: string;
  onText?: (chunk: string) => void;
  onLog?: (line: string) => void;
}

/**
 * 以多轮对话方式细化某个阶段文档：读取当前文档 + 历史对话 + 用户新消息，
 * 让模型返回“简短回应 + 更新后的完整文档（```markdown 包裹）”，
 * 解析后落盘文档并把这一轮问答追加进对话线程。
 */
export async function refinePhaseChat(
  opts: RefineChatOptions,
): Promise<{ ok: boolean; content?: string; reply?: string; messages?: SpecChatMessage[]; error?: string }> {
  const { meta, phase } = opts;
  const en = opts.lang === 'en';

  const currentDoc = (await readDoc(meta.projectPath, meta.id, phase)) ?? '';
  const history = await readPhaseChat(meta.projectPath, meta.id, phase);
  const steering = renderSteering(await readSteering(meta.projectPath));

  const historyText = history
    .map((m) => `${m.role === 'user' ? (en ? 'User' : '用户') : (en ? 'Assistant' : '助手')}: ${m.content}`)
    .join('\n\n');

  const prompt = en
    ? `${steering}You are iteratively refining the \`${phase}.md\` document of a Spec through a conversation with the user (e.g. answering the "Open Questions" section, adjusting requirements/design/tasks).

## Current ${phase}.md
\`\`\`markdown
${currentDoc}
\`\`\`
${historyText ? `\n## Conversation so far\n${historyText}\n` : ''}
## User's new message
${opts.message}

Respond in TWO parts, strictly in this order:
1. A short natural-language reply to the user (what you changed and why), a few sentences max.
2. The FULL updated document wrapped in a single \`\`\`markdown fenced block. Keep the same document structure; incorporate the user's input; resolve answered Open Questions and remove them from the list.`
    : `${steering}你正在通过与用户对话，迭代式地完善某个 Spec 的 \`${phase}.md\` 文档（例如回答其中的 "Open Questions"、调整需求/设计/任务）。

## 当前 ${phase}.md
\`\`\`markdown
${currentDoc}
\`\`\`
${historyText ? `\n## 已有对话\n${historyText}\n` : ''}
## 用户的新消息
${opts.message}

请严格按以下顺序分两部分回复：
1. 用简短的自然语言回应用户（说明你改了什么、为什么），最多几句话。
2. 然后输出更新后的【完整文档】，用一个 \`\`\`markdown 代码块包裹。保持原文档结构；吸收用户输入；对已回答的 Open Questions 予以解决并从列表中移除。`;

  let resumeSessionId: string | undefined;
  const p = getPrompts(opts.lang);
  const r = await withRetry(
    async (attempt) =>
      runPlanMode({
        cwd: meta.projectPath,
        ...(await planModelOpts(meta.projectPath)),
        prompt,
        permissionMode: 'plan',
        signal: opts.signal,
        onText: opts.onText,
        onLog: opts.onLog,
        onSessionId: (id) => { resumeSessionId = id; },
        resumeSessionId: attempt > 1 ? resumeSessionId : undefined,
        monitor: {
          source: 'spec',
          specId: meta.id,
          projectPath: meta.projectPath,
          label: `${meta.title} · ${phase} · chat`,
        },
      }),
    {
      signal: opts.signal,
      onRetry: ({ attempt, waitMs, reason }) => {
        opts.onLog?.(p.phaseRetryLog(reason, waitMs, attempt));
      },
    },
  );

  if ((!r.text || r.text.length < 2) && r.error) {
    return { ok: false, error: r.error ?? 'empty response' };
  }

  const { reply, doc } = splitReplyAndDoc(r.text);
  const newContent = doc ? stripFences(doc) : currentDoc;

  // 仅当解析出文档时才落盘（避免把纯闲聊误写空文档）。
  if (doc) {
    await writeDoc(meta.projectPath, meta.id, phase, newContent);
    if (phase === 'tasks') meta.tasks = parseTasks(newContent);
    meta.phases[phase].status = 'review';
    meta.phases[phase].generatedAt = new Date().toISOString();
    meta.phases[phase].stale = false;
    markDownstreamStale(meta, phase);
    meta.currentPhase = phase;
    meta.updatedAt = new Date().toISOString();
    await saveSpecMeta(meta);
  }

  const now = Date.now();
  const messages: SpecChatMessage[] = [
    ...history,
    { role: 'user', content: opts.message, ts: now },
    { role: 'assistant', content: reply || (en ? 'Updated the document.' : '已更新文档。'), ts: now + 1 },
  ];
  await writePhaseChat(meta.projectPath, meta.id, phase, messages);

  return { ok: true, content: doc ? newContent : undefined, reply, messages };
}

/**
 * 从模型输出中切出“自然语言回应”与“```markdown 文档块”。
 * 文档块取第一个 markdown 围栏内容；回应取围栏之前的文本。
 */
function splitReplyAndDoc(text: string): { reply: string; doc?: string } {
  const trimmed = (text ?? '').trim();
  const fence = /```(?:markdown|md)?\n([\s\S]*?)\n```/.exec(trimmed);
  if (fence) {
    const reply = trimmed.slice(0, fence.index).trim();
    return { reply, doc: fence[1] };
  }
  return { reply: trimmed };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function stripFences(text: string): string {
  let trimmed = text.trim();
  // Safety net: strip trailing "Plan mode exited…" messages
  const planIdx = trimmed.search(/\nPlan mode exited\b/i);
  if (planIdx > 0) trimmed = trimmed.slice(0, planIdx).trimEnd();
  // Case 1: entire response wrapped in ```markdown ... ```
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(trimmed);
  if (m) return m[1].trim() + '\n';
  // Case 2: conversational preamble + fenced content (extract the fenced part)
  const fenceMatch = /```(?:markdown|md)?\n([\s\S]*?)\n```/.exec(trimmed);
  if (fenceMatch) return fenceMatch[1].trim() + '\n';
  // Case 3: conversational text mixed with ## headings — keep from first heading onwards
  const headingMatch = /^## .+$/m.exec(trimmed);
  if (headingMatch) return trimmed.slice(headingMatch.index).trim() + '\n';
  // Case 4: no fences, no headings — return as-is
  return trimmed + '\n';
}

/**
 * Extract key sections from design.md for task execution context.
 * Only includes Architecture + Implementation Strategy to save tokens.
 */
function extractDesignSummary(designDoc: string): string {
  const sections: string[] = [];
  const archMatch = /## Architecture\s*\n([\s\S]*?)(?=\n## |$)/i.exec(designDoc);
  if (archMatch) sections.push(`## Architecture\n${archMatch[1].trim()}`);
  const stratMatch = /## Implementation Strategy\s*\n([\s\S]*?)(?=\n## |$)/i.exec(designDoc);
  if (stratMatch) sections.push(`## Implementation Strategy\n${stratMatch[1].trim()}`);
  return sections.length > 0 ? sections.join('\n\n') : designDoc;
}

/**
 * Get context tasks: current task + one before + one after.
 */
function getTaskContext(tasks: TaskItem[], currentId: string): string {
  const idx = tasks.findIndex((t) => t.id === currentId);
  if (idx < 0) return '';
  const slice = tasks.slice(Math.max(0, idx - 1), idx + 2);
  return slice
    .map((t) => `- ${t.id}: ${t.title}${t.id === currentId ? ' ← current' : ` (${t.status})`}`)
    .join('\n');
}

// ─── Task Parsing ───────────────────────────────────────────────────────

export function parseTasks(tasksMd: string): TaskItem[] {
  const codeBlock = /```ya?ml\s*\n([\s\S]*?)\n```/i.exec(tasksMd);
  if (!codeBlock) return [];
  const body = codeBlock[1];

  const lines = body.split('\n');
  const tasks: TaskItem[] = [];
  let cur: Partial<TaskItem> & {
    __mode?: 'desc' | 'files' | 'reqs' | 'verify';
    __descIndent?: number;
    __verifyIndent?: number;
  } = {};
  let descLines: string[] = [];
  let verifyLines: string[] = [];

  const flush = () => {
    if (cur.id) {
      tasks.push({
        id: cur.id,
        title: cur.title ?? cur.id,
        description: descLines.join('\n').trimEnd(),
        files: cur.files ?? [],
        requirements: cur.requirements,
        status: 'pending',
      });
    }
    cur = {};
    descLines = [];
    verifyLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const itemMatch = /^(\s*)-\s+id:\s*(.+)$/.exec(line);
    if (itemMatch) {
      flush();
      cur.id = itemMatch[2].trim();
      continue;
    }
    if (cur.__mode === 'desc') {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() === '' || indent >= (cur.__descIndent ?? 0)) {
        descLines.push(line.replace(new RegExp(`^\\s{0,${cur.__descIndent ?? 0}}`), ''));
        continue;
      }
      cur.__mode = undefined;
    }
    if (cur.__mode === 'verify') {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() === '' || indent >= (cur.__verifyIndent ?? 0)) {
        verifyLines.push(line.replace(new RegExp(`^\\s{0,${cur.__verifyIndent ?? 0}}`), ''));
        continue;
      }
      cur.__mode = undefined;
    }
    const titleMatch = /^\s+title:\s*(.+)$/.exec(line);
    if (titleMatch) {
      cur.title = titleMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const filesInline = /^\s+files:\s*\[(.*)\]\s*$/.exec(line);
    if (filesInline) {
      cur.files = filesInline[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      continue;
    }
    if (/^\s+files:\s*$/.test(line)) {
      cur.files = [];
      cur.__mode = 'files';
      continue;
    }
    if (cur.__mode === 'files') {
      const m = /^\s+-\s+(.+)$/.exec(line);
      if (m) {
        cur.files!.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      cur.__mode = undefined;
    }
    const reqsInline = /^\s+requirements:\s*\[(.*)\]\s*$/.exec(line);
    if (reqsInline) {
      cur.requirements = reqsInline[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      continue;
    }
    if (/^\s+requirements:\s*$/.test(line)) {
      cur.requirements = [];
      cur.__mode = 'reqs';
      continue;
    }
    if (cur.__mode === 'reqs') {
      const m = /^\s+-\s+(.+)$/.exec(line);
      if (m) {
        cur.requirements!.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      cur.__mode = undefined;
    }
    // verification: field (new)
    const verifyStart = /^(\s+)verification:\s*\|\s*$/.exec(line);
    if (verifyStart) {
      cur.__mode = 'verify';
      cur.__verifyIndent = (verifyStart[1].length ?? 0) + 2;
      continue;
    }
    const verifyInline = /^\s+verification:\s*(.+)$/.exec(line);
    if (verifyInline) {
      verifyLines.push(verifyInline[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const descStart = /^(\s+)description:\s*\|\s*$/.exec(line);
    if (descStart) {
      cur.__mode = 'desc';
      cur.__descIndent = (descStart[1].length ?? 0) + 2;
      continue;
    }
    const descInline = /^\s+description:\s*(.+)$/.exec(line);
    if (descInline) {
      descLines.push(descInline[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
  }
  flush();
  return tasks;
}

// ─── Execute Spec ───────────────────────────────────────────────────────

interface ExecuteOptions {
  meta: SpecMeta;
  signal?: AbortSignal;
  lang?: string;
  onTaskStart: (task: TaskItem) => void;
  onTaskText: (task: TaskItem, chunk: string) => void;
  onTaskDone: (task: TaskItem) => void;
  onTaskFailed: (task: TaskItem, error: string) => void;
  onLog?: (line: string) => void;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
}

function buildTaskPrompt(
  task: TaskItem,
  meta: SpecMeta,
  steering: string,
  designSummary: string,
  lang?: string,
): string {
  const p = getPrompts(lang);
  const reqsHint = task.requirements?.length ? p.reqsHint(task.requirements) : '';
  const filesHint = task.files?.length ? p.filesHint(task.files) : '';
  const taskContext = getTaskContext(meta.tasks, task.id);

  return [
    steering,
    p.execTask(task),
    reqsHint,
    filesHint,
    '',
    `## Design Summary`,
    designSummary,
    '',
    `## Task Context`,
    taskContext,
    '',
    p.execConstraints,
  ].join('\n');
}

export async function executeSpec(opts: ExecuteOptions): Promise<{ ok: boolean; failedAt?: string }> {
  const { meta } = opts;
  const design = await readDoc(meta.projectPath, meta.id, 'design');
  const designSummary = design ? extractDesignSummary(design) : '';
  const steering = renderSteering(await readSteering(meta.projectPath));
  const p = getPrompts(opts.lang);

  for (const task of meta.tasks) {
    if (opts.signal?.aborted) return { ok: false, failedAt: task.id };
    if (task.status === 'done') continue;

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.output = '';
    task.error = undefined;
    await saveSpecMeta(meta);
    opts.onTaskStart(task);

    const prompt = buildTaskPrompt(task, meta, steering, designSummary, opts.lang);

    let taskResumeId: string | undefined;
    const r = await withRetry(
      (attempt) => {
        if (attempt > 1) task.output = '';
        return runTaskModel({
          cwd: meta.projectPath,
          prompt,
          permissionMode: opts.permissionMode ?? 'acceptEdits',
          signal: opts.signal,
          onText: (t) => {
            task.output = (task.output ?? '') + t;
            opts.onTaskText(task, t);
          },
          onSessionId: (id) => { taskResumeId = id; },
          resumeSessionId: attempt > 1 ? taskResumeId : undefined,
          monitor: {
            source: 'spec',
            specId: meta.id,
            projectPath: meta.projectPath,
            label: `${meta.title} · ${task.title}`,
          },
        });
      },
      {
        signal: opts.signal,
        onRetry: ({ attempt, waitMs, reason }) => {
          opts.onLog?.(p.retryLog(task.id, reason, waitMs, attempt));
        },
      },
    );

    if (r.error) {
      task.status = 'failed';
      task.error = r.error;
      task.finishedAt = new Date().toISOString();
      await saveSpecMeta(meta);
      opts.onTaskFailed(task, r.error);
      return { ok: false, failedAt: task.id };
    }

    task.status = 'done';
    task.finishedAt = new Date().toISOString();
    await saveSpecMeta(meta);
    opts.onTaskDone(task);
  }

  meta.currentPhase = 'done';
  meta.updatedAt = new Date().toISOString();
  await saveSpecMeta(meta);
  return { ok: true };
}

// ─── Retry Single Task ─────────────────────────────────────────────────

export async function retryTask(opts: ExecuteOptions & { taskId: string }): Promise<{ ok: boolean }> {
  const { meta, taskId } = opts;
  const task = meta.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false };

  const design = await readDoc(meta.projectPath, meta.id, 'design');
  const designSummary = design ? extractDesignSummary(design) : '';
  const steering = renderSteering(await readSteering(meta.projectPath));
  const p = getPrompts(opts.lang);

  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.output = '';
  task.error = undefined;
  await saveSpecMeta(meta);
  opts.onTaskStart(task);

  const prompt = buildTaskPrompt(task, meta, steering, designSummary, opts.lang);

  let taskResumeId: string | undefined;
  const r = await withRetry(
    (attempt) => {
      if (attempt > 1) task.output = '';
      return runTaskModel({
        cwd: meta.projectPath,
        prompt,
        permissionMode: opts.permissionMode ?? 'acceptEdits',
        signal: opts.signal,
        onText: (t) => {
          task.output = (task.output ?? '') + t;
          opts.onTaskText(task, t);
        },
        onSessionId: (id) => { taskResumeId = id; },
        resumeSessionId: attempt > 1 ? taskResumeId : undefined,
        monitor: {
          source: 'spec',
          specId: meta.id,
          projectPath: meta.projectPath,
          label: `${meta.title} · ${task.title}`,
        },
      });
    },
    {
      signal: opts.signal,
      onRetry: ({ attempt, waitMs, reason }) => {
        opts.onLog?.(p.retryLog(task.id, reason, waitMs, attempt));
      },
    },
  );

  if (r.error) {
    task.status = 'failed';
    task.error = r.error;
    task.finishedAt = new Date().toISOString();
    await saveSpecMeta(meta);
    opts.onTaskFailed(task, r.error);
    return { ok: false };
  }

  task.status = 'done';
  task.finishedAt = new Date().toISOString();
  // Check if all tasks are done now
  if (meta.tasks.every((t) => t.status === 'done')) {
    meta.currentPhase = 'done';
  }
  meta.updatedAt = new Date().toISOString();
  await saveSpecMeta(meta);
  opts.onTaskDone(task);
  return { ok: true };
}

// ─── Misc ───────────────────────────────────────────────────────────────

export function newSpecMeta(input: { projectPath: string; title: string; description: string; id: string }): SpecMeta {
  const now = new Date().toISOString();
  return {
    id: input.id,
    projectPath: input.projectPath,
    title: input.title,
    description: input.description,
    createdAt: now,
    updatedAt: now,
    currentPhase: 'requirements',
    phases: {
      requirements: { status: 'pending' },
      design: { status: 'pending' },
      tasks: { status: 'pending' },
    },
    tasks: [],
  };
}

export async function refreshTasksFromDoc(meta: SpecMeta): Promise<void> {
  const doc = await readDoc(meta.projectPath, meta.id, 'tasks');
  if (!doc) return;
  meta.tasks = parseTasks(doc);
  meta.updatedAt = new Date().toISOString();
  await saveSpecMeta(meta);
}

// ─── Retro Analysis (逆向分析) ──────────────────────────────────────────

export interface RetroAnalyzeOptions {
  projectPath: string;
  scopePath?: string;
  title?: string;
  lang?: string;
  signal?: AbortSignal;
  onText?: (phase: 'requirements' | 'design' | 'tasks', chunk: string, specId?: string) => void;
  onLog?: (line: string) => void;
  onPhaseStart?: (phase: 'requirements' | 'design' | 'tasks', specId?: string, title?: string) => void;
  onPhaseDone?: (phase: 'requirements' | 'design' | 'tasks', specId?: string) => void;
  /** Called when a new spec becomes visible (after its requirements phase). */
  onSpecCreated?: (specId: string) => void;
  /** Called when all specs are complete. */
  onComplete?: (specIds: string[]) => void;
}

/**
 * Scan project structure and use LLM to identify 2-4 logical modules.
 * Returns an array of { name, scopePath } for spec generation.
 */
async function identifyModules(
  projectPath: string,
  lang: string,
  signal?: AbortSignal,
): Promise<Array<{ name: string; scopePath?: string }>> {
  const dirs = await listDir(projectPath);
  const topLevel = dirs
    .filter((d) => d.isDir)
    .map((d) => d.name)
    .join(', ');

  const prompt = lang === 'en'
    ? `Analyze this project's directory structure and identify 2-4 logical modules or feature areas for separate documentation.

Project root: ${projectPath}
Top-level directories: ${topLevel}

Rules:
- Group related directories into meaningful modules (e.g., "Authentication" for auth-related dirs)
- Each module should be a coherent feature or layer
- If the project is small, return just 1 module for the whole project
- Output ONLY a JSON array, no other text

Output format:
\`\`\`json
[
  { "name": "Module Name", "scopePath": "src/auth" },
  { "name": "Another Module", "scopePath": "src/api" }
]
\`\`\`

If only one module covers everything, use "scopePath": null.`
    : `分析该项目的目录结构，识别出 2-4 个逻辑模块或功能区域，用于分别生成文档。

项目根目录: ${projectPath}
顶层目录: ${topLevel}

规则：
- 将相关目录分组为有意义的模块（例如将 auth 相关目录归为"认证模块"）
- 每个模块应是一个连贯的功能或层级
- 如果项目较小，只返回 1 个模块覆盖整个项目
- 只输出 JSON 数组，不加任何其他文字

输出格式：
\`\`\`json
[
  { "name": "模块名称", "scopePath": "src/auth" },
  { "name": "另一个模块", "scopePath": "src/api" }
]
\`\`\`

如果只需一个模块覆盖全部，使用 "scopePath": null。`;

  try {
    const r = await withRetry(
      async () =>
        runPlanMode({
          cwd: projectPath,
          ...(await planModelOpts(projectPath)),
          prompt,
          permissionMode: 'plan',
          signal,
          monitor: { source: 'wiki', projectPath, label: 'wiki 模块划分' },
        }),
      { signal, maxAttempts: 2 },
    );

    if ((!r.text || r.text.length < 20) && r.error) {
      // LLM failed — fall through to fallback
      throw new Error(r.error ?? 'empty response');
    }

    const jsonMatch = /```json\n?([\s\S]*?)\n?```/.exec(r.text)
      ?? /(\[[\s\S]*?\])/.exec(r.text);
    if (!jsonMatch) {
      // Could not find JSON — fall through to fallback
      throw new Error('no JSON found');
    }

    const parsed = JSON.parse(jsonMatch[1]);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const modules = parsed.map((m: any) => ({
        name: String(m.name ?? ''),
        scopePath: m.scopePath ? String(m.scopePath) : undefined,
      })).filter((m: any) => m.name);
      if (modules.length > 0) return modules;
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: return single module for entire project
  return [{ name: '', scopePath: undefined }];
}

export async function generateRetroSpec(
  opts: RetroAnalyzeOptions,
): Promise<{ ok: boolean; specId?: string; specIds?: string[]; error?: string }> {
  const { projectPath } = opts;
  const lang = opts.lang ?? 'zh';
  const p = getPrompts(lang);
  const steering = renderSteering(await readSteering(projectPath));
  const now = new Date().toISOString();

  // Step 1: Identify modules
  opts.onLog?.(lang === 'en' ? 'Scanning project structure…' : '扫描项目结构…');
  const modules = await identifyModules(projectPath, lang, opts.signal);

  if (modules.length === 0) {
    return { ok: false, error: 'failed to identify modules' };
  }

  if (modules.length === 1 && !modules[0].scopePath && !modules[0].name) {
    // Fallback: single spec for entire project
    modules[0].name = opts.title ?? `[现状] ${path.basename(projectPath)}`;
  }

  opts.onLog?.(lang === 'en'
    ? `Identified ${modules.length} module(s): ${modules.map((m) => m.name || '(entire project)').join(', ')}`
    : `识别到 ${modules.length} 个模块: ${modules.map((m) => m.name || '(全项目)').join(', ')}`);

  const createdSpecIds: string[] = [];

  // Step 2: Generate one spec per module
  for (let modIdx = 0; modIdx < modules.length; modIdx++) {
    const mod = modules[modIdx];
    const specId = randomBytes(6).toString('base64url').slice(0, 8);
    // Build title: avoid duplicating the "[现状]" prefix
    let specTitle: string;
    if (mod.name && opts.title) {
      // If mod.name already starts with opts.title prefix, just use mod.name
      if (mod.name.startsWith(opts.title) || mod.name.startsWith('[现状]') && opts.title.startsWith('[现状]')) {
        specTitle = mod.name;
      } else {
        specTitle = `${opts.title} — ${mod.name}`;
      }
    } else if (mod.name) {
      specTitle = mod.name.startsWith('[现状]') ? mod.name : `[现状] ${mod.name}`;
    } else {
      specTitle = opts.title ?? `[现状] ${path.basename(projectPath)}`;
    }
    const specDesc = mod.scopePath
      ? (lang === 'en' ? `Reverse-analyzed from existing code. Scope: ${mod.scopePath}` : `反推自现有代码。分析范围: ${mod.scopePath}`)
      : (lang === 'en' ? 'Reverse-analyzed from entire project codebase.' : '反推自现有代码。全项目逆向分析生成。');

    // Create spec meta with all phases pre-approved
    const meta: SpecMeta = {
      id: specId,
      projectPath,
      title: specTitle,
      description: specDesc,
      createdAt: now,
      updatedAt: now,
      currentPhase: 'done',
      phases: {
        requirements: { status: 'approved', generatedAt: now },
        design: { status: 'approved', generatedAt: now },
        tasks: { status: 'approved', generatedAt: now },
      },
      tasks: [],
    };
    await saveSpecMeta(meta);

    const modLabel = mod.name || (lang === 'en' ? `module ${modIdx + 1}` : `模块 ${modIdx + 1}`);
    opts.onLog?.(lang === 'en'
      ? `Starting analysis of ${modLabel}${mod.scopePath ? ` (${mod.scopePath})` : ''}…`
      : `开始分析 ${modLabel}${mod.scopePath ? ` (${mod.scopePath})` : ''}…`);

    const retroIntro = p.retroIntro(projectPath, mod.scopePath);
    const phases: Array<'requirements' | 'design' | 'tasks'> = ['requirements', 'design', 'tasks'];
    const promptMap = {
      requirements: p.retroRequirements,
      design: p.retroDesign,
      tasks: p.retroTasks,
    };

    let reqDoc = '';
    let designDoc = '';

    for (const phase of phases) {
      if (opts.signal?.aborted) return { ok: false, error: 'aborted', specIds: createdSpecIds };

      opts.onPhaseStart?.(phase, specId, specTitle);

      // Build prompt with accumulated context
      let prompt = `${steering}${retroIntro}`;
      if (phase === 'design' || phase === 'tasks') {
        prompt += p.existingReq(reqDoc);
      }
      if (phase === 'tasks') {
        prompt += p.existingDesign(designDoc);
      }
      prompt += `\n${promptMap[phase]}`;

      let resumeSessionId: string | undefined;
      // Notify frontend: starting Claude call (so it knows we're waiting for LLM, not stalled)
      opts.onLog?.(lang === 'en' ? `Calling Claude...` : `调用 Claude 中…`);
      const r = await withRetry(
        async (attempt) =>
          runPlanMode({
            cwd: projectPath,
            ...(await planModelOpts(projectPath)),
            prompt,
            permissionMode: 'plan',
            signal: opts.signal,
            onText: (chunk) => opts.onText?.(phase, chunk, specId),
            onLog: opts.onLog,
            onSessionId: (id) => { resumeSessionId = id; },
            resumeSessionId: attempt > 1 ? resumeSessionId : undefined,
            monitor: {
              source: 'spec',
              specId,
              projectPath,
              label: `${specTitle} · ${phase}`,
            },
          }),
        {
          signal: opts.signal,
          onRetry: ({ attempt, waitMs, reason }) => {
            opts.onLog?.(p.phaseRetryLog(reason, waitMs, attempt));
          },
        },
      );
      // Notify frontend: Claude call completed
      opts.onLog?.(lang === 'en' ? `Claude responded.` : `Claude 已响应。`);

      if ((!r.text || r.text.length < 20) && r.error) {
        meta.phases[phase].status = 'failed';
        meta.phases[phase].error = r.error ?? 'empty response';
        await saveSpecMeta(meta);
        return { ok: false, error: r.error ?? 'empty response', specIds: createdSpecIds };
      }

      const content = stripFences(r.text);
      await writeDoc(projectPath, specId, phase, content);

      // Track docs for accumulated context
      if (phase === 'requirements') reqDoc = content;
      if (phase === 'design') designDoc = content;

      // Parse tasks and mark all as done (retro sentinel pattern)
      if (phase === 'tasks') {
        const parsed = parseTasks(content);
        const taskDoneTime = new Date().toISOString();
        meta.tasks = parsed.map((t) => ({
          ...t,
          status: 'done' as const,
          startedAt: taskDoneTime,
          finishedAt: taskDoneTime,
          output: lang === 'en'
            ? `[Current] Code for this task already exists in the repo. To modify this module, create a new spec based on this spec's requirements/design.`
            : `[现状] 此任务对应代码已在仓库中，无需执行。要修改本模块请基于本 spec 的 requirements/design 起新 spec。`,
        }));
      }

      meta.phases[phase].generatedAt = new Date().toISOString();
      await saveSpecMeta(meta);
      opts.onPhaseDone?.(phase, specId);

      // After requirements phase: spec is now visible to the user
      if (phase === 'requirements') {
        createdSpecIds.push(specId);
        opts.onSpecCreated?.(specId);
      }
    }

    meta.updatedAt = new Date().toISOString();
    await saveSpecMeta(meta);
  }

  opts.onComplete?.(createdSpecIds);
  return { ok: true, specId: createdSpecIds[0], specIds: createdSpecIds };
}

// ─── Optimization Report (优化审查) ─────────────────────────────────────

export interface OptimizeAnalyzeOptions {
  projectPath: string;
  existingSpecs: SpecMeta[];
  title?: string;
  lang?: string;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onLog?: (line: string) => void;
}

export async function generateOptimizationReport(
  opts: OptimizeAnalyzeOptions,
): Promise<{ ok: boolean; specId?: string; error?: string }> {
  const { projectPath, existingSpecs } = opts;
  const p = getPrompts(opts.lang);
  const steering = renderSteering(await readSteering(projectPath));
  const now = new Date().toISOString();
  const specId = randomBytes(6).toString('base64url').slice(0, 8);
  const title = opts.title ?? `[优化] ${path.basename(projectPath)}`;

  // Read all existing spec docs
  const allDocs: string[] = [];
  for (const s of existingSpecs) {
    const [req, design, tasks] = await Promise.all([
      readDoc(s.projectPath, s.id, 'requirements'),
      readDoc(s.projectPath, s.id, 'design'),
      readDoc(s.projectPath, s.id, 'tasks'),
    ]);
    allDocs.push([
      `## Spec: ${s.title} (${s.id})`,
      `### requirements.md`,
      req || '(空)',
      `### design.md`,
      design || '(空)',
      `### tasks.md`,
      tasks || '(空)',
      '---',
    ].join('\n'));
  }

  // Build prompt
  const prompt = [
    steering,
    p.optimizeIntro(projectPath, existingSpecs.length),
    '以下是所有现有 spec 的完整内容:',
    '',
    allDocs.join('\n\n'),
    '',
    p.optimizeReport,
  ].join('\n');

  // Create report spec meta
  const meta: SpecMeta = {
    id: specId,
    projectPath,
    title,
    description: `审查并优化全部 ${existingSpecs.length} 个 spec 的报告。`,
    createdAt: now,
    updatedAt: now,
    currentPhase: 'done',
    phases: {
      requirements: { status: 'approved', generatedAt: now },
      design: { status: 'approved', generatedAt: now },
      tasks: { status: 'approved', generatedAt: now },
    },
    tasks: [],
  };
  await saveSpecMeta(meta);

  let resumeSessionId: string | undefined;
  const r = await withRetry(
    async (attempt) =>
      runPlanMode({
        cwd: projectPath,
        ...(await planModelOpts(projectPath)),
        prompt,
        permissionMode: 'plan',
        signal: opts.signal,
        onText: opts.onText,
        onLog: opts.onLog,
        onSessionId: (id) => { resumeSessionId = id; },
        resumeSessionId: attempt > 1 ? resumeSessionId : undefined,
        monitor: {
          source: 'spec',
          specId: meta.id,
          projectPath,
          label: meta.title,
        },
      }),
    {
      signal: opts.signal,
      onRetry: ({ attempt, waitMs, reason }) => {
        opts.onLog?.(p.phaseRetryLog(reason, waitMs, attempt));
      },
    },
  );

  if ((!r.text || r.text.length < 20) && r.error) {
    meta.phases.requirements.status = 'failed';
    meta.phases.requirements.error = r.error ?? 'empty response';
    await saveSpecMeta(meta);
    return { ok: false, error: r.error ?? 'empty response' };
  }

  const content = stripFences(r.text);
  await writeDoc(projectPath, specId, 'requirements', content);

  meta.updatedAt = new Date().toISOString();
  await saveSpecMeta(meta);
  return { ok: true, specId };
}

// ─── Project Wiki Generation (Multi-Pass) ───────────────────────────────

export interface WikiGenerateOptions {
  projectPath: string;
  lang?: string;
  depth?: WikiDepth;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onLog?: (line: string) => void;
}

interface WikiSectionDef {
  id: string;
  h: string;
  tpl: string;
}

/**
 * Build the per-section prompt for multi-pass generation.
 * Each section is focused and compact to avoid output truncation.
 */
function buildSectionPrompt(
  p: ReturnType<typeof getPrompts>,
  projectPath: string,
  fileTree: string,
  section: WikiSectionDef,
  previousSections: string,
  totalSections: number,
  currentIdx: number,
): string {
  const rules = p.wikiRules;
  const progress = `[Section ${currentIdx + 1}/${totalSections}: ${section.h}]`;
  const contextHeader = `项目根目录: ${projectPath}\n\n项目文件结构:\n${fileTree}`;
  const previousCtx = previousSections
    ? `\n\n---\n此前已生成的 Wiki 内容（供参考，请在此基础上继续生成，不要重复）:\n${previousSections}\n---\n`
    : '';
  return [
    contextHeader,
    previousCtx,
    progress,
    rules,
    `\n请直接输出以下内容（${section.h} 章节）：`,
    section.tpl,
  ].join('\n');
}

/**
 * Generate a comprehensive Wiki document via multiple focused AI passes.
 * Each pass generates one section, keeping output per call well within limits.
 * Depth controls how many sections are generated:
 * - quick: 4 passes (overview, stack, arch, structure)
 * - fine: 6 passes (+ arch details, core modules)
 * - ultra: 7 passes (+ dev guide & FAQ)
 * Result is atomically written to `.sage/wiki.md`.
 */
export async function generateProjectWiki(
  opts: WikiGenerateOptions,
): Promise<{ ok: boolean; error?: string }> {
  const { projectPath } = opts;
  const depth: WikiDepth = opts.depth ?? 'fine';
  const p = getPrompts(opts.lang);
  const steering = renderSteering(await readSteering(projectPath));

  opts.onLog?.('Scanning project structure…');
  const fileTree = await buildFileTree(projectPath);

  // Select depth-specific sections
  const sections: readonly WikiSectionDef[] = p.wikiSections[depth];
  opts.onLog?.(`Generating wiki: ${sections.length} passes (${depth} depth)…`);

  const sectionOutputs = new Map<string, string>();

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];

    // Build accumulated context from previous sections
    const prevContent = Array.from(sectionOutputs.values()).join('\n\n');
    const prompt = [
      steering,
      buildSectionPrompt(p, projectPath, fileTree, section, prevContent, sections.length, i),
    ].join('\n');

    opts.onLog?.(`  → Pass ${i + 1}/${sections.length}: ${section.h.replace('## ', '')}`);

    let resumeSessionId: string | undefined;
    const r = await withRetry(
      async (attempt) =>
        runPlanMode({
          cwd: projectPath,
          ...(await planModelOpts(projectPath)),
          prompt,
          permissionMode: 'plan',
          signal: opts.signal,
          onText: opts.onText,
          onLog: opts.onLog,
          onSessionId: (id) => { resumeSessionId = id; },
          resumeSessionId: attempt > 1 ? resumeSessionId : undefined,
          monitor: {
            source: 'wiki',
            projectPath,
            label: `wiki: ${section.h.replace('## ', '')}`,
          },
        }),
      {
        signal: opts.signal,
        onRetry: ({ attempt, waitMs, reason }) => {
          opts.onLog?.(p.phaseRetryLog(reason, waitMs, attempt));
        },
      },
    );

    if ((!r.text || r.text.length < 20) && r.error) {
      return { ok: false, error: r.error ?? `empty response at section ${i + 1}` };
    }

    sectionOutputs.set(section.id, stripFences(r.text));
    opts.onLog?.(`  ✓ Pass ${i + 1}/${sections.length} done`);
  }

  // Assemble final document
  let body = '';
  for (const section of sections) {
    const content = sectionOutputs.get(section.id) ?? '';
    if (body) body += '\n\n';
    body += `${section.h}\n${content}`.trim();
  }

  const projectName = path.basename(projectPath);
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const assembled = `# ${projectName} — Wiki\n\n${body}\n\n---\n\n_Generated at ${timestamp} (${depth} depth, ${sections.length} passes)_`;

  await writeWiki(projectPath, assembled);
  opts.onLog?.('Wiki saved to .sage/wiki.md');
  return { ok: true };
}

/**
 * Build a human-readable file tree string for the project, limited
 * to top 4 levels and skipping common noise directories.
 * Source directories (src, app, lib, packages, components) are prioritised.
 */
async function buildFileTree(projectPath: string, maxDepth = 4): Promise<string> {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.sage', '.claude-gui', '__pycache__', '.next', '.nuxt', 'coverage', '.cache']);
  const SRC_DIRS = new Set(['src', 'app', 'lib', 'packages', 'components', 'pages', 'api', 'utils', 'hooks', 'services']);
  const lines: string[] = [];

  async function walk(rel: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = await listDir(projectPath, rel);
      // Sort: dirs first; source dirs before others; then alphabetical
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        if (a.isDir && b.isDir) {
          const aSrc = SRC_DIRS.has(a.name) ? 0 : 1;
          const bSrc = SRC_DIRS.has(b.name) ? 0 : 1;
          if (aSrc !== bSrc) return aSrc - bSrc;
        }
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (entry.isDir && SKIP.has(entry.name)) continue;
        const indent = '  '.repeat(depth);
        const prefix = entry.isDir ? '📁 ' : '  ';
        lines.push(`${indent}${prefix}${entry.name}`);
        if (entry.isDir) {
          await walk(entry.relPath, depth + 1);
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  await walk('', 0);
  // Cap output to avoid huge prompts
  if (lines.length > 600) {
    return lines.slice(0, 600).join('\n') + '\n… (truncated)';
  }
  return lines.join('\n');
}
