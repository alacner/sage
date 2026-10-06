import { validateDesktopRelayCertificate } from './relay-tls';
import { validModelTimeRanges } from '../shared/model-availability';
import {dataRetention,validateDataRetention} from '../shared/data-retention';
import {BUILTIN_THEMES, migrateGreenTheme} from '../shared/appearance';
import {findShortcutDef,isValidAccelerator,isFnAccelerator} from '../shared/shortcuts';
import {cleanupHistory} from './data-retention';
import {validateDateTime} from '../shared/date-time';
import { validateSecurityProfiles } from '../shared/security-profiles';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { policyUnion, exportProtection } from '../shared/settings-protection';
import type { AppSettings } from '../shared/types';
import { validateRuntimeConfig } from '../shared/runtime-config';
import { validApiUserAgentCustom } from '../shared/api-user-agent';
import { validateMobileProjectDirectories } from './mobile-project-creation';

export function validateSettings(value: any): asserts value is AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是对象');
  if (value.relayCertificate !== undefined) validateDesktopRelayCertificate(value.relayCertificate);
  if (value.mobileProjectDirectories !== undefined) validateMobileProjectDirectories(value.mobileProjectDirectories);
  if (value.builtinPluginActivation !== undefined) {
    const object=(v:any)=>v && typeof v==='object' && !Array.isArray(v);
    const activation=value.builtinPluginActivation;
    if(activation?.installed!==undefined&&(!Array.isArray(activation.installed)||activation.installed.some((id:unknown)=>!['specs','docs'].includes(id as string))))throw Error('可选插件安装配置无效');
    if(!object(activation)||activation.global!==undefined&&(!object(activation.global)||Object.values(activation.global).some(v=>typeof v!=='boolean'))||activation.projects!==undefined&&(!object(activation.projects)||Object.values(activation.projects).some(v=>!object(v)||Object.values(v as object).some(mode=>!['inherit','enabled','disabled'].includes(mode as string)))))throw Error('内置插件启用配置无效');
  }
  if (value.projectPluginSettings !== undefined) {
    const object=(v:any)=>v && typeof v==='object' && !Array.isArray(v);
    const prim=(v:any)=>typeof v==='string'||typeof v==='number'||typeof v==='boolean';
    const pps=value.projectPluginSettings;
    if(!object(pps)||Object.values(pps).some(byPlugin=>!object(byPlugin)||Object.values(byPlugin as object).some(byKey=>!object(byKey)||Object.values(byKey as object).some(v=>!prim(v)))))throw Error('项目级插件配置无效');
  }
  if (value.pluginSecrets !== undefined) {
    const object=(v:any)=>v && typeof v==='object' && !Array.isArray(v);
    if(!object(value.pluginSecrets)||Object.keys(value.pluginSecrets).length>500||Object.entries(value.pluginSecrets).some(([id,fields]:[string,any])=>! /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(id)||!object(fields)||Object.keys(fields).length>200||Object.entries(fields).some(([key,secret]:[string,any])=>!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key)||typeof secret!=='string'||secret.length>1024*1024)))throw Error('外置插件密钥配置无效');
  }
  if (value._schemaVersion !== undefined && value._schemaVersion !== 1) throw Object.assign(new Error('配置来自不受支持的新版本，已停止读写'), {code:'SETTINGS_FUTURE'});
  if (value.securityProfiles !== undefined) validateSecurityProfiles(value.securityProfiles);
  if (value.defaultSecurityProfileId !== undefined && typeof value.defaultSecurityProfileId !== 'string') throw Error('默认安全方案无效');
  if (value.securityProfiles?.some((p: any)=>p.id===(value.defaultSecurityProfileId??'manual') && p.enabled===false)) throw Error('请先将默认项移到其它方案，再禁用该方案');
  if(value.dataRetention!==undefined)validateDataRetention(value.dataRetention);
  // MCP 服务器列表：名称唯一，按 transport 校验各自必填项；env/header 值只允许字符串
  if (value.mcpServers !== undefined) {
    const obj=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
    const strMap=(v:any)=>obj(v)&&Object.values(v).every(x=>typeof x==='string'&&x.length<=4096);
    if(!Array.isArray(value.mcpServers)||value.mcpServers.length>50)throw Error('MCP 服务器列表无效（最多 50 个）');
    const mcpNames=new Set<string>();
    for(const s of value.mcpServers as any[]){
      if(!obj(s)||typeof s.id!=='string'||!s.id)throw Error('MCP 服务器定义无效');
      if(typeof s.name!=='string'||!s.name.trim()||s.name.length>64||mcpNames.has(s.name))throw Error(`MCP 服务器名称无效或重复：${s.name??''}`);
      mcpNames.add(s.name);
      if(typeof s.enabled!=='boolean'||!['stdio','http'].includes(s.transport))throw Error(`MCP 服务器 ${s.name} 开关或类型无效`);
      if(s.transport==='stdio'){
        if(typeof s.command!=='string'||!s.command.trim())throw Error(`MCP 服务器 ${s.name} 启动命令必填`);
        if(s.args!==undefined&&(!Array.isArray(s.args)||s.args.length>64||s.args.some((a:any)=>typeof a!=='string')))throw Error(`MCP 服务器 ${s.name} 参数无效`);
        if(s.env!==undefined&&!strMap(s.env))throw Error(`MCP 服务器 ${s.name} 环境变量无效`);
        if(s.envPassThrough!==undefined&&(!Array.isArray(s.envPassThrough)||s.envPassThrough.some((x:any)=>typeof x!=='string')))throw Error(`MCP 服务器 ${s.name} 环境传递无效`);
        if(s.cwd!==undefined&&typeof s.cwd!=='string')throw Error(`MCP 服务器 ${s.name} 工作目录无效`);
      }else{
        if(typeof s.url!=='string'||!/^https?:\/\/.+/.test(s.url))throw Error(`MCP 服务器 ${s.name} URL 必须是 http(s) 地址`);
        if(s.bearerTokenEnv!==undefined&&typeof s.bearerTokenEnv!=='string')throw Error(`MCP 服务器 ${s.name} Bearer 环境变量无效`);
        if(s.headers!==undefined&&!strMap(s.headers))throw Error(`MCP 服务器 ${s.name} 标头无效`);
        if(s.headersFromEnv!==undefined&&!strMap(s.headersFromEnv))throw Error(`MCP 服务器 ${s.name} 来自环境变量的标头无效`);
      }
    }
  }
  if (value.mcpEnvironmentVariables !== undefined) {
    const vars = value.mcpEnvironmentVariables;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars) || Object.keys(vars).length > 64) throw Error('MCP 密钥环境变量无效（最多 64 个）');
    for (const [name, secret] of Object.entries(vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof secret !== 'string' || secret.length > 16384 || !secret.trim()) throw Error(`MCP 环境变量 ${name} 无效`);
    }
  }
  if(value.fileBrowserHiddenDirectories!==undefined && (!Array.isArray(value.fileBrowserHiddenDirectories)||value.fileBrowserHiddenDirectories.length>200||value.fileBrowserHiddenDirectories.some((s:any)=>typeof s!=='string'||!s.trim()||s.length>255||s==='.'||s==='..'||/[\\/*?\x00]/.test(s))))throw Error('Invalid hidden directory names');
  if(value.runtimeConfig!==undefined)validateRuntimeConfig(value.runtimeConfig);
  if(value.dateTime!==undefined)validateDateTime(value.dateTime);
  for (const key of ['modelAutoVerifyEnabled', 'autoCheckUpdates', 'autoInstallUpdates', 'systemNotifications', 'petEnabled', 'hooksEnabled']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw Error(`${key} 必须是布尔值`);
  }
  const enums: Record<string, string[]> = {
    language: ['zh','en','system'], apiProtocol: ['anthropic','openai'],
    apiUserAgentPreset: ['sage','claude-cli','codex-cli','custom'],
    preferredBackend: ['auto','cli','api','codex'], permissionMode: ['plan','default','acceptEdits','bypassPermissions'],
    markdownDefaultView: ['preview','source'],
    petConversationMode: ['continuous','new-each'],
    petStyle: ['pixel','comic','dog-pixel','dog-comic','none'],
  };
  for (const [key, allowed] of Object.entries(enums)) if (value[key] !== undefined && !allowed.includes(value[key])) throw new Error(`${key} 值无效`);
  if (value.apiUserAgentCustom !== undefined && !validApiUserAgentCustom(value.apiUserAgentCustom)) throw new Error('User-Agent must contain at most 512 printable ASCII characters');
  // theme：内置三档 + 内置扩展主题（BUILTIN_THEMES，如养眼绿）或自定义主题 id（user- 前缀）
  if (value.theme !== undefined && !['light','dark','system', ...BUILTIN_THEMES.map((d) => d.id)].includes(value.theme) && !/^user-[A-Za-z0-9_-]{1,64}$/.test(value.theme)) throw new Error('theme 值无效');
  if (value.themes !== undefined) {
    if (!Array.isArray(value.themes) || value.themes.length > 20) throw new Error('主题列表无效（最多 20 个）');
    const seen = new Set<string>();
    for (const item of value.themes as any[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('主题定义无效');
      if (typeof item.id !== 'string' || !/^user-[A-Za-z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)) throw new Error('主题 ID 无效');
      seen.add(item.id);
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 64) throw new Error(`主题名称无效：${item.id}`);
      if (!['light','dark'].includes(item.base)) throw new Error(`主题基色无效：${item.id}`);
      if (item.colors !== undefined && (typeof item.colors !== 'object' || item.colors === null || Array.isArray(item.colors) || Object.values(item.colors).some((c) => typeof c !== 'string' || c.length > 64))) throw new Error(`主题配色无效：${item.id}`);
    }
  }
  // 内置扩展主题微调层：只允许内置 id，配色值与 themes.colors 同标准
  if (value.builtinThemeOverrides !== undefined) {
    if (typeof value.builtinThemeOverrides !== 'object' || value.builtinThemeOverrides === null || Array.isArray(value.builtinThemeOverrides)) throw new Error('内置主题微调无效');
    for (const [id, colors] of Object.entries(value.builtinThemeOverrides as Record<string, any>)) {
      if (!BUILTIN_THEMES.some((d) => d.id === id)) throw new Error(`内置主题微调 id 无效：${id}`);
      if (!colors || typeof colors !== 'object' || Array.isArray(colors) || Object.values(colors).some((c) => typeof c !== 'string' || c.length > 64)) throw new Error(`内置主题微调配色无效：${id}`);
    }
  }
  if (value.shortcuts !== undefined) {
    if (typeof value.shortcuts !== 'object' || value.shortcuts === null || Array.isArray(value.shortcuts)) throw new Error('快捷键配置无效');
    for (const [id, accel] of Object.entries(value.shortcuts as Record<string, any>)) {
      if (!findShortcutDef(id)) throw new Error(`快捷键 id 无效：${id}`);
      if (accel !== null && !isValidAccelerator(accel)) throw new Error(`快捷键格式无效：${accel}`);
      if (isFnAccelerator(accel) && id !== 'voiceHold' && id !== 'voiceToggle') throw new Error('Fn 快捷键仅用于语音输入');
    }
  }
  for (const key of ['expertsMaxParallel','maxImageMB','maxTextFileMB','contextWindowSize']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) throw new Error(`${key} 必须是非负数`);
  }
  if (value.expertDefinitions !== undefined) {
    const definitions = value.expertDefinitions;
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error('专家团定义必须是对象');
    for (const [id, definition] of Object.entries(definitions as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error(`专家角色 ID 无效：${id}`);
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`专家角色定义无效：${id}`);
      const item = definition as Record<string, unknown>;
      for (const field of ['name', 'desc', 'promptBody']) {
        if (typeof item[field] !== 'string' || !item[field].trim()) throw new Error(`专家角色 ${id} 的 ${field} 不能为空`);
      }
      if (!Array.isArray(item.humanNames) || item.humanNames.length < 1 || item.humanNames.length > 12 || item.humanNames.some((name) => typeof name !== 'string' || !name.trim())) {
        throw new Error(`专家角色 ${id} 的成员名称无效`);
      }
      if (item.icon !== undefined && typeof item.icon !== 'string') throw new Error(`专家角色 ${id} 的 icon 类型错误`);
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error(`专家角色 ${id} 的启用状态无效`);
    }
  }
  if (value.contextStrategy !== undefined) {
    const c = value.contextStrategy;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('上下文策略无效');
    if (c.mode !== undefined && !['auto','conservative','balanced','aggressive'].includes(c.mode)) throw new Error('上下文模式无效');
    if(c.extension!==undefined&&(typeof c.extension!=='string'||c.extension.length>180))throw Error('压缩扩展标识无效');
    if (c.summaryStrategy !== undefined && !['auto','truncate','llm'].includes(c.summaryStrategy)) throw new Error('摘要策略无效');
    for (const key of ['keepRecentTurns','maxTokens','maxBodyChars']) if (c[key] !== undefined && (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || c[key] < 0)) throw new Error('上下文预算无效');
  }
  const walk = (v: any, depth = 0) => {
    if (depth > 40) throw new Error('配置嵌套过深');
    if (v && typeof v === 'object') for (const k of Object.keys(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('配置包含非法字段');
      walk(v[k], depth + 1);
    }
  };
  walk(value);
  for (const field of ['modelProviders', 'modelProfiles']) {
    if (value[field] === undefined) continue;
    if (!Array.isArray(value[field])) throw new Error(`${field} 必须是数组`);
    const ids = new Set();
    for (const p of value[field]) {
      if (!p || typeof p.id !== 'string' || !p.id || ['__proto__','constructor','prototype'].includes(p.id) || ids.has(p.id)) throw new Error('提供商 ID 缺失或重复');
      ids.add(p.id);
      for (const key of ['name', 'apiKey', 'baseUrl']) if (p[key] !== undefined && typeof p[key] !== 'string') throw new Error('提供商字段类型错误');
      if (p.protocol !== undefined && !['anthropic', 'openai'].includes(p.protocol)) throw new Error('无效 API 协议');
      if (field === 'modelProviders' && (!Array.isArray(p.models) || p.models.some((m: any) => typeof m !== 'string'))) throw new Error('模型列表无效');
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error('提供商启用状态无效');
      if (p.kind !== undefined && !['normal','composite','relay'].includes(p.kind)) throw new Error('提供商类型无效');
      if(p.routingExtension!==undefined&&(typeof p.routingExtension!=='string'||!/^[-a-z0-9.]+\/[A-Za-z][A-Za-z0-9_.-]*$/.test(p.routingExtension)||p.routingExtension.length>180))throw Error('模型路由扩展标识无效');
      if (p.kind === 'relay' && (!Array.isArray(p.relayModels) || p.relayModels.some((m: any) => !m || typeof m.id !== 'string' || typeof m.name !== 'string' || !['openai','anthropic'].includes(m.protocol)))) throw new Error('中继模型定义无效');
      if (p.composite !== undefined) {
        if (!p.composite || !Array.isArray(p.composite.members)) throw new Error('复合提供商成员无效');
        for (const member of p.composite.members) {
          if (!member || typeof member.providerId !== 'string' || (member.weight !== undefined && (typeof member.weight !== 'number' || !Number.isFinite(member.weight)))) throw new Error('复合提供商成员字段无效');
          if (member.modelMappings !== undefined && (!Array.isArray(member.modelMappings) || member.modelMappings.some((m: any) => !m || typeof m.compositeModel !== 'string' || typeof m.memberModel !== 'string'))) throw new Error('模型映射无效');
          for (const mapping of member.modelMappings ?? []) {
            if (mapping.activeTimeRanges !== undefined && (typeof mapping.activeTimeRanges !== 'string' || !validModelTimeRanges(mapping.activeTimeRanges))) throw new Error('模型生效时间格式无效，请使用 HH:mm-HH:mm 或 YYYY/MM/DD-YYYY/MM/DD，以逗号分隔多个时段或日期范围');
            if (mapping.fallbackModel !== undefined && (typeof mapping.fallbackModel !== 'string' || !mapping.fallbackModel.trim() || !mapping.activeTimeRanges)) throw new Error('替代模型必须填写，且需要配置生效时间段');
          }
        }
      }
    }
  }
  for (const key of ['anthropicApiKey','anthropicBaseUrl','relayToken','relayWebhookToken','relayUrl','relayHookBaseUrl','backendEngine', 'claudeBinaryPath','codexBinaryPath','codexModel','updateServerUrl','pluginMarketUrl','feedbackServerUrl','model','visionModel','voiceInputDeviceId','_revision']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${key} 类型错误`);
  }
  for (const key of ['preventSleep','autoCheckUpdates','relayEnabled','showLineNumbers','autoApproveProjectScope']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`${key} 类型错误`);
  }
  for (const selected of [value.selectedModel, value.selectedVisionModel, value.memoryModel, value.contextStrategy?.summaryModel]) {
    if (selected !== undefined && (!selected || typeof selected.providerId !== 'string' || typeof selected.modelId !== 'string' || (selected.followDefault !== undefined && typeof selected.followDefault !== 'boolean') || (selected.thinkingEffort !== undefined && !['off','low','medium','xhigh'].includes(selected.thinkingEffort)))) throw new Error('模型选择无效');
  }
  if (value._secretPolicy !== undefined) {
    for (const key of ['providers','profiles']) {
      const entries = value._secretPolicy?.[key];
      if (entries !== undefined && (!entries || typeof entries !== 'object' || Array.isArray(entries))) throw new Error('提供商保护策略无效');
      for (const policy of Object.values(entries ?? {}) as any[]) if (!policy || typeof policy.apiKey !== 'boolean' || typeof policy.apiHost !== 'boolean') throw new Error('字段保护策略无效');
    }
  }
  if (value._secretPolicy !== undefined && (!value._secretPolicy || typeof value._secretPolicy.apiKey !== 'boolean' || typeof value._secretPolicy.apiHost !== 'boolean')) throw new Error('敏感字段策略无效');
}

function checksum(value: any) {
  const { _integrity, ...data } = value;
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function parseSettings(raw: string): AppSettings {
  const value = JSON.parse(raw);
  validateSettings(value);
  if (value._integrity !== undefined && value._integrity !== checksum(value)) throw new Error('配置校验和不匹配');
  return migrateGreenTheme(value);
}

/** One writer per userData (Electron single instance lock), serial transactions within it. */
export class SettingsRepository {
  private lastVersion = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, private encode: (s: AppSettings) => AppSettings, private decode: (s: AppSettings) => AppSettings) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async versions(): Promise<string[]> {
    try { return (await fs.readdir(`${this.file}.history`)).filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n)).sort().reverse(); }
    catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  }
  private async load(): Promise<AppSettings> {
    let disk: AppSettings;
    try { disk = parseSettings(await fs.readFile(this.file, 'utf8')); }
    catch (primary: any) {
      if (primary.code && primary.code !== 'ENOENT') throw new Error('配置读取失败，已停止写入');
      const versions = await this.versions();
      const candidates = [...versions.map(n => path.join(`${this.file}.history`, n)), `${this.file}.bak`];
      let backupExists = false;
      for (const candidate of candidates) {
        let parsed: AppSettings;
        try { parsed = parseSettings(await fs.readFile(candidate, 'utf8')); }
        catch (e: any) { if (e.code !== 'ENOENT') backupExists = true; continue; }
        // Decryption errors are NOT corruption recovery: never roll credentials back for a locked keychain.
        return { ...this.decode(parsed), _recovery: '主配置缺失或损坏，当前使用历史版本；原文件已保留。保存前请核对模型。' };
      }
      if (primary.code === 'ENOENT' && !backupExists && !versions.length) return { _revision: 'initial' };
      throw new Error('配置与历史版本均不可恢复，已停止写入；请导入加密备份');
    }
    return this.decode(disk);
  }
  read() { return this.serial(() => this.load()); }
  private async atomic(file: string, data: string) {
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const h = await fs.open(tmp, 'wx', 0o600);
      try { await h.writeFile(data, 'utf8'); await h.sync(); } finally { await h.close(); }
      await fs.rename(tmp, file);
      const dir = await fs.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await fs.rm(tmp, { force: true }); }
  }
  private versionName() {
    this.lastVersion = Math.max(Date.now(), this.lastVersion + 1);
    return `${this.lastVersion}-${crypto.randomUUID()}.json`;
  }
  private async commit(next: AppSettings): Promise<AppSettings> {
    next = migrateGreenTheme(next);
    validateSettings(next);
    if ((next.modelProviders??[]).filter(p=>p.kind==='relay').length>1) throw Error('只能存在一个中继提供商');
    const clean = { ...next, _schemaVersion: 1, _revision: crypto.randomUUID() };
    delete clean._recovery;
    delete clean._systemLocale;
    delete clean._integrity;
    const encoded = this.encode(structuredClone(clean)); // Encryption must succeed before ANY disk mutation.
    encoded._integrity = checksum(encoded);
    const json = JSON.stringify(encoded, null, 2);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.mkdir(`${this.file}.history`, { recursive: true, mode: 0o700 });
    // Preserve the exact prior file, including damaged evidence. Never overwrite a good .bak with bad data.
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      let preserved = raw;
      let extension = '';
      try {
        const old = parseSettings(raw);
        // Encrypt legacy plaintext before placing it into a new history snapshot.
        preserved = JSON.stringify(this.encode(structuredClone(old)), null, 2);
        // Encryption changes the bytes; remove the old checksum and recalculate it.
        const protectedOld = JSON.parse(preserved);
        protectedOld._integrity = checksum(protectedOld);
        preserved = JSON.stringify(protectedOld, null, 2);
      } catch { extension = '.corrupt'; } // Preserve exact unreadable evidence, never delete it.
      await this.atomic(path.join(`${this.file}.history`, this.versionName() + extension), preserved);
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    await this.atomic(this.file, json);
    // Keep a verified copy of the new revision too (including the very first save).
    // The commit already succeeded; a snapshot failure is a warning, not a false save failure.
    try { await this.atomic(path.join(`${this.file}.history`, this.versionName()), json); }
    catch { clean._recovery = '配置已保存，但本次历史快照创建失败；请立即导出备份。'; }
    try {
      const retention=dataRetention(clean.dataRetention);
      await cleanupHistory(`${this.file}.history`,retention.settingsHistoryDays,retention.settingsHistoryCount,value=>{try{parseSettings(JSON.stringify(value));return true;}catch{return false;}});
      await cleanupHistory(path.join(path.dirname(this.file),'projects.json.history'),retention.projectsHistoryDays,retention.projectsHistoryCount,value=>Array.isArray(value)&&value.every(p=>p&&typeof p.path==='string'));
    } catch(error) {console.warn('[history] cleanup failed',error);}
    return clean;
  }
  update(change: (cur: AppSettings) => AppSettings, expected?: string) {
    return this.serial(async () => {
      const cur = await this.load();
      if (expected !== undefined && expected !== (cur._revision ?? 'legacy')) throw Object.assign(new Error('配置已被其他窗口修改；请保留草稿并重新加载后再保存'), { code: 'SETTINGS_CONFLICT' });
      return this.commit(change(structuredClone(cur)));
    });
  }
  replaceFromBackup(incoming: AppSettings, expected?: string) {
    return this.serial(async () => {
      let cur: AppSettings;
      try { cur = await this.load(); }
      catch {
        if (expected !== undefined) throw new Error('配置状态已变化，导入已停止');
        // Recovery from an authenticated portable backup: preserve the broken file in commit.
        return this.commit({ ...incoming, _secretPolicy: exportProtection(incoming, { apiKey: true, apiHost: true }) });
      }
      if (expected === undefined || expected !== (cur._revision ?? 'legacy')) throw new Error('配置状态已变化，请重新导入');
      return this.commit({ ...incoming, _secretPolicy: policyUnion(cur._secretPolicy, incoming._secretPolicy) });
    });
  }
  preview(name: string) {
    return this.serial(async () => {
      if (!(await this.versions()).includes(name)) throw new Error('历史版本不存在');
      const current = await this.load();
      const version = this.decode(parseSettings(await fs.readFile(path.join(`${this.file}.history`, name), 'utf8')));
      return { current, version };
    });
  }
  restore(name: string, expected: string) {
    return this.serial(async () => {
      if (!(await this.versions()).includes(name)) throw new Error('历史版本不存在');
      const cur = await this.load();
      if (expected !== (cur._revision ?? 'legacy')) throw new Error('配置版本已变化，请刷新');
      const old = this.decode(parseSettings(await fs.readFile(path.join(`${this.file}.history`, name), 'utf8')));
      // A restore must never remove an existing use-only policy.
      old._secretPolicy = policyUnion(cur._secretPolicy, old._secretPolicy);
      return this.commit(old);
    });
  }
}
