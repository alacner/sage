import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {runPlanMode as runClaude} from './claude-api-bridge';
import { runPlanMode } from './claude-api-bridge';
import { withRetry } from './retry';
import { saveSpecMeta, readSteering, PROJECT_DIR } from './store';
import type { SpecMeta, LoopConfig, LoopState, LoopIteration, SteeringDocs } from '../shared/types';

const execFileP = promisify(execFile);

// ─── Prompt Templates ─────────────────────────────────────────────────────

interface LoopPrompts {
  loopPlan: string;
  loopGenerate: string;
  loopRefine: (ctx: RefineContext) => string;
  loopEvalLLM: (criteria: string, implementation: string) => string;
  loopAnalyze: (goal: string, implementation: string, evaluation: string) => string;
  loopOscillationBreak: (ctx: OscillationContext) => string;
}

interface RefineContext {
  goal: string;
  prevPlan: string;
  prevOutput: string;
  prevEval: string;
  prevAnalysis: string;
  iterationMemory: string;
  metricTrend: string;
  oscillationWarning: string;
}

interface OscillationContext {
  goal: string;
  metricHistory: number[];
  recentApproaches: string[];
  lastAnalysis: string;
}

function getLoopPrompts(lang: string): LoopPrompts {
  if (lang === 'en') return enLoopPrompts;
  return zhLoopPrompts;
}

// ─── Chinese Prompts ──────────────────────────────────────────────────────

const zhLoopPrompts: LoopPrompts = {
  loopPlan: `你正在执行一个自主迭代循环任务。在实现之前，请先制定一个详细的执行计划。

【绝对规则】
- 仔细阅读项目代码，理解上下文
- 输出一个结构化的执行计划（步骤、文件、预期结果）
- 计划需要包含如何验证成功的步骤
- 不要询问用户任何问题
- 只输出计划，不要开始实现

## 目标
{{GOAL}}

## 评估标准
{{EVAL_CRITERIA}}

## 项目上下文
- 项目路径: {{PROJECT_PATH}}
- Spec 标题: {{SPEC_TITLE}}
- 原始描述: {{SPEC_DESCRIPTION}}

请制定执行计划。`,

  loopGenerate: `你正在执行一个自主迭代循环任务。请根据以下计划完成实现。

【绝对规则】
- 严格按照计划执行
- 生成完整、可运行的实现方案
- 方案需要能通过后续的自动评估
- 不要询问用户任何问题
- 直接输出实现方案

## 目标
{{GOAL}}

## 执行计划
{{PLAN}}

## 项目上下文
- 项目路径: {{PROJECT_PATH}}
- Spec 标题: {{SPEC_TITLE}}

请开始实现。`,

  loopRefine: (ctx) => `你正在执行自主迭代循环的第 N+1 轮修正。上一轮的实现未通过评估。

【绝对规则】
- 仔细分析所有失败原因，不要重复犯同样的错误
- 参考历史迭代记录，避免重复尝试已失败的方法
- 修正实现中的问题
- 不要询问用户任何问题
- 直接输出修正后的实现方案

## 目标
${ctx.goal}

## 当前计划
${truncate(ctx.prevPlan, 2000)}

## 历史迭代摘要
${ctx.iterationMemory}

## 指标趋势
${ctx.metricTrend}

${ctx.oscillationWarning ? `## ⚠️ 振荡警告\n${ctx.oscillationWarning}\n\n请彻底改变策略，不要重复之前的方法。\n` : ''}
## 上一轮实现摘要（前 3000 字）
${truncate(ctx.prevOutput, 3000)}

## 上一轮评估结果
${truncate(ctx.prevEval, 2000)}

## 失败分析
${ctx.prevAnalysis}

请修正并重新实现。`,

  loopEvalLLM: (criteria, implementation) => `你是一位严格的评审员。请根据以下标准评估实现质量。

【绝对规则】
- 只输出 JSON，不加任何前缀解释或后续对话
- 严格按照给出的 JSON 格式输出
- 评估必须基于实际内容，不要编造
- 给出明确的量化指标

## 评估标准
${criteria}

## 待评估的实现
${truncate(implementation, 5000)}

## 输出格式（严格遵守）
请输出以下 JSON 格式，不要附加任何其他内容：

\`\`\`json
{
  "passed": true 或 false,
  "metricValue": 数字（如有，如准确率百分比）,
  "summary": "一句话评估结论",
  "details": "详细评估，列出通过/未通过的具体项目"
}
\`\`\``,

  loopAnalyze: (goal, implementation, evaluation) => `请分析以下实现未通过评估的原因，并提出具体修正建议。

【绝对规则】
- 只输出分析内容，不加任何前缀或后续对话
- 找出 1-3 个最关键的失败原因
- 为每个原因提供具体修正建议
- 用编号列表输出，简洁明了
- 如果分析发现和之前的失败原因类似，请明确指出需要"换一种完全不同的方法"

## 目标
${goal}

## 实现输出（前 3000 字）
${truncate(implementation, 3000)}

## 评估结果
${truncate(evaluation, 2000)}

请分析失败原因并给出修正建议。`,

  loopOscillationBreak: (ctx) => `你的自主迭代循环陷入了停滞。指标在 ${ctx.metricHistory.length} 轮迭代中没有改善。

【绝对规则】
- 彻底改变策略，不要重复之前的方法
- 分析为什么之前的方法都失败了
- 提出一种全新的、不同的方法
- 输出新的执行计划

## 目标
${ctx.goal}

## 指标历史
${ctx.metricHistory.join(' → ')}

## 已尝试过的方法（不要重复）
${ctx.recentApproaches.map((a, i) => `${i + 1}. ${truncate(a, 200)}`).join('\n')}

## 上一轮分析
${ctx.lastAnalysis}

请提出一种完全不同的方法，输出新的执行计划。`,
};

