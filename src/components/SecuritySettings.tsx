import { ReviewChecksEditor } from './ReviewChecksEditor';
import { effectiveModelSelection } from '../../shared/model-selection';
import {securityProfileText} from '../../shared/security-profiles';
import {resolveLanguage} from '../../shared/language';
import { FullAccessDialog } from './FullAccessDialog';
import { ModelSelector } from './ModelSelector';
import { useEffect, useRef, useState } from 'react';
import { Check, SlidersHorizontal, ToggleLeft, ToggleRight } from 'lucide-react';
import { SecurityProfileIcon, useSecurityCopy } from './SecurityProfileIcon';
import { BuiltInBadge } from './BuiltInBadge';
import { defaultSecurityProfile, enabledSecurityProfiles, FULL_ACCESS_ID, securityProfiles } from '../../shared/security-profiles';
import type { SandboxOverrides } from '../../shared/types';
import { REVIEW_INSTRUCTIONS_MAX_LENGTH, reviewCheckDefinitions } from '../../shared/security-review';
import { normalizeSecuritySettings, securityLabel, validateSecuritySettings } from '../../shared/security-settings';
import { useAppStore } from '../stores/appStore';
import { translate, useT } from '../i18n';
import { SandboxAuditLog } from './SandboxAuditLog';
import './security-settings.css';
import './security-rule-editor.css';
import './security-review-checks.css';

type RuleSection = 'env' | 'fs' | 'bash' | 'net';
/** 存 i18n 键，渲染时 translate，避免模块加载期固化语言。 */
const ruleGroups: { section: RuleSection; titleKey: string; fields: [string, string][] }[] = [
  { section: 'fs', titleKey: 'security.ruleGroup.fs', fields: [['denyRead', 'security.ruleField.denyRead'], ['denyWrite', 'security.ruleField.denyWrite'], ['denyWriteSegments', 'security.ruleField.denyWriteSegments'], ['safeSystemPrefixes', 'security.ruleField.safeSystemPrefixes']] },
  { section: 'env', titleKey: 'security.ruleGroup.env', fields: [['safePathPrefixes', 'security.ruleField.safePathPrefixes'], ['safeKeys', 'security.ruleField.safeKeys'], ['stripKeys', 'security.ruleField.stripKeys']] },
  { section: 'bash', titleKey: 'security.ruleGroup.bash', fields: [['hardDenied', 'security.ruleField.hardDenied'], ['allowed', 'security.ruleField.allowed']] },
  { section: 'net', titleKey: 'security.ruleGroup.net', fields: [['allowedHosts', 'security.ruleField.allowedHosts'], ['deniedHosts', 'security.ruleField.deniedHosts']] },
];

export { SecurityProfilesSettings as ProjectSecuritySettings } from './SecurityProfilesSettings';

const OPEN_CONVERSATION_SECURITY = 'sage:open-conversation-security';

export function openConversationSecurityMenu() {
  const conversationId = useAppStore.getState().currentConversation?.id;
  if (conversationId) document.dispatchEvent(new window.CustomEvent(OPEN_CONVERSATION_SECURITY, { detail: conversationId }));
}

