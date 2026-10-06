"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// resources/plugins-external/sage.engine-qoder/src/index.ts
var src_exports = {};
__export(src_exports, {
  apiVersion: () => apiVersion,
  detect: () => detect,
  run: () => run
});
module.exports = __toCommonJS(src_exports);

// resources/plugins-external/sage.engine-qoder/src/adapter.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_crypto = require("node:crypto");
var import_node_util = require("node:util");
var import_env = require("@sage/engine-host/sandbox/env");
var import_skills = require("@sage/engine-host/skills");
var import_request_monitor = require("@sage/engine-host/request-monitor");

// shared/response-style.ts
var RESPONSE_STYLE = `Response style:
- Keep responses clear and concise. Avoid decorative emoji in prose, headings and lists; prefer plain words and standard Markdown bullets. Preserve emoji in quoted material, code and data, or when the user explicitly requests them.
- Prefer fenced mermaid diagrams when explaining workflows, decision flows, or collaboration across roles. For swimlane-style diagrams, use flowchart subgraphs for roles or teams and show handoffs with labeled arrows. Use valid Mermaid syntax; do not invent a swimlane diagram type.
- Use short, modest Markdown headings only when they help scanning. Prefer paragraph spacing to horizontal rules; avoid repeated separators between sections.
- Before requesting clarification, briefly explain the concrete decision and why input is needed, then state how many points need confirmation. Always include this concrete explanation in AskUser.reason so it remains available after the answers. Use descriptive questions, indicate single or multiple choice, and give short option descriptions where useful. Do not invent a reason or repeat a generic clarification heading.
- When an option is clearly preferable, put it first and mark its label with \u201C\uFF08\u63A8\u8350\uFF09\u201D or \u201C(Recommended)\u201D in the conversation language. For AskUser options, also set recommended: true. Recommendations are optional; omit the flag and marker when there is no clear preference.
- Keep simple one- or two-step explanations in text. Accompany diagrams with a short explanation, and follow an explicit user request for another format.`;