// ─── English Prompts ──────────────────────────────────────────────────────

const enLoopPrompts: LoopPrompts = {
  loopPlan: `You are executing an autonomous iteration loop task. Before implementing, create a detailed execution plan.

[STRICT RULES]
- Carefully read the project code to understand context
- Output a structured execution plan (steps, files, expected outcomes)
- Include how to verify success
- Do not ask the user any questions
- Output only the plan, do not start implementing

## Goal
{{GOAL}}

## Evaluation Criteria
{{EVAL_CRITERIA}}

## Project Context
- Project path: {{PROJECT_PATH}}
- Spec title: {{SPEC_TITLE}}
- Original description: {{SPEC_DESCRIPTION}}

Please create an execution plan.`,

  loopGenerate: `You are executing an autonomous iteration loop task. Implement based on the following plan.

[STRICT RULES]
- Follow the plan strictly
- Generate a complete, runnable implementation
- The solution must pass subsequent automated evaluation
- Do not ask the user any questions
- Output the implementation directly

## Goal
{{GOAL}}

## Execution Plan
{{PLAN}}

## Project Context
- Project path: {{PROJECT_PATH}}
- Spec title: {{SPEC_TITLE}}

Please begin implementation.`,

  loopRefine: (ctx) => `You are on iteration N+1 of an autonomous refinement loop. The previous implementation did not pass evaluation.

[STRICT RULES]
- Carefully analyze ALL failure reasons; do not repeat the same mistakes
- Reference the iteration history to avoid re-trying failed approaches
- Fix the issues in the implementation
- Do not ask the user any questions
- Output the corrected implementation directly

## Goal
${ctx.goal}

## Current Plan
${truncate(ctx.prevPlan, 2000)}

## Iteration History Summary
${ctx.iterationMemory}

## Metric Trend
${ctx.metricTrend}

${ctx.oscillationWarning ? `## ⚠️ Oscillation Warning\n${ctx.oscillationWarning}\n\nYou MUST change strategy completely. Do not repeat previous approaches.\n` : ''}
## Previous Implementation Summary (first 3000 chars)
${truncate(ctx.prevOutput, 3000)}

## Previous Evaluation Result
${truncate(ctx.prevEval, 2000)}

## Failure Analysis
${ctx.prevAnalysis}

Please fix and reimplement.`,

  loopEvalLLM: (criteria, implementation) => `You are a strict evaluator. Assess the implementation quality based on the following criteria.

[STRICT RULES]
- Output ONLY JSON. No preamble, no meta-commentary, no follow-up.
- Follow the JSON format exactly.
- Assessment must be based on actual content, never fabricate.
- Provide a clear quantitative metric.

## Evaluation Criteria
${criteria}

## Implementation to Evaluate
${truncate(implementation, 5000)}

## Output Format (strictly follow)
Output the following JSON format with no additional content:

\`\`\`json
{
  "passed": true or false,
  "metricValue": <number if applicable, e.g. accuracy percentage>,
  "summary": "<one-sentence conclusion>",
  "details": "<detailed assessment listing pass/fail items>"
}
\`\`\``,

  loopAnalyze: (goal, implementation, evaluation) => `Analyze why the following implementation failed evaluation and propose specific fixes.

[STRICT RULES]
- Output ONLY the analysis. No preamble or follow-up.
- Identify 1-3 most critical failure reasons.
- Provide specific fix suggestions for each.
- Use a numbered list, be concise.
- If the analysis finds similar failure reasons as before, explicitly state "a completely different approach is needed".

## Goal
${goal}

## Implementation Output (first 3000 chars)
${truncate(implementation, 3000)}

## Evaluation Result
${truncate(evaluation, 2000)}

Please analyze the failure reasons and suggest fixes.`,

  loopOscillationBreak: (ctx) => `Your autonomous iteration loop has stalled. The metric has not improved over ${ctx.metricHistory.length} iterations.

[STRICT RULES]
- Change strategy completely — do not repeat previous approaches
- Analyze why all previous approaches failed
- Propose a fundamentally different method
- Output a new execution plan

## Goal
${ctx.goal}

## Metric History
${ctx.metricHistory.join(' → ')}

## Approaches Already Tried (do NOT repeat)
${ctx.recentApproaches.map((a, i) => `${i + 1}. ${truncate(a, 200)}`).join('\n')}

## Last Analysis
${ctx.lastAnalysis}

Please propose a completely different approach and output a new execution plan.`,
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function fillTemplate(
  template: string,
  config: LoopConfig,
  meta: SpecMeta,
  extra?: Record<string, string>,
): string {
  let result = template
    .replace('{{GOAL}}', config.goal)
    .replace('{{PROJECT_PATH}}', meta.projectPath)
    .replace('{{SPEC_TITLE}}', meta.title)
    .replace('{{SPEC_DESCRIPTION}}', meta.description)
    .replace('{{EVAL_CRITERIA}}', config.evalCriteria ?? config.evalCommand ?? config.goal);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      result = result.replace(`{{${k}}}`, v);
    }
  }
  return result;
}

