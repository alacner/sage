import {WindowOverlay} from './WindowOverlay';
import { ModelProbeReport } from './ModelProbeReport';
import { modelLabel } from '../../shared/model-label';
/**
 * Provider 管理界面：左侧 provider 列表，右侧详细配置。
 * 参考 LobeChat 的 provider 管理模式。
 * 支持独立保存：每次修改 provider 后可以立即保存，不用等整个设置对话框。
 */
import { useState, useEffect } from 'react';
import type { ModelProvider, CompositeMember, ModelMapping, ApiKeyTestResult } from '../../shared/types';
import { RefreshCw, Plus, Trash2, Copy, Loader2, CheckCircle2, XCircle, AlertTriangle, Save, Eye, EyeOff, Layers, KeyRound, Shuffle, ArrowRightLeft, Radio, ListChecks, ListCollapse } from 'lucide-react';
import { translate, useT } from '../i18n';
import { PROTECTED } from '../../shared/settings-protection';
import { splitApiKeys } from '../../shared/model-providers';
import { CompositeMappingEditor } from './CompositeMappingEditor';
import { confirmDialog } from '../lib/confirm-dialog';
import { useModelTypes } from '../lib/useModelTypes';
import { ModelTypeIcons } from './ModelTypeIcons';
import { copyMarkdown } from '../lib/clipboard';
import { useOnboardingContext } from '../lib/onboarding-context';

/**
 * 从 apiKey 字段解析出独立的 key 列表。
 * 直接用 shared 的拆分规则：这里数的/列的行数必须跟运行时 pickApiKey、
 * 测试连接逐把验证看到的完全一致，不然「3 个」可能其实只有一把能用的 key。
 */
const parseApiKeys = splitApiKeys;

/** 从 apiKey 字符串自动生成别名（取前8位+…+后4位）。 */
function autoAlias(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** 把 key 列表合并回逗号分隔的字符串（存入 apiKey 字段，过滤空值）。 */
function joinApiKeys(keys: string[]): string {
  return keys.filter(Boolean).join(',');
}

/** 把 key 列表原样合并（不过滤空值，用于编辑态）。 */
function joinApiKeysRaw(keys: string[]): string {
  return keys.join(',');
}

/**
 * 「测试连接」结果。
 * tested / model = 本次到底测了什么（主进程给）：配了模型就是真补全调用，
 * 没配就只能测接口连通性 —— 两者不是一回事，界面必须分开说。
 */
export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  listSupported?: boolean;
  keys?: ApiKeyTestResult[];
  tested?: 'model' | 'connectivity';
  model?: string;
}

interface ProviderManagerProps {
  providers: ModelProvider[];
  onChange: (providers: ModelProvider[]) => void;
  /** 当前正在测试的 provider id */
  testing?: string;
  /** 测试结果属于哪个 provider（测试结束后 testing 会清空，靠它把结果留在页面上） */
  testedId?: string;
  /** 测试结果 */
  testResult?: ProviderTestResult | null;
  /** 测试连接回调 */
  onTest?: (provider: ModelProvider) => void;
  /** 保存回调（独立保存） */
  onSave?: () => Promise<void>;
  relayConnected?: boolean;
}
/**
 * 按地址关键词快速识别协议：含 anthropic → Anthropic；否则含 openai 或 /v1 → OpenAI。
 * 都不命中返回 undefined（保持当前选择，不瞎猜）；anthropic 优先判断，
 * 避免 api.anthropic.com/v1 这类同时含 /v1 的地址被误判成 OpenAI。
 */
function inferProtocolFromUrl(url: string): 'anthropic' | 'openai' | undefined {
  const u = url.toLowerCase();
  if (u.includes('anthropic')) return 'anthropic';
  if (u.includes('openai') || u.includes('/v1')) return 'openai';
  return undefined;
}

function newProviderId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function confirmProviderToggle(provider: ModelProvider, allProviders: ModelProvider[], enabled: boolean) {
  if (enabled) return true;
  const referencedBy = allProviders.filter(p => p.kind === 'composite' && p.composite?.members?.some(m => m.providerId === provider.id));
  if (!referencedBy.length) return true;
  return confirmDialog({ message: translate('providers.disableReferencedConfirm', {
    name: provider.name || translate('providers.thisProvider'),
    names: referencedBy.map(p => p.name || translate('providers.unnamed')).join('、'),
  }) });
}