/** A conversation owns a snapshot; changing it never changes another conversation. */
export function SecurityMenu({ busy = false, drop = 'up', conversationShortcut = false }: { busy?: boolean; conversationShortcut?: boolean; /** 弹层方向：输入框旁向上，消息内嵌入口向下 */ drop?: 'up' | 'down' }) {
  const conversation = useAppStore(s => s.currentConversation);
  const settings = useAppStore(s => s.settings);
  const [open, setOpen] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  useEffect(()=>{setOpen(false);setConfirmFullAccess(false);},[conversation?.id]);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!conversationShortcut || !conversation?.id) return;
    const show = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== conversation.id) return;
      setOpen(true);
      menuRef.current?.querySelector<HTMLButtonElement>('.security-trigger')?.focus({ preventScroll: true });
    };
    document.addEventListener(OPEN_CONVERSATION_SECURITY, show);
    return () => document.removeEventListener(OPEN_CONVERSATION_SECURITY, show);
  }, [conversationShortcut, conversation?.id]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const t = useT();
  if (!conversation) return null;
  const profiles = enabledSecurityProfiles(settings);
  const menuProfiles = [...profiles.filter(p=>p.id!==FULL_ACCESS_ID), ...profiles.filter(p=>p.id===FULL_ACCESS_ID)];
  const copy = (zh:string,en:string)=>resolveLanguage(settings?.language,settings?._systemLocale)==='en'?en:zh;
  const saved = securityProfiles(settings).find(p=>p.id===conversation.securityProfile?.id);
  const active = saved?.enabled===false ? defaultSecurityProfile(settings) : saved ?? conversation.securityProfile ?? defaultSecurityProfile(settings);
  const label = active?.id===FULL_ACCESS_ID ? copy('完全访问权限','Full access') : active ? securityProfileText(active,'name',resolveLanguage(settings?.language,settings?._systemLocale)) : t('security.profiles.legacy');
  const select = async (id: string) => {
    setSaving(true); setError('');
    try {
      const result = await window.api.updateConvMeta(conversation.id, { securityProfile: { id } as any });
      if (!result?.ok) throw Error(t('security.saveFailed'));
      useAppStore.setState(s => ({
        currentConversation: s.currentConversation?.id === conversation.id ? result.meta : s.currentConversation,
        conversations: s.conversations.map(c => c.id === conversation.id ? result.meta : c),
      }));
      setOpen(false);
    } catch (e: any) { setError(e.message); throw e; }
    finally { setSaving(false); }
  };
  return <div className={`security-selector ${drop === 'down' ? 'security-drop-down' : ''}`} ref={menuRef}>
    {confirmFullAccess && <FullAccessDialog onCancel={()=>setConfirmFullAccess(false)} onConfirm={async()=>{await select(FULL_ACCESS_ID);setConfirmFullAccess(false);}}/>}
    <button type="button" className={`security-trigger ${active?.id===FULL_ACCESS_ID?'security-full-access':''}`} style={{color:active?.color}} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}><SecurityProfileIcon profile={active??{id:'legacy',name:'',description:'',policy:{}}} size={15}/><span className="security-trigger-label">{label}</span><SlidersHorizontal className="security-trigger-chevron" size={12}/></button>
    {open && <div className="security-profile-menu">
      <div className="security-menu-heading">
        <button type="button" onClick={()=>{setOpen(false);useAppStore.getState().openSettingsTab({initialTab:'security-audit',auditConvId:conversation.id,auditProfileId:undefined});}}>{copy('当前对话决策记录','Conversation decisions')}</button>
        <button type="button" onClick={() => {setOpen(false);useAppStore.getState().openSettingsTab({initialTab:'security'});}}>{t('security.profiles.manage')}</button><small className="security-menu-timing">{copy('下次开始或恢复执行时生效','Applies on next execution')}</small>
      </div>
      {menuProfiles.map(p => <button type="button" key={p.id} className={`security-policy-option ${p.id===FULL_ACCESS_ID?'security-full-access':''}`} style={{color:p.color}} disabled={saving} onClick={() => {if(p.id===FULL_ACCESS_ID){setOpen(false);setConfirmFullAccess(true);}else void select(p.id).catch(()=>{});}} aria-pressed={active?.id === p.id}>
        <SecurityProfileIcon profile={p}/>
        <span><strong>{p.id===FULL_ACCESS_ID?copy('完全访问权限','Full access'):securityProfileText(p,'name',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale))}{(settings?.defaultSecurityProfileId??'manual')===p.id?' · '+t('security.profiles.default'):''}</strong>{['manual','assisted',FULL_ACCESS_ID].includes(p.id)&&<BuiltInBadge/>}<small>{p.id===FULL_ACCESS_ID?copy('可不受限制地访问互联网和你电脑上的任何文件','Unrestricted access to the internet and any files on your computer'):securityProfileText(p,'description',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale))}</small></span>
        {active?.id===p.id && <Check className="security-policy-check" size={18} aria-hidden="true"/>}
      </button>)}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}