// ─── Iteration Memory ─────────────────────────────────────────────────────

interface IterationRecord {
  number: number;
  planSummary: string;
  metricValue?: number;
  passed: boolean;
  approachSummary: string;
  failureReason?: string;
}

function buildIterationMemory(records: IterationRecord[]): string {
  if (records.length === 0) return '(none)';
  return records
    .map((r) => {
      const metric = r.metricValue !== undefined ? ` → metric: ${r.metricValue}` : '';
      const status = r.passed ? '✓ PASS' : '✗ FAIL';
      const fail = r.failureReason ? `\n   Failure: ${truncate(r.failureReason, 150)}` : '';
      return `#${r.number} [${status}]${metric}\n   Approach: ${truncate(r.approachSummary, 200)}${fail}`;
    })
    .join('\n\n');
}

function buildMetricTrend(history: number[], unit: string): string {
  if (history.length === 0) return '(no data)';
  const trend = history.join(' → ');
  const last = history[history.length - 1];
  const first = history[0];
  const delta = last - first;
  const direction = delta > 0 ? '↑ improving' : delta < 0 ? '↓ declining' : '→ flat';
  return `${trend} (${direction}, Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${unit})`;
}

// ─── Oscillation Detection ────────────────────────────────────────────────

function detectOscillation(metricHistory: number[]): {
  oscillating: boolean;
  warning: string;
} {
  if (metricHistory.length < 3) return { oscillating: false, warning: '' };

  const recent = metricHistory.slice(-4);
  const first = recent[0];
  const last = recent[recent.length - 1];

  // Check if metrics are stagnant (less than 5% improvement over 4 iterations)
  const range = Math.max(...recent) - Math.min(...recent);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const relativeRange = avg > 0 ? range / avg : range;

  if (relativeRange < 0.05 && recent.length >= 3) {
    return {
      oscillating: true,
      warning: `Metrics have stagnated: ${recent.join(' → ')}. Range is only ${(relativeRange * 100).toFixed(1)}% over ${recent.length} iterations. A fundamentally different approach is needed.`,
    };
  }

  // Check for oscillation pattern: up-down-up-down
  if (recent.length >= 4) {
    const diffs: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      diffs.push(recent[i] - recent[i - 1]);
    }
    const signChanges = diffs.filter((d, i) => i > 0 && Math.sign(d) !== Math.sign(diffs[i - 1]) && d !== 0).length;
    if (signChanges >= 2) {
      return {
        oscillating: true,
        warning: `Metrics are oscillating: ${recent.join(' → ')}. The approach is unstable. Consider a completely different strategy.`,
      };
    }
  }

  // Check for decline
  if (recent.length >= 3 && last < first) {
    return {
      oscillating: true,
      warning: `Metrics are declining: ${recent.join(' → ')}. The current approach is making things worse. Reassess the fundamental strategy.`,
    };
  }

  return { oscillating: false, warning: '' };
}

