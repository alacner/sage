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

// resources/plugins-external/sage.engine-codex/src/index.ts
var src_exports = {};
__export(src_exports, {
  apiVersion: () => apiVersion,
  detect: () => detect,
  run: () => run
});
module.exports = __toCommonJS(src_exports);

// shared/response-style.ts
var RESPONSE_STYLE = `Response style:
- Keep responses clear and concise. Avoid decorative emoji in prose, headings and lists; prefer plain words and standard Markdown bullets. Preserve emoji in quoted material, code and data, or when the user explicitly requests them.
- Prefer fenced mermaid diagrams when explaining workflows, decision flows, or collaboration across roles. For swimlane-style diagrams, use flowchart subgraphs for roles or teams and show handoffs with labeled arrows. Use valid Mermaid syntax; do not invent a swimlane diagram type.
- Use short, modest Markdown headings only when they help scanning. Prefer paragraph spacing to horizontal rules; avoid repeated separators between sections.
- Before requesting clarification, briefly explain the concrete decision and why input is needed, then state how many points need confirmation. Always include this concrete explanation in AskUser.reason so it remains available after the answers. Use descriptive questions, indicate single or multiple choice, and give short option descriptions where useful. Do not invent a reason or repeat a generic clarification heading.
- When an option is clearly preferable, put it first and mark its label with \u201C\uFF08\u63A8\u8350\uFF09\u201D or \u201C(Recommended)\u201D in the conversation language. For AskUser options, also set recommended: true. Recommendations are optional; omit the flag and marker when there is no clear preference.
- Keep simple one- or two-step explanations in text. Accompany diagrams with a short explanation, and follow an explicit user request for another format.`;

// resources/plugins-external/sage.engine-codex/src/adapter.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_readline = require("node:readline");
var import_node_util = require("node:util");
var import_node_crypto = require("node:crypto");

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