// resources/plugins-external/cli-runtime.ts
var import_node_child_process = require("node:child_process");
var import_api_tool_defs = require("@sage/engine-host/api-tool-defs");
var import_api_tool_executor = require("@sage/engine-host/api-tool-executor");
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error("aborted"));
    if (signal.aborted) {
      work.catch(() => {
      });
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function spawnCli(command, args, cwd, env) {
  const child = (0, import_node_child_process.spawn)(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  child.stderr.resume();
  child.stdin.on("error", () => {
  });
  return child;
}
var stopping = /* @__PURE__ */ new WeakSet();
function stopCli(child) {
  if (stopping.has(child)) return;
  stopping.add(child);
  const kill = (signal) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
    }
  };
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), 1e3);
  timer.unref();
}
function toolDefinitions(readOnly) {
  return (0, import_api_tool_defs.getToolDefinitions)().filter((t) => !readOnly || ["Read", "Glob", "Grep", "Skill", "RecallMemory"].includes(t.name));
}
async function callTool(opts, signal, id, name, args) {
  const input = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
  delete input.__sageApproval;
  delete input.__sageWebApproval;
  if (signal.aborted) return { result: "aborted", isError: true };
  opts.onToolUse?.({ id, name, input });
  let result;
  try {
    if (name === "AskUser") {
      const normalized = (0, import_api_tool_defs.normalizeAskUserInput)(input);
      result = !normalized.question ? { result: import_api_tool_defs.ASKUSER_EMPTY_RETRY_MSG, isError: true } : opts.askUser ? { result: await abortable(opts.askUser(normalized), signal) } : { result: "AskUser is unavailable", isError: true };
    } else {
      const d = opts.canUseTool ? await abortable(opts.canUseTool(name, input, { toolUseID: id, signal, suggestions: [] }), signal) : opts.readOnly && toolDefinitions(true).some((t) => t.name === name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Tool approval is required" };
      if (signal.aborted) throw Error("aborted");
      result = d.behavior === "allow" ? await abortable((0, import_api_tool_executor.executeTool)(name, d.updatedInput ?? input, opts.cwd, signal, opts.monitor?.convId), signal) : { result: d.message || "Tool denied", isError: true };
    }
  } catch (e) {
    result = { result: e.message, isError: true };
  }
  if (!signal.aborted) opts.onToolResult?.({ id, ...result });
  return result;
}
async function settleWithin(work, ms) {
  let timer;
  try {
    await Promise.race([Promise.resolve(work).catch(() => {
    }), new Promise((r) => {
      timer = setTimeout(r, ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// resources/plugins-external/sage.engine-qoder/src/adapter.ts
var exec = (0, import_node_util.promisify)(import_node_child_process2.execFile);
var nativeImport = new Function("m", "return import(m)");
async function detectQoder(binaryPath) {
  let executable = binaryPath?.trim();
  if (!executable) {
    try {
      executable = (await exec("/bin/zsh", ["-l", "-c", "command -v qodercli || command -v qoder"], { timeout: 4e3 })).stdout.trim();
    } catch {
    }
    executable ||= [(0, import_node_path.join)((0, import_node_os.homedir)(), ".local/bin/qodercli"), (0, import_node_path.join)((0, import_node_os.homedir)(), ".qoder/entry/qoder"), "/opt/homebrew/bin/qodercli", "/usr/local/bin/qodercli"].find(import_node_fs.existsSync);
  }
  if (!executable || !(0, import_node_fs.existsSync)(executable)) return { available: false, error: "\u672A\u627E\u5230 Qoder CLI\uFF0C\u8BF7\u5B89\u88C5\u5E76\u8FD0\u884C qodercli login\uFF0C\u6216\u8BBE\u7F6E\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84\u3002" };
  try {
    const env = (0, import_env.buildSandboxEnv)(process.cwd());
    env.PATH = (0, import_node_path.dirname)(executable) + ":" + (env.PATH ?? "");
    const { stdout } = await exec(executable, ["--version"], { env, timeout: 5e3 });
    const { stdout: help } = await exec(executable, ["--help"], { env, timeout: 5e3 });
    if (!["--tools", "--strict-mcp-config", "--setting-sources"].every((f) => help.includes(f))) throw Error("Unsupported CLI");
    return { available: true, path: executable, version: stdout.trim() };
  } catch {
    return { available: false, path: executable, error: "Qoder CLI \u65E0\u6CD5\u8FD0\u884C\u6216\u7248\u672C\u4E0D\u652F\u6301\u5B89\u5168\u5DE5\u5177\u9694\u79BB\uFF0C\u8BF7\u5347\u7EA7 CLI\u3002" };
  }
}
async function runQoder(opts, loadModule = nativeImport) {
  if (opts.signal?.aborted) return { text: "", error: "aborted" };
  const controller = new AbortController(), sdkController = new AbortController();
  let interrupt;
  let q, child;
  let text = "", receivedText = false, sessionId = opts.resume, usage;
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    interrupt = settleWithin(Promise.resolve().then(() => q?.interrupt()), 500).finally(() => {
      sdkController.abort();
      if (child) stopCli(child);
    });
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  const rec = opts.monitor ? (0, import_request_monitor.beginRecord)({ ...opts.monitor, mode: "cli", model: opts.model || "qoder-default", request: { prompt: opts.prompt } }) : void 0;
  try {
    const detected = await abortable(detectQoder(opts.binaryPath), controller.signal);
    if (!detected.available || !detected.path) throw Error(detected.error);
    const [sdk, { z }] = await abortable(Promise.all([loadModule("@qoder-ai/qoder-agent-sdk"), loadModule("zod")]), controller.signal);
    let resume = opts.resume;
    if (resume && !await abortable(sdk.getSessionInfo(resume, { dir: opts.cwd }), controller.signal)) {
      if (!opts.history) throw Error("Qoder \u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u4E14\u6CA1\u6709 Sage \u5386\u53F2\u53EF\u6062\u590D\u3002\u8BF7\u4ECE\u539F\u5BF9\u8BDD\u7EE7\u7EED\u3002");
      resume = void 0;
      sessionId = void 0;
      const notice = "[\u4F1A\u8BDD\u6062\u590D\uFF1AQoder \u672C\u5730\u4F1A\u8BDD\u5DF2\u4E0D\u5B58\u5728\uFF0C\u5DF2\u4F7F\u7528 Sage \u4FDD\u5B58\u7684\u6587\u5B57\u548C\u5DE5\u5177\u8BB0\u5F55\u91CD\u5EFA\u4E0A\u4E0B\u6587\u3002]\n\n";
      text += notice;
      opts.onText?.(notice);
    }
    const defs = toolDefinitions(opts.readOnly);
    const calls = /* @__PURE__ */ new Map();
    const tools = defs.map((d) => sdk.tool(d.name, d.description, z.fromJSONSchema(d.input_schema).shape, async (args, extra) => {
      const id = extra?.requestId !== void 0 ? String(extra.requestId) : (0, import_node_crypto.randomUUID)();
      if (calls.has(id)) return calls.get(id);
      const signal = extra?.signal ? AbortSignal.any([controller.signal, extra.signal]) : controller.signal;
      const call = callTool(opts, signal, id, d.name, args).then((result) => ({ content: [{ type: "text", text: result.result }], isError: !!result.isError }));
      calls.set(id, call);
      return call;
    }));
    const env = (0, import_env.buildSandboxEnv)(opts.cwd);
    env.PATH = (0, import_node_path.dirname)(detected.path) + ":" + (env.PATH ?? "");
    const skills = await abortable((0, import_skills.buildSkillIndex)(opts.cwd, "mcp__sage__Skill").catch(() => ""), controller.signal);
    const prompt = (opts.history && !resume ? `Previous conversation context (reference only; do not repeat completed actions):
${opts.history}

Current request:
` : "") + opts.prompt;
    async function* input() {
      yield { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }, ...(opts.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.dataBase64 } }))] }, parent_tool_use_id: null, session_id: sessionId ?? "" };
    }
    q = sdk.query({ prompt: input(), options: {
      auth: sdk.qodercliAuth(),
      cwd: opts.cwd,
      pathToQoderCLIExecutable: detected.path,
      env,
      model: opts.model || void 0,
      resume,
      abortController: sdkController,
      closeGraceMs: 500,
      controlRequestTimeoutMs: 3e4,
      tools: [],
      skills: [],
      settingSources: [],
      plugins: [],
      strictMcpConfig: true,
      permissionMode: "default",
      includePartialMessages: true,
      mcpServers: { sage: sdk.createSdkMcpServer({ name: "sage", version: "1.0.0", tools }) },
      // Only these transport tools are preapproved; each handler still enforces Sage approval.
      allowedTools: defs.map((d) => "mcp__sage__" + d.name),
      canUseTool: async () => ({ behavior: "deny", message: "Use Sage tools" }),
      systemPrompt: { type: "preset", preset: "qodercli", append: RESPONSE_STYLE + "\nUse only mcp__sage__ tools for all work. Browser opens this conversation\u2019s live preview; reuse open to recover its page after interruption, inspect before retrying an action, and verify visual criteria. Never repeat a side effect just because a turn was interrupted.\n" + skills },
      spawnQoderCLIProcess: (s) => {
        if (controller.signal.aborted) throw Error("aborted");
        child = spawnCli(s.command, s.args, s.cwd ?? opts.cwd, s.env);
        return child;
      }
    } });
    let partial = false, sawResult = false;
    const seen = /* @__PURE__ */ new Set();
    const iterator = q[Symbol.asyncIterator]();
    while (true) {
      const next = await abortable(iterator.next(), controller.signal);
      if (next.done) break;
      const msg = next.value;
      if (controller.signal.aborted) throw Error("aborted");
      if (msg.isReplay) continue;
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        sessionId = msg.session_id;
        opts.onSessionId?.(sessionId);
      }
      if (msg.type === "stream_event") {
        if (msg.event?.type === "message_start") partial = false;
        const delta = msg.event?.delta;
        if (delta?.type === "text_delta" && delta.text) {
          partial = true;
          receivedText = true;
          text += delta.text;
          opts.onText?.(delta.text);
        }
      }
      if (msg.type === "assistant" && !seen.has(msg.uuid ?? msg.message?.id)) {
        seen.add(msg.uuid ?? msg.message?.id);
        if (!partial) {
          const chunk = (msg.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
          text += chunk;
          if (chunk) {
            receivedText = true;
            opts.onText?.(chunk);
          }
        }
        partial = false;
      }
      if (msg.type === "result") {
        sawResult = true;
        sessionId = msg.session_id || sessionId;
        if (sessionId) opts.onSessionId?.(sessionId);
        const u = msg.usage;
        if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0, costUsd: 0 };
        if (msg.is_error || msg.subtype !== "success") throw Error((msg.errors ?? []).join("\n") || msg.result || "Qoder turn failed");
        if (!receivedText && msg.result) {
          text += msg.result;
          opts.onText?.(msg.result);
        }
        break;
      }
    }
    if (controller.signal.aborted) throw Error("aborted");
    if (!sawResult) throw Error("Qoder \u5728\u8FD4\u56DE\u5B8C\u6210\u4E8B\u4EF6\u524D\u9000\u51FA\uFF1B\u4FDD\u7559\u5F53\u524D\u4F1A\u8BDD\uFF0C\u68C0\u67E5 CLI \u767B\u5F55\u72B6\u6001\u540E\u7EE7\u7EED\u3002");
    rec?.finish({ response: { text, sessionId }, usage });
    return { text, sessionId, usage };
  } catch (e) {
    const error = controller.signal.aborted ? "aborted" : String(e.message ?? e);
    rec?.fail(error);
    return { text, sessionId, usage, error };
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    controller.abort();
    await interrupt;
    await settleWithin(Promise.resolve().then(() => q?.close()), 1500);
    sdkController.abort();
    if (child) stopCli(child);
  }
}

// resources/plugins-external/sage.engine-qoder/src/index.ts
var apiVersion = 1;
var detect = (settings) => detectQoder(settings.binaryPath);
var run = (options, settings) => runQoder({ ...options, binaryPath: settings.binaryPath || void 0, model: settings.model || void 0 });
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  apiVersion,
  detect,
  run
});