// ─── Core Loop Engine ─────────────────────────────────────────────────────

export interface LoopRunOptions {
  meta: SpecMeta;
  config: LoopConfig;
  signal?: AbortSignal;
  lang?: string;
  onIterationStart: (iteration: number) => void;
  onIterationText: (iteration: number, chunk: string) => void;
  onIterationEval: (iteration: number, result: NonNullable<LoopIteration['evaluation']>) => void;
  onIterationDone: (iteration: number, status: string) => void;
  onPlan: (iteration: number, plan: string) => void;
  onCheckpoint: (iteration: number, metricHistory: number[]) => void;
  onConverged: (output: string, totalIterations: number, metric?: number) => void;
  onLog: (line: string) => void;
  onError: (error: string) => void;
  /** Called when the engine needs to pause for a human checkpoint. Resolves when user resumes. */
  waitForCheckpoint?: () => Promise<string | undefined>;
}

export async function runLoop(
  opts: LoopRunOptions,
): Promise<{
  ok: boolean;
  convergedOutput?: string;
  iterations: number;
  finalMetric?: number;
  error?: string;
}> {
  const { meta, config, signal, lang = 'zh' } = opts;

  if (!meta.projectPath || !existsSync(meta.projectPath)) {
    return { ok: false, iterations: 0, error: `项目路径不存在: ${meta.projectPath}` };
  }

  const prompts = getLoopPrompts(lang);
  const steering = renderSteering(await readSteering(meta.projectPath));
  const maxIter = config.maxIterations ?? 10;
  const enablePlanning = config.enablePlanning !== false; // default true
  const timeoutMs = (config.timeoutMinutes ?? 0) * 60 * 1000;
  const startTime = Date.now();

  // Iteration memory
  const iterationRecords: IterationRecord[] = [];
  const metricHistory: number[] = [];

  let prevPlan = '';
  let prevOutput = '';
  let prevEval = '';
  let prevAnalysis = '';

  for (let iter = 1; iter <= maxIter; iter++) {
    if (signal?.aborted) {
      return { ok: false, iterations: iter - 1, error: 'aborted' };
    }

    // Global timeout guardrail
    if (timeoutMs > 0 && Date.now() - startTime > timeoutMs) {
      const elapsed = Math.round((Date.now() - startTime) / 60_000);
      const msg = `Timeout: loop exceeded ${config.timeoutMinutes} minutes (${elapsed} min elapsed)`;
      opts.onError(msg);
      return { ok: false, iterations: iter - 1, error: msg };
    }

    opts.onIterationStart(iter);

    // ── Oscillation detection ──────────────────────────────────────────
    const oscillation = detectOscillation(metricHistory);

    // ── Phase 1: Planning (Plan-then-Execute pattern) ──────────────────
    if (enablePlanning) {
      opts.onLog(`  Pass ${iter}/${maxIter}: planning…`);

      let planPrompt: string;
      if (iter === 1) {
        planPrompt = steering + fillTemplate(prompts.loopPlan, config, meta);
      } else if (oscillation.oscillating) {
        // Strategy escalation: when oscillating, generate a fundamentally new plan
        opts.onLog(`  ⚠ Oscillation detected — generating new strategy…`);
        const oscCtx: OscillationContext = {
          goal: config.goal,
          metricHistory: [...metricHistory],
          recentApproaches: iterationRecords.map((r) => r.approachSummary),
          lastAnalysis: prevAnalysis,
        };
        planPrompt = steering + prompts.loopOscillationBreak(oscCtx);
      } else {
        // Refinement plan: based on previous failures
        planPrompt = steering + buildRefinePlanPrompt(config, meta, prevPlan, prevEval, prevAnalysis, iterationRecords, metricHistory, lang);
      }

      const planResult = await withRetry(
        (attempt) =>
          runPlanMode({
            cwd: meta.projectPath,
            prompt: planPrompt,
            permissionMode: 'plan',
            signal,
            onLog: opts.onLog,
            monitor: { source: 'loop', specId: meta.id, projectPath: meta.projectPath, label: 'loop: plan' },
          }),
        { signal, maxAttempts: 2 },
      );

      if (planResult.error || !planResult.text) {
        opts.onLog(`  Plan generation failed: ${planResult.error ?? 'empty'}, proceeding without plan`);
      } else {
        prevPlan = planResult.text;
        opts.onPlan(iter, prevPlan);
        opts.onLog(`  Pass ${iter}/${maxIter}: plan ready (${prevPlan.length} chars)`);
      }
    }

    // ── Phase 2: Generate / Execute ────────────────────────────────────
    opts.onLog(`  Pass ${iter}/${maxIter}: ${iter === 1 ? 'generating' : 'refining'}…`);

    let generatePrompt: string;
    if (iter === 1) {
      if (enablePlanning && prevPlan) {
        generatePrompt = steering + fillTemplate(prompts.loopGenerate, config, meta, { PLAN: prevPlan });
      } else {
        generatePrompt = steering + fillTemplate(prompts.loopPlan, config, meta).replace(
          '请先制定一个详细的执行计划',
          '请直接实现',
        ).replace(
          'create a detailed execution plan',
          'implement directly'
        );
      }
    } else {
      const refineCtx: RefineContext = {
        goal: config.goal,
        prevPlan,
        prevOutput,
        prevEval,
        prevAnalysis,
        iterationMemory: buildIterationMemory(iterationRecords),
        metricTrend: buildMetricTrend(metricHistory, config.metricUnit ?? ''),
        oscillationWarning: oscillation.warning,
      };
      generatePrompt = steering + prompts.loopRefine(refineCtx);
    }

    const iterOutput: string[] = [];

    const genResult = await withRetry(
      (attempt) =>
        runClaude({
          cwd: meta.projectPath,
          prompt: generatePrompt,
          permissionMode: 'acceptEdits',
          signal,
          onText: (chunk) => {
            iterOutput.push(chunk);
            opts.onIterationText(iter, chunk);
          },
          onLog: opts.onLog,
          monitor: { source: 'loop', specId: meta.id, projectPath: meta.projectPath, label: 'loop: generate' },
        }),
      {
        signal,
        onRetry: ({ attempt, waitMs, reason }) => {
          opts.onLog(`  Retry ${attempt} after ${waitMs}ms: ${reason}`);
        },
      },
    );

    if (genResult.error || !genResult.text) {
      const err = genResult.error ?? 'empty response';
      opts.onError(`Generation failed at iteration ${iter}: ${err}`);
      return { ok: false, iterations: iter, error: err };
    }

    const output = genResult.text;
    opts.onLog(`  Pass ${iter}/${maxIter}: generation done (${output.length} chars)`);

    // ── Phase 3: Evaluate ──────────────────────────────────────────────
    opts.onLog(`  Pass ${iter}/${maxIter}: evaluating…`);
    let evalResult: NonNullable<LoopIteration['evaluation']>;

    if (config.evalStrategy === 'command') {
      evalResult = await evaluateWithCommand(config, meta.projectPath, signal);
    } else {
      evalResult = await evaluateWithLLM(
        config, meta, output, signal, lang,
        (chunk) => opts.onIterationText(iter, chunk),
        opts.onLog,
      );
    }

    opts.onIterationEval(iter, evalResult);
    opts.onLog(`  Pass ${iter}/${maxIter}: ${evalResult.passed ? 'PASSED ✓' : 'FAILED ✗'} — ${evalResult.summary}`);

    // Record metric
    if (evalResult.metricValue !== undefined) {
      metricHistory.push(evalResult.metricValue);
    }

    // Record iteration memory
    iterationRecords.push({
      number: iter,
      planSummary: prevPlan ? truncate(prevPlan, 300) : '(no plan)',
      metricValue: evalResult.metricValue,
      passed: evalResult.passed,
      approachSummary: truncate(output, 300),
      failureReason: evalResult.passed ? undefined : evalResult.summary,
    });

    // ── Check convergence ──────────────────────────────────────────────
    if (evalResult.passed) {
      opts.onConverged(output, iter, evalResult.metricValue);
      opts.onLog(`★ Converged after ${iter} iterations (metric: ${evalResult.metricValue ?? 'N/A'})`);
      return {
        ok: true,
        convergedOutput: output,
        iterations: iter,
        finalMetric: evalResult.metricValue,
      };
    }

    // ── Phase 4: Analyze failures ──────────────────────────────────────
    prevOutput = output;
    prevEval = evalResult.raw;

    if (iter < maxIter) {
      opts.onLog(`  Pass ${iter}/${maxIter}: analyzing failures…`);
      const analysisPrompt = steering + prompts.loopAnalyze(config.goal, output, evalResult.raw);

      const analysisResult = await withRetry(
        (attempt) =>
          runPlanMode({
            cwd: meta.projectPath,
            prompt: analysisPrompt,
            permissionMode: 'plan',
            signal,
            onLog: opts.onLog,
            monitor: { source: 'loop', specId: meta.id, projectPath: meta.projectPath, label: 'loop: analyze' },
          }),
        {
          signal,
          maxAttempts: 2,
          onRetry: ({ attempt, waitMs, reason }) => {
            opts.onLog(`  Analysis retry ${attempt}: ${reason}`);
          },
        },
      );

      prevAnalysis = analysisResult.text ?? analysisResult.error ?? 'Analysis failed';
      opts.onLog(`  Pass ${iter}/${maxIter}: analysis complete`);
    }

    opts.onIterationDone(iter, 'failed');

    // ── Phase 5: Human checkpoint ──────────────────────────────────────
    const checkpointInterval = config.humanCheckpoint ?? 0;
    if (checkpointInterval > 0 && iter % checkpointInterval === 0 && iter < maxIter) {
      opts.onLog(`  ⏸ Human checkpoint at iteration ${iter}`);
      opts.onCheckpoint(iter, [...metricHistory]);

      if (opts.waitForCheckpoint) {
        const feedback = await opts.waitForCheckpoint();
        if (feedback === '__abort__') {
          return { ok: false, iterations: iter, error: 'aborted at checkpoint' };
        }
        if (feedback) {
          prevAnalysis = `Human feedback:\n${feedback}\n\nPrevious analysis:\n${prevAnalysis}`;
          opts.onLog(`  Human feedback incorporated`);
        }
      }
    }
  }

  // Exhausted max iterations without converging
  const finalMsg = `Failed to converge after ${maxIter} iterations`;
  opts.onError(finalMsg);
  return { ok: false, iterations: maxIter, error: finalMsg };
}