// resources/plugins-external/sage.engine-codex/src/adapter.ts
var import_env = require("@sage/engine-host/sandbox/env");
var import_skills = require("@sage/engine-host/skills");
var import_request_monitor = require("@sage/engine-host/request-monitor");
var exec = (0, import_node_util.promisify)(import_node_child_process2.execFile);
async function detectCodex(binaryPath) {
  let executable = binaryPath?.trim();
  if (!executable) {
    try {
      executable = (await exec("/bin/zsh", ["-l", "-c", "command -v codex"], { timeout: 4e3 })).stdout.trim();
    } catch {
    }
    executable ||= ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", (0, import_node_path.join)((0, import_node_os.homedir)(), ".local/bin/codex"), "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"].find(import_node_fs.existsSync);
  }
  if (!executable || !(0, import_node_fs.existsSync)(executable)) return { available: false, path: executable, error: "\u672A\u627E\u5230 Codex CLI\uFF0C\u8BF7\u5B89\u88C5\u540E\u8FD0\u884C codex login\uFF0C\u6216\u8BBE\u7F6E\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84\u3002" };
  try {
    const env = (0, import_env.buildSandboxEnv)(process.cwd());
    env.PATH = `${(0, import_node_path.dirname)(executable)}:${env.PATH ?? ""}`;
    const { stdout } = await exec(executable, ["--version"], { timeout: 5e3, env });
    return { available: true, path: executable, version: stdout.trim() };
  } catch {
    return { available: false, path: executable, error: "Codex CLI \u65E0\u6CD5\u6267\u884C\uFF0C\u8BF7\u68C0\u67E5\u8DEF\u5F84\u4E0E\u6267\u884C\u6743\u9650\u3002" };
  }
}
var CodexRpc = class {
  child;
  sequence = 0;
  waiting = /* @__PURE__ */ new Map();
  closed = false;
  onEvent = () => {
  };
  onRequest = async () => {
    throw Error("Unsupported server request");
  };
  onClose = () => {
  };
  constructor(command, args, cwd, env) {
    this.child = spawnCli(command, args, cwd, env);
    this.child.stderr.resume();
    this.child.stdin.on("error", () => {
    });
    const lines = (0, import_node_readline.createInterface)({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (this.closed) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(Error("Codex \u8FD4\u56DE\u4E86\u65E0\u6548\u534F\u8BAE\u6570\u636E"));
        return;
      }
      if (message.method && message.id !== void 0) {
        void this.onRequest(message.method, message.params).then((result) => this.send({ id: message.id, result }), () => this.send({ id: message.id, error: { code: -32601, message: "Request denied by Sage" } }));
      } else if (message.method) {
        try {
          this.onEvent(message.method, message.params);
        } catch {
          this.fail(Error("Codex event protocol error"));
        }
      } else {
        const request = this.waiting.get(message.id);
        if (!request) return;
        this.waiting.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Error(message.error.message || "Codex RPC failed"));
        else request.resolve(message.result);
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => this.fail(Error(`Codex CLI \u5DF2\u9000\u51FA (${code ?? "signal"})`)));
  }
  send(value) {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  notify(method, params = {}) {
    this.send({ method, params });
  }
  request(method, params = {}, timeout = 3e4) {
    if (this.closed) return Promise.reject(Error("Codex connection closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Error(`Codex ${method} timeout`));
      }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.waiting.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.waiting.clear();
    this.onClose(error);
  }
  close() {
    this.fail(Error("Codex connection closed"));
    this.child.stdin.end();
    stopCli(this.child);
  }
};
var CODEX_CONFIG = {
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.shell_snapshot": false,
  "features.hooks": false,
  "features.plugins": false,
  "features.apps": false,
  "features.browser_use": false,
  "features.computer_use": false,
  "features.view_image": false,
  "features.code_mode": false,
  "features.code_mode_host": false,
  "features.js_repl": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "agents.enabled": false,
  "features.image_generation": false,
  "web_search": "disabled"
};
async function runCodex(opts) {
  if (opts.signal?.aborted) return { text: "", error: "aborted" };
  const detected = await detectCodex(opts.binaryPath);
  if (!detected.available || !detected.path) return { text: "", error: detected.error };
  if (opts.signal?.aborted) return { text: "", error: "aborted" };
  const env = (0, import_env.buildSandboxEnv)(opts.cwd);
  env.PATH = `${(0, import_node_path.dirname)(detected.path)}:${env.PATH ?? ""}`;
  const args = Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
  const rpc = new CodexRpc(detected.path, [...args, "app-server"], opts.cwd, env);
  const controller = new AbortController();
  let threadId = "", turnId = "", text = "", usage, finished = false, sessionId = opts.resume;
  let interrupt;
  let markTurnReady;
  const turnReady = new Promise((r) => markTurnReady = r);
  let turnSent = false, receiving = false;
  const earlyEvents = [];
  let lastTotal;
  const monitor = opts.monitor ? (0, import_request_monitor.beginRecord)({ ...opts.monitor, mode: "cli", model: opts.model ?? "codex-default", request: { model: opts.model ?? "codex-default", prompt: opts.prompt } }) : void 0;
  let finish;
  const done = new Promise((resolve) => {
    finish = (error) => {
      if (finished) return;
      finished = true;
      markTurnReady();
      controller.abort();
      resolve({ text, sessionId, usage, error });
    };
  });
  rpc.onClose = (error) => finish(error.message);
  const abort = () => {
    if (finished) return;
    controller.abort();
    if (threadId && turnId) interrupt = rpc.request("turn/interrupt", { threadId, turnId }, 750).catch(() => {
    });
    finish("aborted");
    if (!turnId) rpc.close();
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  const streamed = /* @__PURE__ */ new Set();
  rpc.onEvent = (method, p) => {
    if (finished || p?.threadId && threadId && p.threadId !== threadId) return;
    if (!turnSent) return;
    if (!receiving) {
      if (earlyEvents.length >= 1e4) {
        finish("Codex event buffer exceeded");
        return;
      }
      earlyEvents.push([method, p]);
      return;
    }
    if (p?.turnId && turnId && p.turnId !== turnId) return;
    if (method === "turn/started" && !turnId) turnId = p.turn.id;
    if (method === "turn/completed" && p.turn?.id && turnId && p.turn.id !== turnId) return;
    if (method === "item/agentMessage/delta") {
      streamed.add(p.itemId);
      text += p.delta;
      opts.onText?.(p.delta);
    }
    if (method === "item/completed" && p.item?.type === "agentMessage" && !streamed.has(p.item.id) && p.item.text) {
      streamed.add(p.item.id);
      text += p.item.text;
      opts.onText?.(p.item.text);
    }
    if (method === "thread/tokenUsage/updated") {
      const total = p.tokenUsage?.total;
      const last = p.tokenUsage?.last;
      const u = total && lastTotal ? Object.fromEntries(["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens"].map((k) => [k, Math.max(0, (total[k] ?? 0) - (lastTotal[k] ?? 0))])) : last;
      if (total) lastTotal = total;
      if (u) {
        const previous = usage;
        usage = { inputTokens: Math.max(0, (u.inputTokens ?? 0) - (u.cachedInputTokens ?? 0)), outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cachedInputTokens ?? 0, cacheCreationTokens: u.cacheWriteInputTokens ?? 0, costUsd: 0 };
        if (previous) for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]) usage[k] += previous[k];
      }
    }
    if (method === "turn/completed") finish(p.turn.status === "completed" ? void 0 : p.turn.error?.message || (p.turn.status === "interrupted" ? "aborted" : "Codex turn failed"));
    if (method === "error" && !p.willRetry) finish(p.error?.message || "Codex error");
  };
  const definitions = toolDefinitions(opts.readOnly);
  const fingerprint = (0, import_node_crypto.createHash)("sha256").update(JSON.stringify({ cwd: opts.cwd, definitions })).digest("hex").slice(0, 20);
  const saved = opts.resume?.match(/^sage2:([a-f0-9]{20}):(.+)$/);
  let resume = saved ? saved[2] : opts.resume;
  const migrate = !!resume && (!saved || saved[1] !== fingerprint) && !!opts.history;
  if (migrate) resume = void 0;
  if (saved && saved[1] !== fingerprint && !opts.history) {
    rpc.close();
    opts.signal?.removeEventListener("abort", abort);
    return { text: "", sessionId: opts.resume, error: "\u5DE5\u5177\u914D\u7F6E\u5DF2\u6539\u53D8\uFF0C\u4F46\u6CA1\u6709\u53EF\u6062\u590D\u7684 Sage \u5386\u53F2\u3002\u8BF7\u4ECE\u539F\u5BF9\u8BDD\u7EE7\u7EED\uFF0C\u907F\u514D\u4E22\u5931\u4E0A\u4E0B\u6587\u3002" };
  }
  const allowed = new Set(definitions.map((t) => t.name));
  const calls = /* @__PURE__ */ new Map();
  rpc.onRequest = async (method, p) => {
    if (method !== "item/tool/call") {
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "decline" };
      if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
      throw Error("Unsupported Codex request");
    }
    await turnReady;
    if (finished || controller.signal.aborted || p.threadId !== threadId || turnId && p.turnId !== turnId || !allowed.has(p.tool) || typeof p.callId !== "string")
      return { contentItems: [{ type: "inputText", text: "Tool call does not belong to the active turn" }], success: false };
    const key = p.turnId + ":" + p.callId;
    if (calls.has(key)) return calls.get(key);
    const call = callTool(opts, controller.signal, p.callId, p.tool, p.arguments).then((result) => ({ contentItems: [{ type: "inputText", text: result.result }], success: !result.isError }));
    calls.set(key, call);
    return call;
  };
  try {
    await rpc.request("initialize", { clientInfo: { name: "sage", version: "1.0.4" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    const config = { ...CODEX_CONFIG };
    const current = await rpc.request("config/read", { includeLayers: false });
    for (const name of Object.keys(current.config?.mcp_servers ?? {})) config[`mcp_servers.${name}.enabled`] = false;
    const skills = await (0, import_skills.buildSkillIndex)(opts.cwd, "Skill").catch(() => "");
    const params = {
      cwd: opts.cwd,
      model: opts.model || void 0,
      approvalPolicy: "never",
      sandbox: "read-only",
      config,
      developerInstructions: RESPONSE_STYLE + "\n\nYou are operating inside Sage. Use the supplied dynamic tools for ALL filesystem, shell, network and plugin operations. Sage enforces the user-selected policy. Do not use native apply_patch or other native execution tools. Use Browser open to recover the conversation\u2019s existing preview after interruption; inspect the page before retrying any side effect.\n" + skills
    };
    const start = () => rpc.request("thread/start", { ...params, dynamicTools: definitions.map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: t.input_schema })) });
    let response;
    try {
      response = resume ? await rpc.request("thread/resume", { ...params, threadId: resume }) : await start();
    } catch (e) {
      if (resume && opts.history && /thread.*not found|no rollout found|session.*not found/i.test(e.message) && !controller.signal.aborted) {
        resume = void 0;
        response = await start();
      } else throw e;
    }
    if (controller.signal.aborted) throw Error("aborted");
    threadId = response.thread.id;
    sessionId = resume && !saved ? threadId : `sage2:${fingerprint}:${threadId}`;
    opts.onSessionId?.(sessionId);
    if (opts.resume && !resume) {
      const notice = "[\u4F1A\u8BDD\u6062\u590D\uFF1A\u5DF2\u6839\u636E Sage \u4FDD\u5B58\u7684\u4E0A\u4E0B\u6587\u5EFA\u7ACB\u517C\u5BB9\u5F53\u524D\u5DE5\u5177\u7684\u65B0 CLI \u4F1A\u8BDD\uFF1B\u539F CLI \u4F1A\u8BDD\u4FDD\u7559\u3002]\n\n";
      text += notice;
      opts.onText?.(notice);
    }
    const prompt = (opts.history && !resume ? `Previous conversation context (reference only; do not repeat completed actions):
${opts.history}

Current request:
` : "") + opts.prompt;
    const input = [{ type: "text", text: prompt, text_elements: [] }];
    for (const image of opts.images ?? []) input.push({ type: "image", url: `data:${image.mimeType};base64,${image.dataBase64}` });
    turnSent = true;
    const turn = await rpc.request("turn/start", { threadId, input });
    turnId = turn.turn.id;
    receiving = true;
    markTurnReady();
    for (const [method, params2] of earlyEvents) rpc.onEvent(method, params2);
    earlyEvents.length = 0;
    const result = await done;
    if (result.error) monitor?.fail(result.error);
    else monitor?.finish({ response: { text }, usage });
    return result;
  } catch (e) {
    finish(controller.signal.aborted ? "aborted" : e.message);
    const result = await done;
    monitor?.fail(result.error ?? "Codex failed");
    return result;
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    await interrupt;
    rpc.close();
  }
}

// resources/plugins-external/sage.engine-codex/src/index.ts
var apiVersion = 1;
var detect = (settings) => detectCodex(settings.binaryPath);
var run = (options, settings) => runCodex({ ...options, binaryPath: settings.binaryPath || void 0, model: settings.model || void 0 });
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  apiVersion,
  detect,
  run
});