export function ProviderManager({ providers, onChange, testing, testedId, testResult, onTest, onSave, relayConnected }: ProviderManagerProps) {
  const t = useT();
  const [showProbeReport,setShowProbeReport] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      const remembered = localStorage.getItem('sage.providerManager.lastSelectedId');
      if (remembered && providers.some(provider => provider.id === remembered)) return remembered;
    } catch { /* storage may be unavailable; fall back to the first provider */ }
    return providers[0]?.id ?? null;
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const selectedProvider = providers.find((p) => p.id === selectedId);
  useEffect(() => {
    useOnboardingContext.setState({selectedProviderId: selectedId});
    return () => { useOnboardingContext.setState({selectedProviderId: null}); };
  }, [selectedId]);

  useEffect(() => {
    if (selectedId && providers.some(provider => provider.id === selectedId)) {
      try { localStorage.setItem('sage.providerManager.lastSelectedId', selectedId); } catch { /* selection still works without storage */ }
      return;
    }
    if (!selectedId && providers.length) {
      let remembered: string | null = null;
      try { remembered = localStorage.getItem('sage.providerManager.lastSelectedId'); } catch { /* ignore unavailable storage */ }
      setSelectedId(remembered && providers.some(provider => provider.id === remembered) ? remembered : providers[0].id);
    } else if (selectedId && !providers.some(provider => provider.id === selectedId)) {
      setSelectedId(providers[0]?.id ?? null);
    }
  }, [providers, selectedId]);

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const addProvider = () => {
    const newProvider: ModelProvider = {
      id: newProviderId(),
      name: '',
      baseUrl: '',
      apiKey: '',
      protocol: 'openai',
      models: [],
      enabled: true,
      kind: 'normal',
    };
    onChange([...providers, newProvider]);
    setSelectedId(newProvider.id);
  };

  /** 添加复合类型提供商：聚合多个已有普通提供商，按权重负载均衡。 */
  const addCompositeProvider = () => {
    const newProvider: ModelProvider = {
      id: newProviderId(),
      name: '',
      baseUrl: '',
      apiKey: '',
      protocol: 'openai',
      models: [],
      enabled: true,
      kind: 'composite',
      composite: { members: [] },
    };
    onChange([...providers, newProvider]);
    setSelectedId(newProvider.id);
  };

  const updateProvider = (id: string, patch: Partial<ModelProvider>) => {
    onChange(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const deleteProvider = async (id: string) => {
    const provider = providers.find((p) => p.id === id);
    if (!provider || provider.kind === 'relay') return;
    // 检查该提供商是否被某个复合提供商引用
    const referencedBy = providers.filter(
      (p) => p.kind === 'composite' && p.composite?.members?.some((m) => m.providerId === id),
    );
    if (referencedBy.length > 0) {
      const names = referencedBy.map((p) => p.name || translate('providers.unnamed')).join('、');
      if (!(await confirmDialog({
        message: translate('providers.deleteReferencedConfirm', { name: provider?.name || translate('providers.thisProvider'), names }),
        danger: true,
      }))) {
        return;
      }
    } else {
      if (!(await confirmDialog({ message: translate('providers.deleteConfirm', { name: provider?.name ?? '' }), danger: true }))) return;
    }
    // 删除提供商，并联动清理所有复合提供商中引用该提供商的成员
    const next = providers
      .filter((p) => p.id !== id)
      .map((p) => {
        if (p.kind === 'composite' && p.composite?.members?.some((m) => m.providerId === id)) {
          return {
            ...p,
            composite: {
              members: p.composite.members.filter((m) => m.providerId !== id),
            },
          };
        }
        return p;
      });
    onChange(next);
    setSelectedId(next.find((p) => p.id === selectedId)?.id ?? next[0]?.id ?? null);
  };

  const duplicateProvider = (id: string) => {
    const original = providers.find((p) => p.id === id);
    if (!original || original.kind === 'relay') return;
    const copy: ModelProvider = {
      ...original,
      apiKey: original.apiKey === PROTECTED ? '' : original.apiKey,
      baseUrl: original.baseUrl === PROTECTED ? '' : original.baseUrl,
      id: newProviderId(),
      name: `${original.name}${translate('providers.copySuffix')}`,
    };
    onChange([...providers, copy]);
    setSelectedId(copy.id);
  };

  // 启用中的中继提供商固定排列表第一（其余保持原有顺序）
  const filteredProviders = providers
    .filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => Number(b.kind === 'relay' && b.enabled) - Number(a.kind === 'relay' && a.enabled));

  return (
    <>
    <div className="provider-manager">
      <div className="provider-manager-panels">
        {/* 左侧：Provider 列表 */}
        <div className="provider-list-panel">
          <div className="provider-list-header">
            <input
              type="text"
              placeholder={translate('providers.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="provider-search"
            />
          </div>
          <ul className="provider-list">
            {filteredProviders.map((p) => (
              <li
                key={p.id}
                className={`provider-list-item ${selectedId === p.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="provider-list-item-name">
                  {p.kind === 'composite' && (
                    <span className="model-picker-composite-icon" title={translate('providers.composite')}>
                      <Layers size={12} />
                    </span>
                  )}
                  {p.kind === 'relay' && (
                    <span className="provider-list-relay-icon" title={translate('providers.relay')}>
                      <Radio size={12} />
                    </span>
                  )}
                  {p.kind === 'relay' ? translate('providers.relay') : p.name}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={p.enabled}
                  aria-label={t(p.enabled ? 'providers.quickDisable' : 'providers.quickEnable', { name: p.kind === 'relay' ? t('providers.relay') : p.name })}
                  title={t(p.enabled ? 'providers.quickDisable' : 'providers.quickEnable', { name: p.kind === 'relay' ? t('providers.relay') : p.name })}
                  className={`provider-list-item-status ${p.enabled ? 'on' : 'off'}`}
                  disabled={togglingId !== null}
                  onClick={async event => {
                    event.stopPropagation();
                    setTogglingId(p.id);
                    try { if (await confirmProviderToggle(p, providers, !p.enabled)) updateProvider(p.id, { enabled: !p.enabled }); }
                    finally { setTogglingId(null); }
                  }}
                >{t(p.enabled ? 'providers.statusOn' : 'providers.statusOff')}</button>
              </li>
            ))}
          </ul>
        </div>

        {/* 右侧：Provider 详细配置 */}
        <div className="provider-detail-panel">
          {selectedProvider ? (
            <ProviderDetail
              key={selectedProvider.id}
              provider={selectedProvider}
              allProviders={providers}
              relayConnected={relayConnected}
              onUpdate={(patch) => updateProvider(selectedProvider.id, patch)}
              onDelete={() => deleteProvider(selectedProvider.id)}
              onDuplicate={() => duplicateProvider(selectedProvider.id)}
              testing={testing === selectedProvider.id}
              /* 结果必须活到测试结束以后：以前用 testing 门控，而 testingId 一清空就全为 null，
                 逐把密钥结果会在请求完成的那一瞬间消失（只看得到转圈）。 */
              testResult={testedId === selectedProvider.id ? testResult : null}
              onTest={() => onTest?.(selectedProvider)}
            />
          ) : (
            <div className="provider-empty">
              <p>{translate('providers.emptyHint')}</p>
            </div>
          )}
        </div>
      </div>

      {/* 底部操作栏：添加提供商 + 保存 */}
      <div className="provider-manager-actions">
        <div className="provider-manager-actions-left">
          <button type="button" className="btn-ghost btn-sm" data-setup="add-provider" onClick={addProvider}>
            <Plus size={14} /> {translate('providers.add')}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={addCompositeProvider}
            title={translate('providers.addCompositeTitle')}
          >
            <Plus size={14} /> {translate('providers.addComposite')}
          </button>
        </div>
        <div className="provider-probe-entry"><button type="button" data-setup="probe-open" className="btn-ghost btn-sm provider-probe-toggle" aria-expanded={showProbeReport} aria-controls="provider-probe-report" onClick={()=>setShowProbeReport(v=>!v)}>{showProbeReport ? <ListCollapse size={17}/> : <ListChecks size={17}/>}<span>{t(showProbeReport ? 'probeReport.entryOpen' : 'probeReport.entryClosed')}</span></button></div>
        {onSave && (
          <button
            type="button"
            className={`provider-manager-save-btn ${saved ? 'success' : ''}`}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (
              <Loader2 size={12} className="spin" />
            ) : saved ? (
              <CheckCircle2 size={12} />
            ) : (
              <Save size={12} />
            )}
            <span>{saving ? translate('providers.saving') : saved ? translate('providers.saved') : translate('providers.save')}</span>
          </button>
        )}
      </div>
    </div>
    {showProbeReport && <div id="provider-probe-report"><ModelProbeReport/></div>}
    </>
  );
}

interface ProviderDetailProps {
  provider: ModelProvider;
  /** 所有提供商（复合类型用于挑选成员）。 */
  allProviders: ModelProvider[];
  onUpdate: (patch: Partial<ModelProvider>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  testing?: boolean;
  testResult?: ProviderTestResult | null;
  onTest?: () => void;
  relayConnected?: boolean;
}

function ProviderDetail({ provider, allProviders, onUpdate, onDelete, onDuplicate, testing, testResult, onTest, relayConnected }: ProviderDetailProps) {
  const capsOf = useModelTypes(allProviders);
  const [editingModels, setEditingModels] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  // 用户手动选过协议后就不再被地址关键词自动覆盖；切换提供商时重置。
  const [protocolTouched, setProtocolTouched] = useState(false);
  useEffect(() => { setProtocolTouched(false); }, [provider.id]);

  // API Key 编辑态：用数组管理（按索引，不依赖 key 值做字典键）
  const [editKeys, setEditKeys] = useState<string[]>(parseApiKeys(provider.apiKey));
  // 别名数组（按索引，用户自定义后不会被重置）
  const [aliases, setAliases] = useState<string[]>([]);
  // 每行独立的显示/隐藏（按索引）
  const [visibles, setVisibles] = useState<boolean[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // 切换 provider 时重新初始化 editKeys（别名保留用户输入）
  useEffect(() => {
    setEditKeys(previous => joinApiKeysRaw(previous) === provider.apiKey ? previous : parseApiKeys(provider.apiKey));
    if (provider.apiKey === PROTECTED) { setVisibles([]); setAliases([]); }
  }, [provider.id, provider.apiKey]);

  /** 按索引取别名：有自定义用自定义，没有用 autoAlias。 */
  const getAlias = (key: string, index: number): string => {
    const custom = aliases[index];
    if (custom && custom.trim()) return custom;
    if (!key) return '';
    return autoAlias(key);
  };

  /**
   * 逐把测试结果对回哪一行失败了（只标明确失败：未测/成功都不干扰）。
   * 索引能直接对上，因为主进程拆分用的是同一套 splitApiKeys、不去重不排序。
   */
  const keyFailed = (index: number) => testResult?.keys?.[index]?.ok === false;

  /** 逐把结果的行标签：受保护提供商拿不到明文，只能按序号叫「密钥 N」。 */
  const keyTestLabel = (index: number): string => {
    const key = provider.apiKey === PROTECTED ? '' : editKeys[index];
    if (!key) return translate('providers.keyTestProtected', { index: index + 1 });
    return aliases[index]?.trim() || autoAlias(key);
  };

  // 单把密钥无需多列一行“测试结果”（按钮本身已经是结论）；两把以上才逐把展开。
  const keyResults = (testResult?.keys?.length ?? 0) > 1 ? testResult!.keys! : null;
  const keyResultsPassed = keyResults ? keyResults.filter((k) => k.ok).length : 0;

  /** 提交编辑态（原样存储含空行占位）。 */
  const commitKeys = (keys: string[], newAliases?: string[], newVisibles?: boolean[]) => {
    setEditKeys(keys);
    if (newAliases !== undefined) setAliases(newAliases);
    if (newVisibles !== undefined) setVisibles(newVisibles);
    onUpdate({ apiKey: joinApiKeysRaw(keys) });
  };

  /** 添加一个空 key 行。 */
  const handleAddKey = () => {
    commitKeys([...editKeys, ''], [...aliases, ''], [...visibles, false]);
  };

  /** 修改某个 key 的值。 */
  const handleUpdateKey = (index: number, newKey: string) => {
    const updated = [...editKeys];
    updated[index] = newKey;
    commitKeys(updated);
  };

  /** 修改某个别名。 */
  const handleUpdateAlias = (index: number, newAlias: string) => {
    const updated = [...aliases];
    updated[index] = newAlias;
    commitKeys(editKeys, updated);
  };

  /** 删除某行。 */
  const handleDeleteKey = (index: number) => {
    commitKeys(
      editKeys.filter((_, i) => i !== index),
      aliases.filter((_, i) => i !== index),
      visibles.filter((_, i) => i !== index),
    );
  };

  /** 复制某个 key。 */
  const handleCopyKey = async (key: string, index: number) => {
    if (!key) return;
    try {
      if (!await copyMarkdown(key)) return;
      setCopiedIdx(index);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch { /* ignore */ }
  };

  /** 切换某行显示/隐藏。 */
  const toggleVisible = (index: number) => {
    const updated = [...visibles];
    updated[index] = !updated[index];
    setVisibles(updated);
  };

  const isRelay = provider.kind === 'relay';
  const [relaySchedule, setRelaySchedule] = useState<{ nextAt: number; refreshing: boolean }>({ nextAt: 0, refreshing: false });
  const [relayNow, setRelayNow] = useState(Date.now());
  useEffect(() => {
    if (!isRelay || !relayConnected) { setRelaySchedule({ nextAt: 0, refreshing: false }); return; }
    let active = true;
    const update = async () => { try { const schedule = await window.api.relayModelsSchedule(); if (active) { setRelaySchedule(schedule); setRelayNow(Date.now()); } } catch { if (active) setRelaySchedule({ nextAt: 0, refreshing: false }); } };
    void update(); const timer = setInterval(() => void update(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [isRelay, relayConnected]);
  const [refreshingRelay, setRefreshingRelay] = useState(false);
  const [relayRefreshError, setRelayRefreshError] = useState('');
  const refreshRelay = async () => {
    setRefreshingRelay(true); setRelayRefreshError('');
    try {
      const models: NonNullable<ModelProvider['relayModels']> = await window.api.relayModels();
      onUpdate({ models: models.map(m => m.id), relayModels: models });
    } catch (e: any) { setRelayRefreshError(e.message); } finally { setRefreshingRelay(false); }
  };
  const isComposite = provider.kind === 'composite';
  // 支持模型清单接口的普通提供商：模型列表由测试连接同步 + 主进程定时刷新维护，
  // 隐藏手工编辑（参考中继提供商的刷新按钮与倒计时位置）。
  const hasListApi = !isRelay && !isComposite && provider.modelsListSupported === true;
  const [providerSchedule, setProviderSchedule] = useState<{ nextAt: number; refreshing: boolean }>({ nextAt: 0, refreshing: false });
  const [providerNow, setProviderNow] = useState(Date.now());
  useEffect(() => {
    if (!hasListApi) { setProviderSchedule({ nextAt: 0, refreshing: false }); return; }
    let active = true;
    const update = async () => { try { const schedule = await window.api.providerModelsSchedule(); if (active) { setProviderSchedule(schedule); setProviderNow(Date.now()); } } catch { if (active) setProviderSchedule({ nextAt: 0, refreshing: false }); } };
    void update(); const timer = setInterval(() => void update(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [hasListApi]);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelsRefreshError, setModelsRefreshError] = useState('');
  const refreshProviderModels = async () => {
    setRefreshingModels(true); setModelsRefreshError('');
    try {
      const res = await window.api.providerModelsRefresh(provider.id);
      if (res.ok) {
        onUpdate({ models: res.models, relayModels: res.named, modelsListSupported: true });
      } else {
        // 清单接口已不可用 → 降级回手工编辑，保留原模型列表
        if (res.listSupported === false) onUpdate({ modelsListSupported: false });
        setModelsRefreshError(res.error ?? '');
      }
    } catch (e: any) { setModelsRefreshError(e.message); } finally { setRefreshingModels(false); }
  };
  // 自动同步模式不开放手工编辑：关闭可能已打开的编辑态
  useEffect(() => { if (hasListApi) setEditingModels(false); }, [hasListApi]);
  // 刷新按钮的共享展示状态：中继与清单提供商复用同一套倒计时/刷新中文案
  const autoSyncSchedule = isRelay ? relaySchedule : hasListApi ? providerSchedule : null;
  const syncRefreshing = isRelay ? (refreshingRelay || relaySchedule.refreshing) : hasListApi ? (refreshingModels || providerSchedule.refreshing) : false;
  const syncNow = isRelay ? relayNow : providerNow;

  const addModel = () => {
    if (newModelId.trim() && !provider.models.includes(newModelId.trim())) {
      onUpdate({ models: [...provider.models, newModelId.trim()] });
      setNewModelId('');
    }
  };

  const removeModel = (modelId: string) => {
    // 合并为一次 onUpdate，避免两次调用第二次覆盖第一次的 models 更新
    const patch: Partial<ModelProvider> = {
      models: provider.models.filter((m) => m !== modelId),
    };
    // 联动清理：从所有成员的 modelMappings 中移除该模型对应的映射项
    if (provider.kind === 'composite' && provider.composite?.members) {
      let dirty = false;
      const nextMembers = provider.composite.members.map((m) => {
        const oldLen = m.modelMappings?.length ?? 0;
        const mappings = m.modelMappings?.filter(
          (mp) => mp.compositeModel !== modelId && mp.memberModel !== modelId,
        );
        if (mappings && mappings.length !== oldLen) dirty = true;
        return { ...m, modelMappings: mappings };
      });
      if (dirty) {
        patch.composite = { members: nextMembers };
      }
    }
    onUpdate(patch);
  };

  return (
    <div className="provider-detail">
      <div className="provider-detail-header">
        <div className="provider-detail-title-row">
          <h3>
            {isComposite && (
              <span className="model-picker-composite-icon" title={translate('providers.composite')}>
                <Layers size={13} />
              </span>
            )}
            {provider.name || translate('providers.unnamed')}
          </h3>
          <div className="provider-detail-actions">
            {!isRelay && <button
              type="button"
              className="icon-btn"
              title={translate('common.copy')}
              onClick={onDuplicate}
            >
              <Copy size={14} />
            </button>}
            {!isRelay && <button
              type="button"
              className="icon-btn danger"
              title={translate('common.delete')}
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </button>}
            <label className="switch">
              <input
                type="checkbox"
                checked={provider.enabled}
                onChange={async (e) => {
                  const newVal = e.target.checked;
                  if (!await confirmProviderToggle(provider, allProviders, newVal)) return;
                  onUpdate({ enabled: newVal });
                }}
              />
              <span className="slider" />
            </label>
          </div>
        </div>
      </div>

      <div className="provider-detail-content" data-setup="provider-fields">
        {/* 名称 */}
        <label className="provider-field">
          <span className="provider-field-label">{translate('providers.name')}</span>
          <input
            type="text"
            data-setup="provider-name" value={isRelay ? translate('providers.relay') : provider.name}
            readOnly={isRelay}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder={isComposite ? translate('providers.namePlaceholderComposite') : translate('providers.namePlaceholder')}
          />
        </label>

        {/* ─── 复合类型：成员配置 ─── */}
        {provider.routingExtension ? <div className="provider-field"><code>{provider.routingExtension}</code></div> : isRelay ? (<div className="provider-field"><p className="muted small">{translate('providers.relayHelp')}</p>{relayRefreshError && <p role="alert">{relayRefreshError}</p>}</div>) : isComposite ? (
          <CompositeMembersEditor
            provider={provider}
            allProviders={allProviders}
            onUpdate={onUpdate}
          />
        ) : (
          <>
            {/* Base URL */}
            <label className="provider-field">
              <span className="provider-field-label">API Host</span>
              <input
                type="text"
                data-setup="provider-host" value={provider.baseUrl}
                readOnly={provider.baseUrl === PROTECTED || provider.apiKey === PROTECTED}
                onChange={(e) => {
                  const baseUrl = e.target.value;
                  const detected = protocolTouched ? undefined : inferProtocolFromUrl(baseUrl);
                  onUpdate(detected && detected !== provider.protocol ? { baseUrl, protocol: detected } : { baseUrl });
                }}
                placeholder={translate('providers.hostPlaceholder')}
              />
            </label>

            {/* 协议 - 左右结构（紧跟地址，便于看到关键词识别结果） */}
            <div className="provider-field provider-field-horizontal">
              <span className="provider-field-label-horizontal">{translate('providers.protocol')}</span>
              <select
                data-setup="provider-protocol"
                value={provider.protocol}
                onChange={(e) => { setProtocolTouched(true); onUpdate({ protocol: e.target.value as 'anthropic' | 'openai' }); }}
              >
                <option value="openai">OpenAI (Chat Completions)</option>
                <option value="anthropic">Anthropic (Messages)</option>
              </select>
            </div>

            {/* API Key: 卡片式多 Key 管理 */}
            <fieldset data-setup="provider-key" className="provider-field" disabled={provider.apiKey === PROTECTED} style={{ border: 0, padding: 0, minWidth: 0 }}>
              {provider.apiKey === PROTECTED && <p className="muted small">{translate('pm.keyProtected')}</p>}
              <div className="provider-field-label-row">
                <span className="provider-field-label">
                  API Key
                  <span className="muted small" style={{ marginLeft: 6 }}>{translate('providers.keyCount', { count: editKeys.length })}</span>
                </span>
                <div className="provider-field-label-right">
                  <span className="provider-field-hint" style={{ margin: 0 }}>{translate('providers.keyBalance')}</span>
                  <button type="button" className="apikey-add-btn-simple" onClick={handleAddKey} title={translate('providers.addKeyTitle')}>+</button>
                </div>
              </div>

              {/* key 列表：每行 = 别名(可编辑) + key(可编辑) + 操作按钮 */}
              {editKeys.length > 0 && (
                <div className="apikey-list">
                  {editKeys.map((key, i) => (
                    <div key={i} className={`apikey-row${keyFailed(i) ? ' test-fail' : ''}`}>
                      <input
                        type="text"
                        className="apikey-row-alias"
                        value={getAlias(key, i) === autoAlias(key) ? '' : (aliases[i] ?? '')}
                        placeholder={key ? autoAlias(key) : translate('providers.aliasPlaceholder')}
                        onChange={(e) => handleUpdateAlias(i, e.target.value)}
                        title={translate('providers.aliasTitle')}
                      />
                      <input
                        type={visibles[i] ? 'text' : 'password'}
                        className="apikey-row-key"
                        value={key}
                        onChange={(e) => handleUpdateKey(i, e.target.value)}
                        placeholder={translate('providers.keyPlaceholder')}
                      />
                      <div className="apikey-card-actions">
                        <button type="button" className="apikey-card-btn" title={visibles[i] ? translate('settings.apiKey.hide') : translate('settings.apiKey.show')} onClick={() => toggleVisible(i)} disabled={!key}>
                          {visibles[i] ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                        <button type="button" className="apikey-card-btn" title={translate('common.copy')} onClick={() => void handleCopyKey(key, i)} disabled={!key}>
                          {copiedIdx === i ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                        </button>
                        <button type="button" className="apikey-card-btn danger" title={translate('common.delete')} onClick={() => handleDeleteKey(i)}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </fieldset>

            {/* 测试连接（仅普通类型显示；复合类型由成员各自测试） */}
            <div className="provider-field">
              <button
                type="button"
                className="btn-ghost btn-sm provider-action-button"
                data-setup="provider-test"
                onClick={onTest}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <Loader2 size={12} className="spin" /> {translate('providers.testing')}
                  </>
                ) : testResult ? (
                  testResult.ok ? (
                    keyResults && keyResultsPassed < keyResults.length ? (
                      <>
                        <AlertTriangle size={12} /> {translate('providers.testPartial')}
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={12} /> {translate('providers.testOk')}
                      </>
                    )
                  ) : (
                    <>
                      <XCircle size={12} /> {translate('providers.testFail')}
                    </>
                  )
                ) : (
                  translate('providers.test')
                )}
              </button>
              {testResult && !testResult.ok && testResult.error && (
                <p className="provider-test-error">{testResult.error}</p>
              )}
              {/* 测了什么必须写在结论旁边：清单接口 404 不等于模型不能用，
                  只测连通性也不能当成「模型可用」。 */}
              {testResult?.tested === 'model' && (
                <p className="muted small provider-test-scope">{translate('providers.testedModel', { model: testResult.model || '' })}</p>
              )}
              {testResult?.tested === 'connectivity' && (
                <p className="muted small provider-test-scope">{translate('providers.testedConnectivity')}</p>
              )}
              {testResult?.ok && testResult.models && testResult.models.length > 0 && (
                <p className="muted small">{translate('providers.modelsAvailable', { models: testResult.models.slice(0, 5).join(', ') })}{testResult.models.length > 5 ? translate('providers.modelsMore', { count: testResult.models.length }) : ''}</p>
              )}
              {/* 多密钥逐把结果：运行时是随机取一把做负载均衡，一把坏 key = 偶发报错，
                  所以必须逐把给出结论，而不是“整体通过”就完事。 */}
              {keyResults && (
                <div className="provider-key-results">
                  <p className="muted small">
                    {keyResultsPassed === keyResults.length
                      ? translate('providers.keyTestAll', { count: keyResults.length })
                      : translate('providers.keyTestSummary', { passed: keyResultsPassed, count: keyResults.length })}
                  </p>
                  <ul className="provider-key-results-list">
                    {keyResults.map((k, i) => (
                      <li key={i} className={`provider-key-result ${k.ok ? 'ok' : 'fail'}`}>
                        {k.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                        <span className="provider-key-result-alias">{keyTestLabel(i)}</span>
                        <span className="provider-key-result-state">{translate(k.ok ? 'providers.keyTestOk' : 'providers.keyTestFail')}</span>
                        {k.ok
                          ? <span className="provider-key-result-meta">{k.tested === 'model'
                            ? translate('providers.keyTestModelProbed', { model: k.model || '' })
                            : translate('providers.keyTestModels', { count: k.models ?? 0 })}</span>
                          : <span className="provider-key-result-meta">{k.error || testResult?.error || ''}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}

        {/* 模型列表（普通和复合类型都需要：复合类型声明聚合的模型名） */}
        <div className="provider-field" data-setup="provider-models">
          <div className="provider-field-label-row">
            <span className="provider-field-label">
              {translate('providers.modelListCount', { count: provider.models.length })}
              {isComposite && <span className="muted small" style={{ marginLeft: 6 }}>{translate('providers.compositeModelsHint')}</span>}
            </span>
            {hasListApi && <span className="muted small provider-models-autosync-hint">{translate('providers.modelsAutoSyncHint')}</span>}
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={syncRefreshing || (isRelay && !relayConnected)}
              onClick={() => isRelay ? void refreshRelay() : hasListApi ? void refreshProviderModels() : setEditingModels(!editingModels)}
            >
              {autoSyncSchedule ? <><RefreshCw size={13} className={syncRefreshing ? 'spin' : ''} />{syncRefreshing ? translate('providers.relayRefreshing') : autoSyncSchedule.nextAt ? translate('providers.relayRefreshCountdown', { seconds: Math.max(0, Math.ceil((autoSyncSchedule.nextAt - syncNow) / 1000)) }) : translate('providers.relayRefreshShort')}</> : editingModels ? translate('providers.done') : translate('providers.edit')}
            </button>
          </div>
          {modelsRefreshError && <p role="alert">{modelsRefreshError}</p>}

          <div className="provider-models-preview">
            {provider.models.length === 0 ? (
              <p className="muted small">{translate('providers.noModels')}</p>
            ) : (
              <div className="provider-models-groups">
                {provider.models.map((m) => (
                  <span key={m} className="provider-model-chip">
                    <span className="provider-model-chip-name">{modelLabel(provider, m)}</span>
                    <ModelTypeIcons caps={capsOf(provider, m)} />
                    {editingModels && (
                      <button
                        type="button"
                        className="provider-model-chip-remove"
                        title={translate('common.delete')}
                        onClick={() => removeModel(m)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {provider.models.length > 6 && (
                  <span className="provider-models-more">{translate('providers.totalCount', { count: provider.models.length })}</span>
                )}
              </div>
            )}
          </div>

          {editingModels && (
            <div className="provider-models-add provider-models-add-inline">
              <input
                type="text"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                placeholder={translate('providers.modelAddPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addModel();
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 复合提供商成员编辑器：从已有普通提供商中挑选成员并设置权重。
 * 成员引用的是普通提供商（不能嵌套复合），权重用于加权随机负载均衡。
 *
 * 支持多模型映射：一个成员可映射复合提供商声明的多个模型，
 * 每个映射对 { compositeModel, memberModel } 表示「复合模型名 → 成员实际模型名」。
 * 也保留"同名直传"快捷操作（空映射 = 所有模型同名直传）。
 */
function CompositeMembersEditor({
  provider,
  allProviders,
  onUpdate,
}: {
  provider: ModelProvider;
  allProviders: ModelProvider[];
  onUpdate: (patch: Partial<ModelProvider>) => void;
}) {
  const members = provider.composite?.members ?? [];
  // 可添加的成员：普通类型（排除自身与嵌套复合）、未被添加过的
  const candidates = allProviders.filter(
    (p) => p.kind !== 'composite' && p.id !== provider.id && !members.some((m) => m.providerId === p.id),
  );

  const updateMembers = (next: CompositeMember[]) => {
    onUpdate({ composite: { members: next } });
  };

  /**
   * 添加成员：支持一次选多个模型，自动生成映射对。
   * - 选了模型：为每个选中模型生成 { compositeModel, memberModel } 映射，memberModel 优先同名，否则选用户指定模型或首个上游模型
   * - 没选模型（空数组）：空映射 = 同名直传
   */
  const addMember = (providerId: string, selectedModels: string[] = [], targets: Record<string,string> = {}) => {
    const member = allProviders.find((p) => p.id === providerId);
    const modelMappings: ModelMapping[] = selectedModels
      .filter((m) => provider.models.includes(m))
      .map((m) => ({ compositeModel: m, memberModel: targets[m] ?? (member?.models.includes(m) ? m : member?.models[0] ?? '') }));
    updateMembers([...members, { providerId, weight: 1, modelMappings }]);
  };

  const removeMember = (providerId: string) => {
    updateMembers(members.filter((m) => m.providerId !== providerId));
  };

  const updateMember = (providerId: string, patch: Partial<CompositeMember>) => {
    updateMembers(members.map((m) => (m.providerId === providerId ? { ...m, ...patch } : m)));
  };

  /** 更新某个成员的某个映射项。 */
  const updateMapping = (providerId: string, index: number, patch: Partial<ModelMapping>) => {
    const member = members.find((m) => m.providerId === providerId);
    if (!member) return;
    const mappings = [...(member.modelMappings ?? [])];
    if (!mappings[index]) return;
    mappings[index] = { ...mappings[index], ...patch };
    updateMember(providerId, { modelMappings: mappings });
  };

  /** 为某个成员添加一个映射项。 */
  const addMapping = (providerId: string, compositeModel: string) => {
    const member = members.find((m) => m.providerId === providerId);
    if (!member) return;
    const mappings = [...(member.modelMappings ?? [])];
    if (mappings.some((m) => m.compositeModel === compositeModel)) return;
    // memberModel 优先同名，否则选用户指定模型或首个上游模型
    const source = allProviders.find(p => p.id === providerId);
    mappings.push({ compositeModel, memberModel: source?.models.includes(compositeModel) ? compositeModel : source?.models[0] ?? '' });
    updateMember(providerId, { modelMappings: mappings });
  };

  /** 删除某个成员的某个映射项。 */
  const removeMapping = (providerId: string, index: number) => {
    const member = members.find((m) => m.providerId === providerId);
    if (!member) return;
    const mappings = (member.modelMappings ?? []).filter((_, i) => i !== index);
    updateMember(providerId, { modelMappings: mappings });
  };

  /** 设为同名直传（清空所有映射），需二次确认。 */
  const setPassthrough = async (providerId: string) => {
    const member = allProviders.find((p) => p.id === providerId);
    const name = member?.name || translate('providers.memberFallback');
    if (!(await confirmDialog({ message: translate('providers.convertPassthroughConfirm', { name }) }))) return;
    updateMember(providerId, { modelMappings: [], modelOverride: undefined });
  };

  const totalWeight = members.reduce((s, m) => s + (Number(m.weight) || 0), 0);
  // 有效成员（存在 + 启用）的权重总和：禁用成员不参与负载，其概率按相对权重
  // 自动分摊到启用成员上（与 model-resolver.resolveComposite 的路由逻辑一致）。
  // 注意：不修改成员配置的 weight 值，仅影响选中概率的计算与展示。
  const activeTotalWeight = members.reduce((s, m) => {
    const mp = allProviders.find((p) => p.id === m.providerId);
    if (!mp || !mp.enabled) return s;
    return s + (Number(m.weight) || 0);
  }, 0);
  const compositeModels = provider.models;

  return (
    <div className="provider-field">
      <div className="provider-field-label-row">
        <span className="provider-field-label">
          {translate('providers.membersTitle', { count: members.length })}
          {totalWeight > 0 && (
            <span className="muted small" style={{ marginLeft: 6 }}>
              {translate('providers.totalWeight', { total: totalWeight })}
              {activeTotalWeight !== totalWeight && translate('providers.activeWeight', { active: activeTotalWeight })}
            </span>
          )}
        </span>
        {candidates.length > 0 && (
          <CompositeAddPopover
            candidates={candidates}
            compositeModels={compositeModels}
            onAdd={addMember}
          />
        )}
      </div>

      {members.length === 0 ? (
        <p className="muted small">
          {translate('providers.noMembers')}
          {candidates.length === 0 && translate('providers.noCandidates')}
        </p>
      ) : (
        <div className="composite-members">
          {members.map((m) => {
            const member = allProviders.find((p) => p.id === m.providerId);
            const memberDisabled = !member || !member.enabled;
            // 选中概率：禁用成员直接为 0，其权重按相对比例分摊到启用成员上；
            // 与运行时路由一致，且不改变成员配置的 weight 值。
            const pct = memberDisabled || activeTotalWeight <= 0
              ? 0
              : Math.round(((Number(m.weight) || 0) / activeTotalWeight) * 100);
            const mappings = m.modelMappings ?? [];
            const isPassthrough = mappings.length === 0 && !m.modelOverride;
            // 未映射的复合模型（可添加映射的候选）
            const mappedCompositeModels = new Set(mappings.map((mp) => mp.compositeModel));
            const unmappedModels = compositeModels.filter((mo) => !mappedCompositeModels.has(mo));

            return (
              <div
                key={m.providerId}
                className={`composite-member-card${member && !member.enabled ? ' member-disabled' : ''}`}
              >
                <div className="composite-member-card-header">
                  <span
                    className="composite-member-name"
                    title={member?.baseUrl}
                    style={member && !member.enabled ? { textDecoration: 'line-through', color: 'var(--text-mute, #999)' } : undefined}
                  >
                    {member?.name || translate('providers.deleted')}
                  </span>
                  <div className="composite-member-card-actions">
                    {isPassthrough ? (
                      compositeModels.length > 0 && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={translate('providers.toMappingTitle')}
                          onClick={() => {
                            // 进入映射模式：为第一个复合模型创建同名初始映射
                            addMapping(m.providerId, compositeModels[0]);
                          }}
                        >
                          <ArrowRightLeft size={14} />
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="icon-btn"
                        title={translate('providers.toPassthroughTitle')}
                        onClick={() => setPassthrough(m.providerId)}
                      >
                        <Shuffle size={14} />
                      </button>
                    )}
                    <input
                      className="composite-member-weight-input"
                      type="number"
                      min={1}
                      max={100}
                      value={m.weight}
                      onChange={(e) => {
                        const w = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                        updateMember(m.providerId, { weight: w });
                      }}
                      title={translate('providers.weightTitle')}
                    />
                    <span
                      className="composite-member-pct muted small"
                      style={{
                        whiteSpace: 'nowrap',
                        ...(memberDisabled ? { textDecoration: 'line-through' } : undefined),
                      }}
                      title={memberDisabled ? translate('providers.probTitleDisabled') : translate('providers.probTitle')}
                    >
                      {pct}%
                    </span>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title={translate('providers.removeMember')}
                      onClick={() => removeMember(m.providerId)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* 模型映射列表：仅在非直传模式下显示 */}
                {!isPassthrough && (
                  <div className="composite-mappings">
                    {mappings.map((mp, i) => (
                      <CompositeMappingEditor key={mp.compositeModel} mapping={mp} member={member} providers={allProviders}
                        publicModels={compositeModels.filter(model => model === mp.compositeModel || !mappedCompositeModels.has(model))}
                        onChange={patch => updateMapping(m.providerId, i, patch)} onRemove={() => removeMapping(m.providerId, i)}/>

                    ))}
                    {/* 添加映射下拉 */}
                    {unmappedModels.length > 0 && (
                      <div className="composite-mapping-add">
                        <select
                          className="composite-mapping-add-select"
                          value=""
                          onChange={(e) => {
                            if (e.target.value) addMapping(m.providerId, e.target.value);
                          }}
                        >
                          <option value="">{translate('providers.addMapping')}</option>
                          {unmappedModels.map((mo) => (
                            <option key={mo} value={mo}>{mo}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <p className="composite-members-hint muted small">
            {translate('providers.probNote')}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 添加成员弹出层：左右栏布局——左边选提供商，右边选模型。
 */
function CompositeAddPopover({
  candidates,
  compositeModels,
  onAdd,
}: {
  candidates: ModelProvider[];
  compositeModels: string[];
  onAdd: (providerId: string, selectedModels: string[], targets: Record<string,string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<Record<string,string>>({});

  const selectedCandidate = candidates.find((p) => p.id === selectedProviderId);

  const reset = () => {
    setSelectedProviderId('');
    setSelectedModels(new Set());
    setTargets({});
    setOpen(false);
  };

  const handleSelectProvider = (id: string) => {
    setSelectedProviderId(id);
    setSelectedModels(new Set());
    setTargets({});
  };

  const toggleModel = (model: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const handleConfirm = () => {
    if (!selectedProviderId) return;
    onAdd(selectedProviderId, Array.from(selectedModels), targets);
    reset();
  };

  return (
    <>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        <Plus size={14} /> {translate('providers.addMember')}
      </button>
      {open && (
        <WindowOverlay className="composite-add-overlay" onClick={reset}>
          <div className="composite-add-popover" onClick={(e) => e.stopPropagation()}>
            <div className="composite-add-popover-title">{translate('providers.addMemberTitle')}</div>
            <div className="composite-add-body">
              {/* 左栏：提供商列表 */}
              <div className="composite-add-left">
                <div className="composite-add-col-label">{translate('providers.colProvider')}</div>
                <div className="composite-add-provider-list">
                  {candidates.length === 0 ? (
                    <p className="muted small" style={{ padding: '8px' }}>{translate('providers.noAddable')}</p>
                  ) : (
                    candidates.map((p) => (
                      <div
                        key={p.id}
                        className={`composite-add-provider-item ${selectedProviderId === p.id ? 'selected' : ''}`}
                        onClick={() => handleSelectProvider(p.id)}
                      >
                        {/* 单选指示器：纯视觉（选中态由 selectedProviderId 驱动），
                            pointerEvents:none 让点击穿透到外层 div 统一处理，
                            避免 label+input 受 .modal label 的 column 布局影响跑到文字上方。 */}
                        <span className="composite-add-radio" aria-hidden>
                          <input
                            type="radio"
                            name="composite-add-provider"
                            checked={selectedProviderId === p.id}
                            readOnly
                            tabIndex={-1}
                          />
                        </span>
                        <span className="composite-add-provider-name">{p.name || translate('providers.unnamed')}</span>
                        {!p.enabled && <span className="composite-add-provider-off">{translate('providers.disabled')}</span>}
                      </div>
                    ))
                  )}
                </div>
              </div>
              {/* 右栏：模型选择 */}
              <div className="composite-add-right">
                <div className="composite-add-col-label">
                  {translate('providers.colMapping')}
                  <span className="muted small" style={{ marginLeft: 6, fontWeight: 400 }}>
                    {selectedCandidate ? translate('providers.mappingHintNone') : translate('providers.mappingHintSelect')}
                  </span>
                </div>
                <div className="composite-add-model-list">
                  {!selectedCandidate ? (
                    <div className="composite-add-empty">
                      <span className="muted small">{translate('providers.clickLeft')}</span>
                    </div>
                  ) : compositeModels.length === 0 ? (
                    <p className="muted small" style={{ padding: '8px' }}>
                      {translate('providers.noCompositeModels')}
                    </p>
                  ) : (
                    compositeModels.map((mo) => {
                      const matched = selectedCandidate.models.includes(mo);
                      const checked = selectedModels.has(mo);
                      return (
                        <div key={mo} className="composite-add-model-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={mo}
                            id={`member-model-${mo}`}
                            onChange={() => toggleModel(mo)}
                          />
                          <label className="composite-add-model-name" htmlFor={`member-model-${mo}`}>{mo}</label>
                          {checked ? <select aria-label={`${translate('providers.mappingUpstream')} ${mo}`} value={targets[mo] ?? (matched ? mo : selectedCandidate.models[0] ?? '')} onChange={e=>setTargets({...targets,[mo]:e.target.value})}>
                            {!selectedCandidate.models.length && <option value="">{translate('providers.mappingSelect')}</option>}
                            {selectedCandidate.models.map(model=><option key={model} value={model}>{modelLabel(selectedCandidate,model)}</option>)}
                          </select> : matched ? (
                            <span className="composite-add-model-match">{translate('providers.matchSameName')}</span>
                          ) : (
                            <span className="composite-add-model-nomatch">{translate('providers.needMapping')}</span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
            {/* 操作按钮 */}
            <div className="composite-add-popover-actions">
              <button type="button" className="btn-ghost btn-sm" onClick={reset}>{translate('common.cancel')}</button>
              <button
                type="button"
                className="provider-manager-save-btn"
                onClick={handleConfirm}
                disabled={!selectedProviderId || (selectedModels.size > 0 && !selectedCandidate?.models.length)}
              >
                {translate('providers.confirmAdd')}
              </button>
            </div>
          </div>
        </WindowOverlay>
      )}
    </>
  );
}