// ─── Helper: Build refine plan prompt ─────────────────────────────────────

function buildRefinePlanPrompt(
  config: LoopConfig,
  meta: SpecMeta,
  prevPlan: string,
  prevEval: string,
  prevAnalysis: string,
  records: IterationRecord[],
  metricHistory: number[],
  lang: string,
): string {
  const memory = buildIterationMemory(records);
  const trend = buildMetricTrend(metricHistory, config.metricUnit ?? '');

  if (lang === 'en') {
    return `Based on the previous iteration results, create a refined execution plan.

## Goal
${config.goal}

## Previous Plan
${truncate(prevPlan, 2000)}

## Iteration History
${memory}

## Metric Trend
${trend}

## Last Evaluation
${truncate(prevEval, 1500)}

## Failure Analysis
${prevAnalysis}

Create an improved plan that addresses the identified issues. Focus on what should be done differently.`;
  }

  return `根据之前的迭代结果，制定一个改进的执行计划。

## 目标
${config.goal}

## 之前的计划
${truncate(prevPlan, 2000)}

## 历史迭代记录
${memory}

## 指标趋势
${trend}

## 上次评估结果
${truncate(prevEval, 1500)}

## 失败分析
${prevAnalysis}

请制定一个改进的计划，重点说明哪些地方需要改变。`;
}