/** 主进程 IPC 校验错误：`key` 或 `key:{json参数}` → 翻译为可读文本。 */
function translateIpcError(raw: string): string {
  if (!raw.startsWith('security.validate.')) return raw;
  const idx = raw.indexOf(':');
  if (idx < 0) return translate(raw);
  try { return translate(raw.slice(0, idx), JSON.parse(raw.slice(idx + 1))); } catch { return translate(raw.slice(0, idx)); }
}

export function SecuritySettingsPanel({ policy, onSave }: { policy: SandboxOverrides; onSave: (value: SandboxOverrides) => Promise<void> }) {
  const project = useAppStore(s => s.currentProject);
  const providers = useAppStore(s => s.settings?.modelProviders ?? []);
  const globalModel = useAppStore(s => s.settings?.selectedModel);
  const conversation = useAppStore(s => s.currentConversation);
  const inheritedModel = effectiveModelSelection(conversation?.selectedModel,effectiveModelSelection(project?.selectedModel,globalModel));
  if (inheritedModel && conversation?.thinkingEffort !== undefined) inheritedModel.thinkingEffort=conversation.thinkingEffort;
  const legacyFiles = useAppStore(s => s.settings?.autoApproveProjectScope !== false);
  const t = useT();
  const copy = useSecurityCopy();
  const [value, setDraft] = useState<SandboxOverrides>(() => {
    const review = { ...normalizeSecuritySettings(policy)?.review,
      projectFiles: policy?.review?.projectFiles ?? legacyFiles };
    // 旧版「拒绝说明 / 允许说明」两段合并为一段统一说明，避免界面上看不见却仍生效的规则。
    const deny = review.denyPolicy?.trim();
    if (deny) {
      review.policy = [`${copy('不允许：', 'Never:')}\n${deny}`,
        review.policy?.trim() ? `${copy('允许：', 'Allow:')}\n${review.policy.trim()}` : '']
        .filter(Boolean).join('\n\n');
      review.denyPolicy = '';
    }
    return { ...policy, review };
  });
  const [tab, setTab] = useState<'deny' | 'review' | 'scope'>('deny');
  const [selectedRuleSection, setSelectedRuleSection] = useState<RuleSection>('fs');
  const [defaults, setDefaults] = useState<SandboxOverrides & { runtimeAvailable?: boolean }>();
  const [defaultsError, setDefaultsError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const localDevPolicy = t('security.localDevPolicy');
  const uiLanguage = resolveLanguage(useAppStore(s => s.settings?.language),useAppStore.getState().settings?._systemLocale);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => window.api.getSandboxDefaults()).then(result => { if (active) setDefaults(result); }).catch(() => { if (active) setDefaultsError(translate('security.loadDefaultsFailed')); });
    return () => { active = false; };
  }, []);
  const draft = useRef(value);
  const revision = useRef(0);
  const pending = useRef(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const persist = (next: SandboxOverrides) => {
    const current = ++revision.current;
    setSaved(false); setError('');
    const issue = validateSecuritySettings(next);
    if (issue) { setSaving(false); return; }
    setSaving(true);
    // Serialize writes and discard superseded queued snapshots. Already-started writes
    // finish before the next one, including when the settings page is closed.
    pending.current = pending.current.then(async () => {
      if (current !== revision.current) return;
      try {
        await onSave(normalizeSecuritySettings(next));
        if (mounted.current && current === revision.current) setSaved(true);
      } catch (e: any) {
        if (mounted.current && current === revision.current) setError(e?.message ? translateIpcError(String(e.message)) : translate('security.saveFailed'));
      } finally {
        if (mounted.current && current === revision.current) setSaving(false);
      }
    });
  };
  const setValue = (update: (previous: SandboxOverrides) => SandboxOverrides) => {
    const next = update(draft.current);
    draft.current = next;
    setDraft(next);
    persist(next);
  };
  const review = (patch: NonNullable<SandboxOverrides['review']>) => setValue(v => ({ ...v, review: { ...v.review, ...patch } }));
  const validation = validateSecuritySettings(value);
  const validationText = validation ? t(validation.key, validation.params) : undefined;
  const rules = (section: RuleSection, field: string, text: string) => {
    setValue(v => {
      const next: Record<string, unknown> = { ...v[section] };
      // Keep blank lines while editing; normalization belongs to the saved payload.
      next[field] = text.split('\n');
      return { ...v, [section]: next };
    });
  };
  const checkDefinitions = reviewCheckDefinitions(value.review);
  const toggleReviewCheck = (id: string, enabled: boolean) => review({
    checks: checkDefinitions.filter(check => check.id === id ? enabled : check.enabled).map(check => check.id),
  });
  return <section className="security-settings-page">
      <nav className="security-tabs" aria-label={t('security.navAria')}>{([['deny','security.directDeny'],['scope','security.directAllow'],['review','security.needsReview']] as const).map(([id,titleKey]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{t(titleKey)}</button>)}</nav>
      <div className="security-content">
        <div className="security-feature-list">
          {tab === 'review' && <section className="security-feature-section"><h3>{t('security.needsReview')}</h3><p className="security-muted">{t('security.step1.muted')}</p>
            <div className="security-choices security-review-mode-choices">
              <label className={!value.review?.enabled ? 'selected' : ''}><input type="radio" name="reviewer" checked={!value.review?.enabled} onChange={() => review({ enabled: false })} /><span><strong>{t('security.reviewer.human')}</strong><small>{t('security.reviewer.humanDesc')}</small></span></label>
              <div className={`security-review-card security-review-ai${value.review?.enabled ? ' selected' : ''}`}>
                <label className="security-review-mode-row"><input type="radio" name="reviewer" checked={!!value.review?.enabled} onChange={() => review({ enabled: true })} /><span><strong>{t('security.reviewer.ai')}</strong><small>{copy('根据勾选的检查项和补充说明，一次判断是否允许；失败、超时或无法确认时转人工。','One AI review uses your selected checks and additional instructions to decide whether to allow the action. Failed, timed-out or uncertain reviews fall back to human approval.')}</small></span></label>
                {value.review?.enabled && <div className="security-review-options">
                  <fieldset className="security-review-checks"><legend>{copy('预审检查项','Review checks')}</legend><ReviewChecksEditor value={value.review ?? {}} en={uiLanguage === 'en'} onSave={review}/><div className="security-review-check-list">{checkDefinitions.map(check => <label key={check.id} className={`security-review-check${check.enabled ? ' selected' : ''}`} title={check.focus}><input type="checkbox" checked={check.enabled} onChange={event => toggleReviewCheck(check.id, event.target.checked)} /><span>{uiLanguage === 'en' ? check.nameEn ?? check.name : check.name}</span></label>)}</div></fieldset>
                  <label className="security-review-instructions">{copy('其他预审说明','Additional review instructions')}<textarea aria-label={copy('其他预审说明','Additional review instructions')} rows={5} maxLength={REVIEW_INSTRUCTIONS_MAX_LENGTH} placeholder={copy('补充哪些操作可以通过、哪些不能通过。如：不允许删除项目外的文件和目录','Add which operations may pass and which must not. For example: do not delete files or directories outside the project.')} value={value.review.policy ?? ''} onChange={e => review({ policy: e.target.value })} /></label>
                  <div className="security-inline-fields"><ModelSelector label={t('security.reviewModel')} providers={providers.filter(p => p.enabled)} value={value.review.model ?? null} inheritedValue={inheritedModel} onChange={model => review({model: model ?? undefined})} emptyLabel={t('security.followSession')} /><label>{t('security.timeout')}<select value={value.review.timeoutSeconds ?? 60} onChange={e => review({timeoutSeconds:Number(e.target.value)})}>{[20,60,120,180].map(n => <option key={n} value={n}>{t('security.nSeconds', { n })}</option>)}</select></label></div>
                  <p className="security-note">{copy('检查项与补充说明合并为一次 AI 预审；不允许的要求优先。直接拒绝或直接允许规则先于预审生效，预审失败、超时或无法确认时转人工审核。','Selected checks and additional instructions are combined into a single AI review; denial requirements take priority. Direct deny or allow rules apply first. Failed, timed-out or uncertain reviews fall back to human approval.')}</p>
                  <p className="muted small security-review-example">{copy('示例：','Example: ')}{localDevPolicy}</p>
                </div>}
              </div>
            </div>
          </section>}
          {tab === 'scope' && <><p className="security-muted">{t('security.advancedMuted')}</p><details open className="security-rule-group"><summary>{copy('跳过审核','Skip review')}</summary>
            <div className="security-choices">
              <label className={value.review?.projectFiles ? 'selected' : ''}><input type="checkbox" checked={!!value.review?.projectFiles} onChange={e => review({projectFiles:e.target.checked})} /><span><strong>{t('security.scope.filesTitle')}</strong><small>{t('security.scope.filesDesc')}</small></span></label>
              <label className={value.runtime?.autoApproveSandbox ? 'selected' : ''}><input type="checkbox" checked={value.runtime?.autoApproveSandbox ?? false} onChange={e => setValue(v => ({...v,runtime:{...v.runtime,autoApproveSandbox:e.target.checked,autoApproveBuilds:false}}))} /><span><strong>{copy('沙箱内命令自动通过','Auto-approve sandboxed commands')}</strong><small>{copy('默认禁止命令及其子进程联网；单次联网需单独开启下方策略并审批。网站允许规则只作用于网页工具。','Commands and child processes have no network access by default. Enable the separate policy below for one-time network approval. Website rules apply only to web tools.')}</small></span></label>
            </div></details><section className="security-rule-group"><h4>{copy('命令联网','Command networking')}</h4><div className="security-choices"><label className={value.runtime?.networkApproval ? 'selected' : ''}><input type="checkbox" checked={!!value.runtime?.networkApproval} onChange={e => setValue(v => ({...v,runtime:{...v.runtime,networkApproval:e.target.checked}}))} /><span><strong>{copy('保留沙箱，联网单独审批','Keep sandbox, approve networking separately')}</strong><small>{copy('AI 根据勾选的检查项和补充说明，一次判断是否允许联网；失败、超时或无法确认时转人工。执行时只放行申请域名解析得到的固定 IPv4:端口，保留文件隔离，不开放监听。','AI uses your selected checks and additional instructions in one review to decide whether to allow networking. Failed, timed-out or uncertain reviews fall back to human approval. Execution permits only the pinned IPv4:port addresses resolved from the request, preserving filesystem isolation and blocking listening.')}</small></span></label></div><p className="security-note">{copy('使用“需要审核”中的预审模型和超时设置；未单独选择模型时跟随当前对话。即使普通操作未开启 AI 预审，联网申请仍会预审。','Uses the review model and timeout under Review required, following the conversation model by default. Network requests receive AI review even if ordinary-operation review is disabled.')}</p></section></>}
        </div>
        {(tab === 'deny' || tab === 'scope') && <section>{tab === 'deny' && <p className="security-muted">{copy('拒绝规则优先于允许与审核；启用分类后生效。固定保护不受此处覆盖。','Enabled denial categories take precedence over allowance and review. Fixed protections remain in effect.')}</p>}
          {defaultsError && <p role="alert">{defaultsError}</p>}
          {!defaults && !defaultsError && <p>{t('security.advancedLoading')}</p>}
          {defaults && <div className="security-rule-editor">
            <div className="security-rule-list" role="listbox" aria-label={copy('规则分类', 'Rule categories')}>
              {ruleGroups.map(group => {
                const enabled = (tab === 'deny' ? value.denyEnabled : value.allowEnabled)?.[group.section] !== false;
                return <div key={group.section} className={`expert-role-row${selectedRuleSection === group.section ? ' selected' : ''}`} role="option" aria-selected={selectedRuleSection === group.section} tabIndex={0}
                  onClick={() => setSelectedRuleSection(group.section)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedRuleSection(group.section); } }}>
                  <span className="expert-role-label">{t(group.titleKey)}</span>
                  <button type="button" className="expert-role-toggle" aria-label={t(group.titleKey)} aria-pressed={enabled} title={enabled ? copy('点击禁用', 'Click to disable') : copy('点击启用', 'Click to enable')}
                    onClick={event => { event.stopPropagation(); setValue(v => ({ ...v, [tab === 'deny' ? 'denyEnabled' : 'allowEnabled']: { ...(tab === 'deny' ? v.denyEnabled : v.allowEnabled), [group.section]: !enabled } })); }}>
                    {enabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                  </button>
                </div>;
              })}
            </div>
            {ruleGroups.filter(group => group.section === selectedRuleSection).map(group => <section className="security-rule-form" key={group.section} aria-label={t(group.titleKey)}><h4>{t(group.titleKey)}</h4><p className="security-note">{copy('没有有效规则时等同未启用；清空不会恢复默认。','An empty rule list has no effect; clearing does not restore defaults.')}</p>
            {(tab==='deny'?value.denyEnabled:value.allowEnabled)?.[group.section] === false&&<p className="security-note">{copy('此组未启用，仍可编辑并保存；启用后生效。','This group is off. You can edit and save its rules; enable the group to apply them.')}</p>}
            {group.section === 'net' && <p className="security-note">{t('security.advancedNetNote')}</p>}
            {group.section === 'env' && <p className="security-note">{t('security.advancedEnvNote')}</p>}
            {group.fields.filter(([field])=>tab==='deny'?['denyRead','denyWrite','denyWriteSegments','stripKeys','hardDenied','deniedHosts'].includes(field):['safeSystemPrefixes','safePathPrefixes','safeKeys','allowed','allowedHosts'].includes(field)).map(([field,titleKey]) => {
              const override = (value[group.section] as Record<string,string[]> | undefined)?.[field];
              const fallback = (defaults[group.section] as Record<string,string[]> | undefined)?.[field] ?? [];
              return <div className="security-rule" key={field}><label>{t(titleKey)}<small>{override === undefined ? t('security.inheritDefault') : t('security.customized')}</small><textarea rows={4} value={(override ?? fallback).join('\n')} onChange={e => rules(group.section,field,e.target.value)} /></label><button type="button" className="btn-ghost btn-xs" disabled={override === undefined} onClick={() => setValue(v=>{const fields={...v[group.section]} as Record<string,unknown>;delete fields[field];return {...v,[group.section]:fields};})}>{t('security.restoreDefault')}</button></div>;
            })}
          </section>)}</div>}
        </section>}

        {error && <p className="security-error" role="alert">{error} <button type="button" className="btn-ghost btn-xs" onClick={() => persist(draft.current)}>{t('security.retrySave')}</button></p>}
        {validationText && <p className="security-error" role="alert">{validationText}</p>}
      </div>
      <footer><div>
        {saved && <span role="status">{t('settings.save.saved')}</span>}
        {saving && <span role="status">{t('security.savingPolicy')}</span>}
      </div></footer>
  </section>;
}
