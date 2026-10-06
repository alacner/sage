import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, Settings2, Trash2, Unplug, Zap } from 'lucide-react';
import { resolveLanguage } from '../../shared/language';
import { useAppStore } from '../stores/appStore';
import type { McpServerEntry } from '../../shared/types';
import {parseMcpConfig,exportMcpConfig} from '../../shared/mcp-config';
import { PROTECTED } from '../../shared/settings-protection';

/**
 * MCP 管理（设置 → MCP 服务器）：服务器列表（启停开关）+ 自定义服务器编辑表单，
 * 支持 STDIO（启动命令/参数/环境变量/环境传递/工作目录）与流式 HTTP
 * （URL/Bearer 环境变量/标头/来自环境变量的标头）两种传输。
 * 数据持久化在 AppSettings.mcpServers（加密 settings 仓库，可随备份迁移）；
 * 「测试连接」走 mcp:test IPC 实际建立会话拉工具列表。
 * 注意：本期为管理面板；对话引擎注入（--mcp-config）后续接入。
 */

type Pair = { key: string; value: string };
const toPairs = (rec?: Record<string, string>): Pair[] => Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));
const fromPairs = (pairs: Pair[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.key.trim()) out[p.key.trim()] = p.value;
  return out;
};
const newId = () => `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 编辑表单的本地草稿：pairs 以数组形态维护，保存时转回 record。 */
interface Draft {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Pair[];
  envPassThrough: string[];
  cwd: string;
  url: string;
  bearerTokenEnv: string;
  headers: Pair[];
  headersFromEnv: Pair[];
}

const entryToDraft = (e: McpServerEntry): Draft => ({
  id: e.id, name: e.name, enabled: e.enabled, transport: e.transport,
  command: e.command ?? '', args: e.args ?? [], env: toPairs(e.env), envPassThrough: e.envPassThrough ?? [], cwd: e.cwd ?? '',
  url: e.url ?? '', bearerTokenEnv: e.bearerTokenEnv ?? '', headers: toPairs(e.headers), headersFromEnv: toPairs(e.headersFromEnv),
});

const draftToEntry = (d: Draft): McpServerEntry => {
  const base: McpServerEntry = { id: d.id, name: d.name.trim(), enabled: d.enabled, transport: d.transport };
  if (d.transport === 'stdio') {
    return { ...base, command: d.command.trim(), ...(d.args.length ? { args: d.args } : {}), ...(d.env.some(p => p.key.trim()) ? { env: fromPairs(d.env) } : {}), ...(d.envPassThrough.length ? { envPassThrough: d.envPassThrough } : {}), ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}) };
  }
  return { ...base, url: d.url.trim(), ...(d.bearerTokenEnv.trim() ? { bearerTokenEnv: d.bearerTokenEnv.trim() } : {}), ...(d.headers.some(p => p.key.trim()) ? { headers: fromPairs(d.headers) } : {}), ...(d.headersFromEnv.some(p => p.key.trim()) ? { headersFromEnv: fromPairs(d.headersFromEnv) } : {}) };
};

export function McpServersSettings() {
  const settings = useAppStore(s => s.settings);
  const english = resolveLanguage(settings?.language,settings?._systemLocale) === 'en';
  const copy = (zh: string, en: string) => (english ? en : zh);
  const servers = settings?.mcpServers ?? [];
  const [envRows, setEnvRows] = useState<Array<{name:string;value:string;savedName?:string}>>([]);
  const [envError, setEnvError] = useState('');
  const [envSaved, setEnvSaved] = useState(false);
  useEffect(() => {
    setEnvRows(Object.entries(settings?.mcpEnvironmentVariables ?? {}).map(([name,value]) => ({name,value:value===PROTECTED?'':value,savedName:value===PROTECTED?name:undefined})));
  }, [settings?.mcpEnvironmentVariables]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [configText,setConfigText]=useState<string|null>(null),[configError,setConfigError]=useState('');
  const [importPlan,setImportPlan]=useState<McpServerEntry[]|null>(null);

  const persist = async (next: McpServerEntry[]) => {
    await useAppStore.getState().saveSettings({ mcpServers: next });
  };

  const toggle = (id: string) => {
    void persist(servers.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  const remove = (id: string) => {
    void persist(servers.filter(s => s.id !== id));
    if (editing?.id === id) setEditing(null);
  };

  const save = async (draft: Draft) => {
    const entry = draftToEntry(draft);
    const next = servers.some(s => s.id === entry.id) ? servers.map(s => s.id === entry.id ? entry : s) : [...servers, entry];
    await persist(next);
    setEditing(null);
  };

  if (editing) {
    return <McpEditor draft={editing} servers={servers} copy={copy} onBack={() => setEditing(null)} onSave={d => void save(d)} onDelete={() => { remove(editing.id); }} />;
  }

  return (
    <div className="mcp-settings">
      <h3 className="mcp-section-title">{copy('服务器', 'Servers')}</h3>
      <div className="plugin-actions"><button onClick={()=>{setConfigText('');setImportPlan(null);setConfigError('');}}>{copy('导入 JSON','Import JSON')}</button><button onClick={()=>{setConfigText(exportMcpConfig(servers));setImportPlan(null);setConfigError('');}}>{copy('导出模板（不含密钥）','Export template (without secrets)')}</button></div>
      {configText!==null&&<div className="mcp-config-import"><textarea rows={8} aria-label="MCP JSON" value={configText} onChange={e=>{setConfigText(e.target.value);setImportPlan(null);}}/><button onClick={()=>{try{const plan=parseMcpConfig(configText);if(plan.some(p=>servers.some(s=>s.name===p.name)))throw Error(copy('服务器名称已存在','Server name already exists'));setImportPlan(plan);setConfigError('');}catch(e){setConfigError(String(e));}}}>{copy('预览导入','Preview import')}</button><button onClick={()=>{setConfigText(null);setImportPlan(null);}}>{copy('取消','Cancel')}</button>{importPlan&&<><p>{importPlan.map(s=>`${s.name} (${s.transport})`).join(', ')}</p><button onClick={()=>{void persist([...servers,...importPlan]).then(()=>{setConfigText(null);setImportPlan(null);}).catch(e=>setConfigError(String(e)));}}>{copy('导入为停用状态','Import disabled')}</button></>}{configError&&<p role="alert">{configError}</p>}</div>}
      <section className="settings-card mcp-env-card">
        <h3 className="mcp-section-title">{copy('MCP 加密环境变量', 'Encrypted MCP environment variables')}</h3>
        <p className="mcp-env-help">{copy('保存的值会加密写入本机设置，仅用于 MCP 认证请求，不会传给终端或其他子进程。MCP 配置中填写变量名，例如 DASHSCOPE_API_KEY。', 'Values are encrypted in local settings and used only for MCP authentication, never passed to terminals or child processes. Reference them by name in MCP settings, e.g. DASHSCOPE_API_KEY.')}</p>
        <div className="mcp-list-field">
          {envRows.map((row,i)=><div className="mcp-pair" key={i}>
            <input aria-label={copy('变量名','Variable name')} value={row.name} placeholder="DASHSCOPE_API_KEY" onChange={e=>{setEnvSaved(false);setEnvRows(rows=>rows.map((r,j)=>j===i?{...r,name:e.target.value}:r));}} />
            <input aria-label={copy('密钥值','Secret value')} type="password" autoComplete="new-password" value={row.value} placeholder={row.savedName===row.name?copy('已加密保存；留空保持不变','Saved encrypted; leave blank to keep'):copy('输入密钥值','Enter secret value')} onChange={e=>{setEnvSaved(false);setEnvRows(rows=>rows.map((r,j)=>j===i?{...r,value:e.target.value}:r));}} />
            <button className="icon-btn" title={copy('删除','Remove')} onClick={()=>{setEnvSaved(false);setEnvRows(rows=>rows.filter((_,j)=>j!==i));}}><Trash2 size={14}/></button>
          </div>)}
          <button className="btn-secondary mcp-add-line" onClick={()=>{setEnvSaved(false);setEnvRows(rows=>[...rows,{name:'',value:''}]);}}><Plus size={14}/>{copy('添加变量','Add variable')}</button>
        </div>
        <div className="mcp-env-actions"><button className="btn-primary" onClick={()=>{
          setEnvError('');setEnvSaved(false);
          const variables:Record<string,string>={};
          for(const row of envRows){
            const name=row.name.trim();if(!name&&!row.value)continue;
            if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)){setEnvError(copy('变量名格式无效。','Invalid variable name.'));return;}
            if(Object.hasOwn(variables,name)){setEnvError(copy(`变量名重复：${name}`,`Duplicate variable name: ${name}`));return;}
            if(row.value.trim())variables[name]=row.value;
            else if(row.savedName===name)variables[name]=PROTECTED;
            else{setEnvError(copy(`请填写 ${name} 的密钥值。`,`Enter a secret value for ${name}.`));return;}
          }
          void window.api.setMcpEnvironmentVariables(variables,Object.keys(settings?.mcpEnvironmentVariables??{})).then(async()=>{await useAppStore.getState().refreshSettings();setEnvSaved(true);}).catch(e=>setEnvError(String(e?.message??e)));
        }}>{copy('保存加密变量','Save encrypted variables')}</button>{envSaved&&<span className="mcp-env-saved">{copy('已加密保存；MCP 请求可使用。','Saved encrypted; available to MCP requests.')}</span>}</div>
        {envError&&<p className="mcp-env-error" role="alert">{envError}</p>}
      </section>
      <div className="settings-card mcp-list">
        {servers.length === 0 && <div className="mcp-empty">{copy('还没有 MCP 服务器，点击下方按钮添加。', 'No MCP servers yet — add one below.')}</div>}
        {servers.map(s => (
          <div className="mcp-row" key={s.id}>
            <span className="mcp-row-name">{s.name}</span>
            <span className="mcp-row-transport">{s.transport === 'stdio' ? 'STDIO' : 'HTTP'}</span>
            <button className="icon-btn mcp-row-edit" title={copy('编辑', 'Edit')} onClick={() => setEditing(entryToDraft(s))}><Settings2 size={16} /></button>
            <label className="mcp-switch" title={s.enabled ? copy('已启用', 'Enabled') : copy('已停用', 'Disabled')}>
              <input type="checkbox" checked={s.enabled} onChange={() => toggle(s.id)} />
              <span />
            </label>
          </div>
        ))}
      </div>
      <button className="btn-secondary mcp-add" onClick={() => setEditing(entryToDraft({ id: newId(), name: '', enabled: true, transport: 'stdio' }))}>
        <Plus size={14} /> {copy('添加 MCP 服务器', 'Add MCP server')}
      </button>
    </div>
  );
}

/** 编辑/新建表单：字段布局对齐参考设计（名称、类型切换、按传输分组的动态字段）。 */
function McpEditor({ draft: initial, servers, copy, onBack, onSave, onDelete }: {
  draft: Draft; servers: McpServerEntry[]; copy: (zh: string, en: string) => string;
  onBack: () => void; onSave: (d: Draft) => void; onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; message?: string; tools?: Array<{ name: string; description: string }> }>({ state: 'idle' });
  const testGeneration = useRef(0);
  useEffect(() => () => { testGeneration.current++; }, []);
  const patch = (p: Partial<Draft>) => {
    testGeneration.current++;
    setTest({ state: 'idle' });
    setDraft(d => ({ ...d, ...p }));
  };

  const nameTaken = draft.name.trim() !== '' && servers.some(s => s.id !== draft.id && s.name.trim() === draft.name.trim());
  const missing = !draft.name.trim()
    || (draft.transport === 'stdio' ? !draft.command.trim() : !/^https?:\/\/.+/.test(draft.url.trim()));
  const canSave = !missing && !nameTaken;

  const runTest = async () => {
    const ticket = ++testGeneration.current;
    setTest({ state: 'running' });
    try {
      const r = await window.api.mcpTest(draftToEntry(draft));
      if (ticket === testGeneration.current) setTest(r.ok ? { state: 'ok', message: `${r.tools?.length ?? 0}`, tools: r.tools } : { state: 'fail', message: r.error });
    } catch (err) {
      if (ticket === testGeneration.current) setTest({ state: 'fail', message: String((err as Error)?.message ?? err) });
    }
  };

  const field = (label: string, el: React.ReactNode, hint?: string) => (
    <div className="mcp-field">
      <label className="mcp-field-label">{label}{hint && <span className="mcp-field-hint"> {hint}</span>}</label>
      {el}
    </div>
  );

  return (
    <div className="mcp-settings mcp-editor">
      <button className="btn-ghost mcp-back" onClick={onBack}><ArrowLeft size={14} /> {copy('返回', 'Back')}</button>
      <h3 className="mcp-editor-title">{copy('连接至自定义 MCP', 'Connect to a custom MCP')}</h3>

      {field(copy('名称', 'Name'),
        <input value={draft.name} placeholder="MCP server name" onChange={e => patch({ name: e.target.value })} />)}
      {nameTaken && <div className="mcp-error">{copy('名称已存在，换一个', 'Name already in use')}</div>}

      {field(copy('类型', 'Type'),
        <div className="mcp-segmented">
          <button className={draft.transport === 'stdio' ? 'active' : ''} onClick={() => patch({ transport: 'stdio' })}>STDIO</button>
          <button className={draft.transport === 'http' ? 'active' : ''} onClick={() => patch({ transport: 'http' })}>{copy('流式 HTTP', 'Streamable HTTP')}</button>
        </div>)}

      <div className="settings-card mcp-fields">
        {draft.transport === 'stdio' ? (
          <>
            {field(copy('启动命令', 'Command'),
              <input value={draft.command} placeholder="openai-dev-mcp serve-sqlite" onChange={e => patch({ command: e.target.value })} />)}
            {field(copy('参数', 'Arguments'),
              <div className="mcp-list-field">
                {draft.args.map((arg, i) => (
                  <div className="mcp-pair" key={i}>
                    <input value={arg} onChange={e => patch({ args: draft.args.map((a, j) => (j === i ? e.target.value : a)) })} />
                    <button className="icon-btn" title={copy('删除', 'Remove')} onClick={() => patch({ args: draft.args.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
                  </div>
                ))}
                <button className="btn-secondary mcp-add-line" onClick={() => patch({ args: [...draft.args, ''] })}><Plus size={14} /> {copy('添加参数', 'Add argument')}</button>
              </div>)}
            {field(copy('环境变量', 'Environment variables'),
              <PairListEditor pairs={draft.env} onChange={env => patch({ env })} copy={copy} />)}
            {field(copy('环境量传递', 'Pass through env'),
              <div className="mcp-list-field">
                {draft.envPassThrough.map((name, i) => (
                  <div className="mcp-pair" key={i}>
                    <input value={name} placeholder={copy('宿主环境变量名', 'Host env var name')} onChange={e => patch({ envPassThrough: draft.envPassThrough.map((a, j) => (j === i ? e.target.value : a)) })} />
                    <button className="icon-btn" title={copy('删除', 'Remove')} onClick={() => patch({ envPassThrough: draft.envPassThrough.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
                  </div>
                ))}
                <button className="btn-secondary mcp-add-line" onClick={() => patch({ envPassThrough: [...draft.envPassThrough, ''] })}><Plus size={14} /> {copy('添加变量', 'Add variable')}</button>
              </div>)}
            {field(copy('工作目录', 'Working directory'),
              <input value={draft.cwd} placeholder="~/code" onChange={e => patch({ cwd: e.target.value })} />)}
          </>
        ) : (
          <>
            {field('URL',
              <input value={draft.url} placeholder="https://mcp.example.com/mcp" onChange={e => patch({ url: e.target.value })} />)}
            {field(copy('Bearer 令牌环境变量', 'Bearer token env var'),
              <input value={draft.bearerTokenEnv} placeholder="MCP_BEARER_TOKEN" onChange={e => patch({ bearerTokenEnv: e.target.value })} />,
              copy('填写变量名；密钥值可在服务器列表页的“MCP 加密环境变量”中保存。', 'Enter the variable name; save its secret in “Encrypted MCP environment variables” on the server list page.'))}
            {field(copy('标头', 'Headers'),
              <PairListEditor pairs={draft.headers} onChange={headers => patch({ headers })} copy={copy} />)}
            {field(copy('来自环境变量的标头', 'Headers from env'),
              <PairListEditor pairs={draft.headersFromEnv} onChange={headersFromEnv => patch({ headersFromEnv })} copy={copy}
                valuePlaceholder={copy('环境变量名', 'Env var name')} />)}
          </>
        )}
      </div>

      <div className="mcp-editor-actions">
        <button className="btn-secondary" onClick={() => void runTest()} disabled={test.state === 'running' || missing}>
          <Zap size={14} /> {test.state === 'running' ? copy('连接中…', 'Connecting…') : copy('测试连接', 'Test connection')}
        </button>
        <span className="mcp-actions-spacer" />
        {servers.some(s => s.id === draft.id) && (
          <button className="btn-ghost mcp-delete" onClick={onDelete}><Trash2 size={14} /> {copy('删除', 'Delete')}</button>
        )}
        <button className="btn-primary" disabled={!canSave} onClick={() => onSave(draft)}>{copy('保存', 'Save')}</button>
      </div>

      {test.state === 'ok' && (
        <div className="mcp-test-result ok">
          <Unplug size={14} /> {copy(`连接成功，共 ${test.tools?.length ?? 0} 个工具`, `Connected — ${test.tools?.length ?? 0} tools`)}
          {(test.tools?.length ?? 0) > 0 && (
            <div className="mcp-test-tools">{test.tools!.map(tool => <code key={tool.name} title={tool.description}>{tool.name}</code>)}</div>
          )}
        </div>
      )}
      {test.state === 'fail' && <div className="mcp-test-result fail">{test.message}</div>}
    </div>
  );
}

/** key/value 双列编辑器（环境变量、标头通用）。 */
function PairListEditor({ pairs, onChange, copy, valuePlaceholder }: {
  pairs: Pair[]; onChange: (next: Pair[]) => void; copy: (zh: string, en: string) => string; valuePlaceholder?: string;
}) {
  return (
    <div className="mcp-list-field">
      {pairs.map((p, i) => (
        <div className="mcp-pair" key={i}>
          <input value={p.key} placeholder={copy('键', 'Key')} onChange={e => onChange(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
          <input value={p.value} placeholder={valuePlaceholder ?? copy('值', 'Value')} onChange={e => onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button className="icon-btn" title={copy('删除', 'Remove')} onClick={() => onChange(pairs.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
        </div>
      ))}
      <button className="btn-secondary mcp-add-line" onClick={() => onChange([...pairs, { key: '', value: '' }])}><Plus size={14} /> {copy('添加', 'Add')}</button>
    </div>
  );
}