// ─── Evaluation Strategies ────────────────────────────────────────────────

async function evaluateWithCommand(
  config: LoopConfig,
  projectPath: string,
  signal?: AbortSignal,
): Promise<NonNullable<LoopIteration['evaluation']>> {
  try {
    const { stdout, stderr } = await execFileP('bash', ['-c', config.evalCommand!], {
      cwd: projectPath,
      timeout: 60_000,
      signal,
      env: { ...process.env },
    });

    const raw = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
    let metricValue: number | undefined;

    if (config.evalPattern) {
      const match = new RegExp(config.evalPattern).exec(stdout);
      if (match?.[1]) {
        metricValue = parseFloat(match[1]);
      }
    }

    let passed = false;
    if (metricValue !== undefined && config.targetValue !== undefined) {
      passed = metricValue >= config.targetValue;
    } else {
      passed = /pass|success|ok|✓|通过/i.test(stdout);
    }

    const unit = config.metricUnit ?? '';
    return {
      raw,
      metricValue,
      passed,
      summary: passed
        ? `评估通过${metricValue !== undefined ? ` (${metricValue}${unit})` : ''}`
        : `评估未通过${metricValue !== undefined ? ` (${metricValue}${unit}，目标: ≥${config.targetValue}${unit})` : ''}`,
    };
  } catch (err: any) {
    const raw = err.stdout ?? err.message ?? String(err);
    return {
      raw,
      passed: false,
      summary: `命令执行失败: ${err.message ?? err}`,
    };
  }
}

async function evaluateWithLLM(
  config: LoopConfig,
  meta: SpecMeta,
  implementation: string,
  signal?: AbortSignal,
  lang?: string,
  onText?: (chunk: string) => void,
  onLog?: (line: string) => void,
): Promise<NonNullable<LoopIteration['evaluation']>> {
  const prompts = getLoopPrompts(lang ?? 'zh');
  const prompt = prompts.loopEvalLLM(config.evalCriteria ?? config.goal, implementation);

  const r = await withRetry(
    (attempt) =>
      runPlanMode({
        cwd: meta.projectPath,
        prompt,
        permissionMode: 'plan',
        signal,
        onText,
        onLog,
        monitor: { source: 'loop', specId: meta.id, projectPath: meta.projectPath, label: 'loop: eval' },
      }),
    { signal, maxAttempts: 2 },
  );

  if (r.error || !r.text) {
    return {
      raw: r.error ?? 'empty',
      passed: false,
      summary: `评估失败: ${r.error ?? 'empty response'}`,
    };
  }

  // Try to parse structured JSON from response
  try {
    const jsonMatch = /```json\n?([\s\S]*?)\n?```/.exec(r.text)
      ?? /(\{[\s\S]*"passed"[\s\S]*\})/.exec(r.text);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        raw: r.text,
        metricValue: typeof parsed.metricValue === 'number' ? parsed.metricValue : undefined,
        passed: !!parsed.passed,
        summary: parsed.summary ?? '评估完成',
      };
    }
  } catch {
    // Fall through to keyword-based parsing
  }

  // Fallback: keyword-based
  const passed = /"passed":\s*true|PASS|通过/i.test(r.text);
  return {
    raw: r.text,
    passed,
    summary: passed ? '评估通过（非结构化输出）' : '评估未通过（非结构化输出）',
  };
}

// ─── Skill Export ─────────────────────────────────────────────────────────

export async function exportLoopAsSkill(
  meta: SpecMeta,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!meta.loop?.state.convergedOutput) {
    return { ok: false, error: 'no converged output to export' };
  }

  const { config, state } = meta.loop;
  const iterations = state.iterations;
  const n = iterations.length;

  const tableRows = iterations.map((it) => {
    const metric = it.evaluation?.metricValue !== undefined
      ? `${it.evaluation.metricValue}${config.metricUnit ?? ''}`
      : '-';
    const status = it.evaluation?.passed ? '✓ 收敛' : '✗';
    const planCol = it.plan ? '✓' : '-';
    return `| ${it.number} | ${metric} | ${status} | ${planCol} |`;
  }).join('\n');

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const content = `# Skill: ${meta.title}

> 由自主迭代循环自动生成，经过 ${n} 轮迭代收敛

## 描述
${meta.description}

## 目标
${config.goal}

## 评估标准
${config.evalCriteria ?? config.evalCommand ?? '-'}

## 实现方案

${state.convergedOutput}

## 迭代历史

| 迭代 | 指标 | 状态 | 计划 |
|------|------|------|------|
${tableRows}

## 最终指标
${state.latestMetric ?? '-'}${config.metricUnit ?? ''} (目标: ≥${config.targetValue ?? '-'}${config.metricUnit ?? ''})

## 指标趋势
${state.metricHistory.join(' → ')}

## 使用方法

<!-- 此 Skill 可被后续 Spec 引用作为上下文。将本文件放置到项目的 .sage/skills/ 目录即可在创建新 Spec 时引用。 -->

---
_Generated at ${timestamp} by Loop Engineering (Plan-then-Execute + Oscillation Detection)_
`;

  const skillDir = path.join(meta.projectPath, PROJECT_DIR, 'skills');
  const skillPath = path.join(skillDir, `${meta.id}.md`);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillPath, content, 'utf-8');

  return { ok: true, path: skillPath };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function renderSteering(s: SteeringDocs): string {
  const parts: string[] = [];
  if (s.product) parts.push(`### Product\n\n${s.product}`);
  if (s.tech) parts.push(`### Tech\n\n${s.tech}`);
  if (s.structure) parts.push(`### Structure\n\n${s.structure}`);
  if (parts.length === 0) return '';
  return `## Steering Context\n\n${parts.join('\n\n')}\n\n---\n\n`;
}
