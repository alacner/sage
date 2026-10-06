import { registerConversationDraftReader } from '../lib/conversation-draft-lifecycle';
import { ChatCapabilities } from './ChatCapabilities';
import { ImageLightbox } from './ImageLightbox';
export { ImageLightbox } from './ImageLightbox';
import { UploadResults, uploadResults, withoutUploadSummary } from './UploadResults';
import { nativeVisionCapability } from '../../shared/vision-capability';
import { useModelTypes } from '../lib/useModelTypes';
import { ModelSelector } from './ModelSelector';
import { prepareImageSubmission, visibleImageMessage } from '../lib/imageSubmission';
import {WindowOverlay} from './WindowOverlay';
import {ChatActivityFooter} from './ChatActivityFooter';
import {ScheduledConversationActivity} from './ScheduledConversationActivity';
import {ScheduledTaskEditor} from './ScheduledTaskEditor';
import {CornerRemoveButton} from './CornerRemoveButton';
import { effectiveModelSelection } from '../../shared/model-selection';
import { VoiceWaveform } from './VoiceWaveform';
import { ModelCombo } from './ModelCombo';
import { groupExpertMessages, mergeExpertPlanNotices, groupExpertExecution, expertTasksComplete, resolveExpertTask } from '../../shared/expert-task-tree';
import { placeCursorMenu } from '../../shared/popover-placement';
import { AnchoredPopover } from './AnchoredPopover';
import {ModelSetupNotice} from './ModelSetupNotice';
import {resolveLanguage} from '../../shared/language';
import {FloatingExecutionPlan} from './FloatingExecutionPlan';
import { toolOutcome, toolFailureReason } from '../../shared/tool-outcome';
import { toolDisplayName, type ToolDisplayIdentity } from '../../shared/tool-display-name';
import { approvalLabel, approvalReason } from '../../shared/approval-feedback';
import { conversationError, formatConversationError } from '../../shared/conversation-error';
import {formatCasualDateTime,formatDateTime,useDateTimeSettings} from '../lib/date-time';
import { shortcutDisplay } from '../lib/shortcuts';
import { useComposerShortcuts } from '../lib/composer-shortcuts';
import {PluginSlot} from './plugins/PluginWorkbench';
import {ExtensionOptions} from './plugins/ExtensionControls';
import { modelLabel } from '../../shared/model-label';
import { modelCapabilityKey } from '../../shared/model-types';
import {SecurityMenu} from './SecuritySettings';
import {CursorMenu} from './CursorMenu';
import { projectChatTimeline, replaceExpertAttempts } from '../../shared/chat-timeline';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {ScheduledTaskFeedback} from './ScheduledTaskFeedback';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkLocalImages } from '../lib/remarkLocalImages';
import { CalendarClock, FileArchive, CircleAlert, ArrowUp, AtSign, Link, FileText, Paperclip, ImagePlus, SlashSquare, Square, Wrench, AlertTriangle, Trash2, RotateCcw, Bot, ImageDown, Clock, HelpCircle, ZoomIn, ZoomOut, Maximize2, Inbox, X, Send, User, MessageSquare, Infinity as InfinityIcon, Brain, Power, Lightbulb, Search, Code2, FlaskConical, Bug, ListChecks, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Copy, Check, Pencil, Layers, CornerUpLeft, Languages, Sparkles, FileSearch, Loader2, CheckCircle2, Circle, Terminal as TerminalIcon, Atom, RefreshCw, FolderOpen, Download, Link2, Upload, Images, CloudLightning, Mic } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { requestAiTranslation } from '../lib/ai-translate';
import { TranslatePop, useTranslatePopDismiss, type TranslatePopState } from './TranslatePop';
import { VoiceSession } from '../lib/voice-session';
import { startVoiceCapture, type VoiceCapture } from '../lib/voice-capture';
import { useT, useBackendLabel, translate } from '../i18n';
import { CopyButtons } from './CopyButton';
import { ConvNavigator } from './ConvNavigator';
import { copyMarkdown } from '../lib/clipboard';
import { confirmDialog } from '../lib/confirm-dialog';
import { detectPotentialSecrets } from '../lib/secret-detection';
import { FlatModelList } from './FlatModelList';
import { mermaidMarkdownComponents, openProjectFileByRef } from '../lib/markdownComponents';
import { saveElementAsImage, copyElementToClipboard, copyImageToClipboard, imageFilename } from '../lib/exportImage';
import { contextAuditContentLabel, contextAuditModeLabel, contextAuditReasonLabel, contextAuditSummaryLabel } from '../lib/context-audit-labels';
import type { ChatMessage, ImageAttachment, PendingApproval, ClarifyRequest, ToolCall, UsageStats, ConversationMode, ExpertsPlan, ExpertTask, ExpertRole, ContextStrategyConfig, ContextCompactionAudit, ConversationMeta } from '../../shared/types';
import { readContextUsage } from '../../shared/context-meter';
import { ExpertGlyph, resolveExpertMeta } from './expert-meta';

const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** 图片附件上限默认值（MB）。可在「设置」中覆盖。 */
const DEFAULT_MAX_IMAGE_MB = 5;
/** 文本文件插入输入框的上限默认值（MB），超过则降级为只插路径。可在「设置」中覆盖。 */
const DEFAULT_MAX_TEXT_FILE_MB = 1;
/** 长文本粘贴改为折叠草稿卡片，避免输入框被大量内容撑满。 */
const LONG_PASTE_THRESHOLD = 1200;

/** Rehydrate large-paste cards when a queued message is edited back into the composer. */
function splitQueuedPasteCards(content: string): { text: string; pastedTexts: Array<{ id: string; text: string }> } {
  const marker = /^\[(?:粘贴内容|Pasted text) \d+\]\r?\n/gm;
  const matches = [...content.matchAll(marker)];
  if (matches.length === 0) return { text: content, pastedTexts: [] };

  const first = matches[0];
  const text = content.slice(0, first.index).replace(/\n{2,}$/, '');
  const pastedTexts = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const value = content.slice(start, end).replace(/\n{2,}$/, '');
    return { id: `paste-restore-${Date.now()}-${index}`, text: value };
  });
  return { text, pastedTexts };
}

/** Keep the visible error short; expose the IPC/transport cause only when asked. */
function ConversationErrorText({error}:{error:string}) {
  const display = formatConversationError(error);
  return <>{display.summary}{display.detail ? <details className="conversation-error-details"><summary>查看详情 / Details</summary><pre>{display.detail}</pre></details> : null}</>;
}

/** 专家团模式图标：中间主专家 + 两侧协作专家的三人组合（线条风格与 lucide 对齐）。 */
function ExpertsIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="7" r="2.6" />
      <path d="M8.4 19.5v-1.1a3.6 3.6 0 0 1 7.2 0v1.1" />
      <circle cx="4.9" cy="9" r="1.9" />
      <path d="M2.2 18.2c.2-1.9 1.3-3.4 2.9-3.9" />
      <circle cx="19.1" cy="9" r="1.9" />
      <path d="M21.8 18.2c-.2-1.9-1.3-3.4-2.9-3.9" />
    </svg>
  );
}

/** 已知文本类扩展名：拖入时即使 MIME 为空（macOS 常见）也能识别为文本。 */
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.lua', '.r', '.scala', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.html', '.htm', '.css', '.scss', '.less', '.sass', '.styl',
  '.xml', '.svg', '.sql', '.graphql', '.proto',
  '.vue', '.svelte', '.astro',
  '.env', '.gitignore', '.dockerignore', '.editorconfig',
  '.lock', '.log', '.ini', '.cfg', '.conf', '.properties',
  '.diff', '.patch',
]);

function isTextFile(name: string, type: string): boolean {
  if (type.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/javascript',
       'application/typescript', 'application/x-sh', 'application/x-yaml',
       'application/toml'].includes(type)) return true;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 紧凑 token 数格式化：12.3k / 1.2M。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 消息时间格式化：今天 HH:mm，昨天 昨天 HH:mm，更早 M/D HH:mm */
function formatTime(isoString: string): string { return formatCasualDateTime(isoString); }

/** 操作栏只显示消息创建时间。 */
function formatMessageTime(ts: string): string { return formatTime(ts); }

function MessageWorkDuration({ m, busy }: { m: ChatMessage; busy: boolean }) {
  const en = resolveLanguage(useAppStore(s => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  const running = !!m.pending && busy;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const start = Date.parse(m.ts);
  const end = running ? now : Date.parse(m.updatedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const duration = [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${seconds % 60}s`].filter(Boolean).join(' ');
  return <div className="message-work-duration">{en
    ? `${running ? 'Working for' : 'Worked for'} ${duration}`
    : `${running ? '正在处理' : '处理耗时'} ${duration}`}</div>;
}

// 审计枚举/诊断串的展示文案统一放在 lib/context-audit-labels（与整理记录面板共用一套词条）。

function ContextCompactionAuditDetails({
  audit,
  onClose,
}: {
  audit: ContextCompactionAudit;
  onClose?: () => void;
}) {
  const t = useT();
  const before = audit.beforeEstimatedTokens ?? 0;
  const after = audit.afterEstimatedTokens ?? 0;
  return (
    <div className="chat-context-audit-details">
      <div className="chat-context-audit-header">
        <strong>{t('chat.contextAudit.title')}</strong>
        {onClose ? (
          <button type="button" className="chat-context-audit-close" onClick={onClose} aria-label={t('chat.contextAudit.close')}>
            <X size={13} />
          </button>
        ) : null}
      </div>
      <div className="chat-context-audit-time">{formatMessageTime(audit.at)}</div>
      <div className="chat-context-audit-line">
        {t('chat.contextAudit.trigger', {
          value: audit.trigger === 'automatic' ? t('chat.contextAudit.automatic') : t('chat.contextAudit.manual'),
        })}
      </div>
      <div className="chat-context-audit-line">
        {t('chat.contextAudit.strategy', {
          value: contextAuditModeLabel(t, audit),
          summary: contextAuditSummaryLabel(t, audit),
        })}
      </div>
      {audit.contentKind ? <div className="chat-context-audit-line">{t('chat.contextAudit.content', { value: contextAuditContentLabel(t, audit) })}</div> : null}
      <div className="chat-context-audit-line">
        {t('chat.contextAudit.size', { before: formatTokens(before), after: formatTokens(after) })}
      </div>
      <div className="chat-context-audit-line">
        {t('chat.contextAudit.details', {
          messages: audit.compactedMessages ?? 0,
          turns: audit.summarizedTurns ?? 0,
          recent: audit.keptRecentTurns ?? 0,
        })}
      </div>
      {audit.reason ? <div className="chat-context-audit-reason">{t('chat.contextAudit.reason', { value: contextAuditReasonLabel(t, audit) })}</div> : null}
      {(audit.occurrences ?? 1) > 1 ? (
        <div className="chat-context-audit-line">{t('chat.contextAudit.occurrences', { count: audit.occurrences ?? 1 })}</div>
      ) : null}
    </div>
  );
}

/** 语音听写分段拼接：英文locale 段间按需补空格，中文等直接相连。 */
function joinVoiceText(segs: string[], locale: string): string {
  return segs.reduce((acc, s) => {
    if (!acc) return s;
    const needSpace = locale.toLowerCase().startsWith('en') && !/\s$/.test(acc) && !/^\s/.test(s);
    return acc + (needSpace ? ' ' : '') + s;
  }, '');
}

/** 整理记录在按钮旁选择可用空间，独立于聊天滚动容器，避免裁剪和覆盖按钮。 */
function ContextAuditPopover({ anchor, id, audits, showList, onClose }: {
  anchor: HTMLButtonElement;
  id: string;
  audits: ContextCompactionAudit[];
  showList?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const wide = showList || audits.length > 1;
  const dismiss = useCallback((restoreFocus = false) => {
    closeRef.current();
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }, [anchor]);

  useLayoutEffect(() => {
    const margin = 8, gap = 8;
    const scroller = anchor.closest<HTMLElement>('.chat-scroller');
    let frame = 0;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const clip = scroller?.getBoundingClientRect();
      const top = Math.max(0, clip?.top ?? 0);
      const bottom = Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight);
      if (!anchor.isConnected || rect.bottom <= top || rect.top >= bottom || rect.right <= 0 || rect.left >= window.innerWidth) {
        dismiss();
        return;
      }
      const width = Math.max(0, Math.min(wide ? 600 : 420, window.innerWidth - margin * 2));
      const height = rootRef.current?.getBoundingClientRect().height ?? 0;
      const placed = placeCursorMenu(rect.left, rect.bottom + gap, { width, height }, { width: window.innerWidth, height: window.innerHeight }, { margin, gap, aboveY: rect.top });
      setPosition({ left: placed.left, top: placed.top, width, maxHeight: placed.maxHeight });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    if (rootRef.current) observer.observe(rootRef.current);
    if (scroller) observer.observe(scroller);
    const messages = anchor.closest('.chat-messages-inner');
    if (messages) observer.observe(messages);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [anchor, wide, dismiss]);

  useEffect(() => {
    // 键盘激活也只保留一个记录浮窗，不能只依赖 pointerdown 关闭旧浮窗。
    document.dispatchEvent(new window.CustomEvent('sage:context-audit-open', { detail: anchor }));
    const onOtherOpen = (event: Event) => {
      if ((event as CustomEvent).detail !== anchor) dismiss();
    };
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !rootRef.current?.contains(target) && !anchor.contains(target)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
      }
    };
    rootRef.current?.focus({ preventScroll: true });
    document.addEventListener('sage:context-audit-open', onOtherOpen);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('sage:context-audit-open', onOtherOpen);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, dismiss]);

  return createPortal(
    <div id={id} className="chat-context-audit-popover" ref={rootRef} role="dialog" aria-label={t('chat.contextAudit.title')} tabIndex={-1}
      style={{ ...position, bottom: 'auto', visibility: position ? 'visible' : 'hidden' }}>
      {audits.length === 1 && !showList
        ? <ContextCompactionAuditDetails audit={audits[0]} onClose={() => dismiss(true)} />
        : <ContextCompactionAuditList audits={audits} onClose={() => dismiss(true)} />}
    </div>,
    document.body,
  );
}

function ContextAuditTrigger({ audits, className, showList, children }: {
  audits: ContextCompactionAudit[];
  className?: string;
  showList?: boolean;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  return <>
    <button type="button" ref={anchorRef} className={className} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>{children}</button>
    {open && anchorRef.current ? <ContextAuditPopover anchor={anchorRef.current} id={id} audits={audits} showList={showList} onClose={() => setOpen(false)} /> : null}
  </>;
}

function ContextCompactionNotice({ m }: { m: ChatMessage }) {
  const t = useT();
  const auditId = m.contextCompaction?.auditId;
  const audit = useAppStore((s) =>
    auditId ? s.currentConversation?.contextCompactionAudits?.find((item) => item.id === auditId) : undefined,
  );
  const label = m.contextCompaction?.trigger === 'manual'
    ? t('chat.contextCompactionManualNotice')
    : t('chat.contextCompactionNotice');
  return (
    <div id={`chat-msg-${m.id}`} className="chat-context-compaction-notice">
      <ContextAuditTrigger audits={audit ? [audit] : []}>
        <FileArchive size={12} />
        <span>{label}</span>
        <span className="chat-context-compaction-time">{formatMessageTime(m.ts)}</span>
      </ContextAuditTrigger>
    </div>
  );
}

/**
 * 时间线上的上下文整理标记（连续同类标记已融合为一组）。
 * 单条时与旧版展示一致；多条时显示 ×N 与时间范围，点开可逐条查看审计。
 */
function ContextCompactionNoticeGroup({ items }: { items: ChatMessage[] }) {
  const t = useT();
  const allAudits = useAppStore((s) => s.currentConversation?.contextCompactionAudits);
  const audits = useMemo(() => {
    const ids = new Set(items.map((i) => i.contextCompaction?.auditId).filter(Boolean));
    return (allAudits ?? []).filter((a) => ids.has(a.id));
  }, [allAudits, items]);
  const trigger = items[0].contextCompaction?.trigger;
  const label = items.length > 1
    ? (trigger === 'manual'
      ? t('chat.contextCompactionManualNoticeTimes', { count: items.length })
      : t('chat.contextCompactionNoticeTimes', { count: items.length }))
    : (trigger === 'manual' ? t('chat.contextCompactionManualNotice') : t('chat.contextCompactionNotice'));
  const first = items[0];
  const last = items[items.length - 1];
  return (
    <div id={`chat-msg-${first.id}`} className="chat-context-compaction-notice">
      <ContextAuditTrigger audits={audits}>
        <FileArchive size={12} />
        <span>{label}</span>
        <span className="chat-context-compaction-time">
          {items.length > 1
            ? `${formatMessageTime(first.ts)} – ${formatMessageTime(last.ts)}`
            : formatMessageTime(first.ts)}
        </span>
      </ContextAuditTrigger>
    </div>
  );
}

function ContextCompactionAuditList({ audits, onClose }: { audits: ContextCompactionAudit[]; onClose?: () => void }) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | undefined>(audits.at(-1)?.id);
  const selected = audits.find((audit) => audit.id === selectedId) ?? audits.at(-1);
  return (
    <div className="chat-context-audit-list">
      {audits.length === 0 ? <div className="chat-context-audit-empty muted small">{t('chat.ctxPanel.auditEmpty')}</div> : null}
      {onClose ? (
        <button type="button" className="chat-context-audit-close chat-context-audit-list-close" onClick={onClose} aria-label={t('chat.contextAudit.close')}>
          <X size={13} />
        </button>
      ) : null}
      <div className="chat-context-audit-col">
        {[...audits].reverse().map((audit) => (
          <button
            type="button"
            key={audit.id}
            className={`chat-context-audit-item${selectedId === audit.id ? ' selected' : ''}`}
            onClick={() => setSelectedId(audit.id)}
          >
            <span>{audit.trigger === 'automatic' ? t('chat.contextAudit.automatic') : t('chat.contextAudit.manual')}</span>
            <span className="muted">{formatMessageTime(audit.at)}</span>
          </button>
        ))}
      </div>
      {selected ? <ContextCompactionAuditDetails audit={selected} /> : null}
    </div>
  );
}

/** 日期分隔符文本：今天/昨天/具体日期 */
function formatDateLabel(isoString: string): string { return formatCasualDateTime(isoString); }

// 输入框自增高：默认 3 行，随内容增长，超过 5 行后固定高度并滚动。
const COMPOSER_MIN_ROWS = 3;
const COMPOSER_MAX_ROWS = 5;

/**
 * 把图片文件转成附件对象。
 * @param maxBytes 图片大小上限（字节），来自「设置」中的可配置项。
 */
async function fileToAttachment(f: File, maxBytes: number): Promise<ImageAttachment | null> {
  if (!SUPPORTED_IMAGE_MIME.has(f.type)) {
    alert(translate('chat.imgTypeErr', { type: f.type || translate('chat.unknown') }));
    return null;
  }
  if (f.size > maxBytes) {
    alert(translate('chat.imgSizeErr', { max: prettyBytes(maxBytes), name: f.name }));
    return null;
  }
  const buf = await f.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { name: f.name, mimeType: f.type, dataBase64: btoa(binary) };
}

// 优化输入全局防重入标记：模型调用期间连续点击按钮只执行一次。
let optimizeInFlight = false;
// 进行中的优化请求 id：取消时置空，用于丢弃迟到的结果并通知主进程中止底层请求。
let optimizeRequestId: string | null = null;

export function ChatView() {
  const conv = useAppStore((s) => {
    // 优先使用 currentConversation
    if (s.currentConversation) return s.currentConversation;
    // 如果 currentConversation 为空但 activeTab 是对话，从 conversations 中查找
    if (s.activeTabId?.startsWith('conv:')) {
      const convId = s.activeTabId.slice(5);
      return s.conversations.find((c) => c.id === convId) || null;
    }
    return null;
  });

  if (!conv) {
    return (
      <div className="empty-state">
        <p className="muted">{translate('chat.notFound')}</p>
      </div>
    );
  }

  return <ConversationChatView key={conv.id} conv={conv} />;
}

function ConversationChatView({ conv }: { conv: ConversationMeta }) {
  useDateTimeSettings();
  // 归档对话：只读展示，禁止提交新输入（输入区替换为提示条）
  const isArchived = !!conv.archived;
  const busy = useAppStore((s) => !!(s.currentConversation && s.busyConvIds[s.currentConversation.id]));
  const pending = useAppStore((s) => s.pendingApprovalsByConv[s.currentConversation?.id ?? ''] ?? []);
  const clarifies = useAppStore((s) => s.pendingClarifiesByConv[s.currentConversation?.id ?? ''] ?? []);
  const send = useAppStore((s) => s.sendChat);
  const abort = useAppStore((s) => s.abortChat);
  const setConvModel = useAppStore((s) => s.setConvModel);
  const setConvThinkingEffort = useAppStore((s) => s.setConvThinkingEffort);
  const setConvChannels = useAppStore((s) => s.setConvChannels);
  const setConvInboundChannels = useAppStore((s) => s.setConvInboundChannels);
  const setConvOutboundChannels = useAppStore((s) => s.setConvOutboundChannels);
  const setConvBroadcastUserChannels = useAppStore((s) => s.setConvBroadcastUserChannels);
  const setConvBroadcastInboundChannels = useAppStore((s) => s.setConvBroadcastInboundChannels);
  const setConvBroadcastAssistantChannels = useAppStore((s) => s.setConvBroadcastAssistantChannels);
  const latestInboundToast = useAppStore((s) => s.latestInboundToast);
  const dismissInboundToast = useAppStore((s) => s.dismissInboundToast);
  const modelProfiles = useAppStore((s) => s.settings?.modelProfiles ?? []);
  const backendEngine = useAppStore(s => s.settings?.backendEngine);
  const codexModel = useAppStore(s => s.settings?.codexModel);
  const modelProviders = useAppStore((s) => s.settings?.modelProviders ?? []);
  const expertDefinitions = useAppStore((s) => s.settings?.expertDefinitions ?? {});
  /** 界面语言：内置角色名称在对话里跟随界面语言展示。 */
  const expertsEn = resolveLanguage(useAppStore((s) => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  /** 全局上下文压缩策略（对话未单独设置时的回退值，仅用于面板展示）。 */
  const globalCtxStrategy = useAppStore((s) => s.settings?.contextStrategy);
  /** 全局上下文窗口大小（tokens），未设置时默认 200000。 */
  const globalCtxWindowSize = useAppStore((s) => s.settings?.contextWindowSize ?? 200000);
  // 附件大小上限（可在「设置」中自定义）。非法/非正值回退到默认。
  const maxImageBytes = useAppStore((s) => {
    const mb = Number(s.settings?.maxImageMB);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_MAX_IMAGE_MB * 1024 * 1024;
  });
  const maxTextFileBytes = useAppStore((s) => {
    const mb = Number(s.settings?.maxTextFileMB);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_MAX_TEXT_FILE_MB * 1024 * 1024;
  });
  const project = useAppStore((s) => s.currentProject);
  const globalVisionModel = useAppStore((s) => s.settings?.selectedVisionModel);
  const globalSelectedModel = useAppStore((s) => s.settings?.selectedModel);
  const modelCapsOf = useModelTypes(modelProviders);
  const effectiveMainModel = effectiveModelSelection(conv.selectedModel, effectiveModelSelection(project?.selectedModel, globalSelectedModel));
  const mainProvider = modelProviders.find(provider => provider.id === effectiveMainModel?.providerId);
  const mainSupportsVision = (!backendEngine || backendEngine === 'api') && !!effectiveMainModel &&
    nativeVisionCapability(effectiveMainModel.modelId, mainProvider ? modelCapsOf(mainProvider, effectiveMainModel.modelId).vision : undefined);
  const t = useT();
  const backendLabel = useBackendLabel();
  const [text, setText] = useState('');
  const [draftImages, setDraftImages] = useState<ImageAttachment[]>([]);
  const [draftPastedTexts, setDraftPastedTexts] = useState<Array<{ id: string; text: string }>>([]);
  const modeDraft: ConversationMode = 'auto';
  // ── 文件链接右键菜单 ──
  const [fileLinkMenu, setFileLinkMenu] = useState<{
    x: number;
    y: number;
    filePath: string;
    absPath: string;
  } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setFileLinkMenu(detail);
    };
    window.addEventListener('file-link-context-menu', handler);
    return () => window.removeEventListener('file-link-context-menu', handler);
  }, []);

  // ── 活动指示去重：尾部消息气泡是否已经自带"正在工作"的视觉反馈 ──
  // 1) pending 且无正文无工具 → 气泡内显示「深度思考 · Ns」计时
  // 2) 正文/工具已按时间顺序渲染，末段是已完成工具组 → 气泡尾部有深度思考计时
  // 3) 最后一个工具还没有 result → 工具卡上显示转圈动画
  // 4) 专家团卡片 pending → 卡片自带 spinner
  // 命中任一时，隐藏底部「{assistant} 正在响应…」，避免同屏两个重复指示。
  const lastMsg = conv.messages[conv.messages.length - 1];
  const bubbleShowsActivity = (() => {
    if (!busy || !lastMsg || lastMsg.role !== 'assistant' || !lastMsg.pending) return false;
    if (lastMsg.experts) return true;
    const calls = lastMsg.toolCalls ?? [];
    if (calls.length > 0 && !calls[calls.length - 1].result) return true;
    const segs = buildMessageSegments(lastMsg);
    // 无任何输出，或末段是工具组（其后将跟思考计时）→ 气泡内有活动反馈
    if (segs.length === 0 || segs[segs.length - 1].kind === 'tools') return true;
    return false;
  })();

  // ── 输入框草稿：按对话隔离存进 store，切 tab / 切对话回来不丢内容 ──
  //
  // 为什么要这么做：切到文件、Spec、其它对话时 ChatView 会被卸载，
  // 局部 useState 随之销毁；切回来重新挂载就是空输入框，用户已经打好的
  // 文字和粘贴的图片全部丢失。store 里的 convDrafts 作为跨挂载的载体。
  //
  // 本地 state 仍是渲染源（避免每次按键都走 store 引发额外渲染），
  // store 只在「挂载时恢复 / 卸载时保存」两个时机读写。
  const draftRef = useRef({ text: '', images: [] as ImageAttachment[], pastedTexts: [] as Array<{ id: string; text: string }>, mode: 'auto' as ConversationMode });
  const historyIndexRef = useRef(-1);
  const inputHistory = useMemo(() => conv.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim()).map(m => m.content as string), [conv.messages]);
  draftRef.current = { text, images: draftImages, pastedTexts: draftPastedTexts, mode: modeDraft };
  const convIdRef = useRef(conv.id);
  const attachmentIntentRef = useRef(false);
  useLayoutEffect(() => {
    attachmentIntentRef.current = false;
    return registerConversationDraftReader(conv.id, () => ({ ...draftRef.current, attachmentIntent: attachmentIntentRef.current }));
  }, [conv.id]);

  // 用 useLayoutEffect 而非 useEffect：恢复发生在浏览器绘制之前，
  // 避免切回对话时先闪一下空输入框再填回草稿。
  useLayoutEffect(() => {
    // 挂载 / 切换对话：从 store 恢复该对话的草稿
    const d = useAppStore.getState().convDrafts[conv.id];
    setText(d?.text ?? '');
    setDraftImages(d?.images ?? []);
    setDraftPastedTexts(d?.pastedTexts ?? []);
    convIdRef.current = conv.id;
    // 卸载 / 切走前把当前输入写回 store。
    // 用 ref 取最新值（cleanup 闭包里直接读 state 会拿到过期值），
    // 用 convIdRef 而不是 conv.id —— cleanup 执行时 conv.id 已是新对话的 id，
    // 直接读会把上一个对话的草稿误写到新对话名下。
    return () => {
      const cur = draftRef.current;
      useAppStore.getState().setConvDraft(convIdRef.current, {
        text: cur.text,
        images: cur.images,
        pastedTexts: cur.pastedTexts,
        mode: cur.mode,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  // 点击输入区的粘贴/拖入图片缩略图可放大查看
  const [draftLightboxSrc, setDraftLightboxSrc] = useState<string | null>(null);
  const [draftLightboxIndex, setDraftLightboxIndex] = useState(0);
  // 智能发送/停止按钮：长按停止（需二次确认），单击发送
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  // 拖拽状态：拖拽计数器（防止经过子元素时闪烁）
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  // 文件拖入选择：非图片文件拖入后弹出选项卡
  const [dropChoice, setDropChoice] = useState<{ file: File } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 纯图片选择：只接受图片，走图片消息通道（与粘贴图片一致）
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const messagesInnerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // 监听工具栏宽度：窄于阈值（模式按钮与模型/token 按钮挤到放不下）时收起模式文字。
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // ── 右键上下文菜单：选中文本后右键弹出（搜索/翻译/检索/复制） ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  // ── AI 翻译浮窗：与文件内 AI 翻译同一体验（多语言译文逐条可复制，点浮窗外/Esc 关闭） ──
  const [translatePop, setTranslatePop] = useState<TranslatePopState | null>(null);
  useTranslatePopDismiss(translatePop !== null, () => setTranslatePop(null));
  // 铃铛计数：所有绑定渠道的并集（去重）
  const broadcastTotalCount = useMemo(() => {
    const sets = [
      conv.inboundChannelIds,
      conv.outboundChannelIds,
      conv.broadcastUserChannelIds,
      conv.broadcastInboundChannelIds,
      conv.broadcastAssistantChannelIds,
    ];
    const unique = new Set<string>();
    for (const s of sets) {
      if (s) for (const id of s) unique.add(id);
    }
    return unique.size;
  }, [conv]);

  // 导出菜单
  const [showExportMenu, setShowExportMenu] = useState(false);

  // 复制对话为图片到剪贴板：点击后直接写入系统剪贴板，无需先保存。
  const [imgCopied, setImgCopied] = useState(false);
  const imgCopyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCopyConvImage = useCallback(async () => {
    if (!messagesInnerRef.current) return;
    const ok = await copyElementToClipboard(messagesInnerRef.current);
    if (ok) {
      setImgCopied(true);
      clearTimeout(imgCopyTimer.current);
      imgCopyTimer.current = setTimeout(() => setImgCopied(false), 1500);
    }
  }, []);
  useEffect(() => () => clearTimeout(imgCopyTimer.current), []);

  // 导出对话为 Markdown 文件
  const onExportConvMarkdown = useCallback(async () => {
    if (!conv.messages.length) return;
    const title = conv.title || 'chat';
    const lines: string[] = [`# ${title}`, ''];

    for (const msg of conv.messages) {
      if (msg.role === 'user') {
        lines.push(`## 👤 ${translate('chat.exportUser')}`);
      } else if (msg.role === 'assistant') {
        lines.push(`## 🤖 ${msg.modelId || translate('chat.aiAssistant')}`);
      } else {
        continue;
      }
      if (msg.content) {
        lines.push('');
        lines.push(msg.content);
      }
      lines.push('');
    }

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  }, [conv]);

  // 导出对话为 PNG 图片
  const onExportConvImage = useCallback(async () => {
    if (messagesInnerRef.current) {
      await saveElementAsImage(
        messagesInnerRef.current,
        imageFilename(conv.title || 'conversation'),
      );
    }
    setShowExportMenu(false);
  }, [conv.title]);

  // 复制对话为图片到剪贴板
  const onCopyConvImageFromMenu = useCallback(async () => {
    await onCopyConvImage();
    setShowExportMenu(false);
  }, [onCopyConvImage]);

  // 渠道绑定下拉
  const [channelList, setChannelList] = useState<Array<{ id: string; name: string; type: string; enabled: boolean; inboundWebhookPath?: string }>>([]);
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  /** 上下文面板：用量 + 对话级压缩策略设置 + 整理上下文。 */
  const [showCtxPanel, setShowCtxPanel] = useState(false);
  useEffect(() => {
    const popovers = [
      { open: showChannelPicker, inside: '.chat-channel-picker, .chat-channel-picker-dropdown', close: setShowChannelPicker },
      { open: showCtxPanel, inside: '.chat-ctx-wrapper, .chat-ctx-panel, .chat-context-audit-popover', close: setShowCtxPanel },
      { open: showExportMenu, inside: '.chat-export-wrapper', close: setShowExportMenu },
    ].filter(popover => popover.open);
    if (!popovers.length) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      for (const popover of popovers) {
        if (!(target instanceof Element) || !target.closest(popover.inside)) popover.close(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.chat-context-audit-popover')) return;
      for (const popover of popovers) popover.close(false);
    };
    // Toolbar containment constrains fixed backdrops; capture also survives stopped bubbling.
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', escape);
    };
  }, [showChannelPicker, showCtxPanel, showExportMenu]);
  // 整理记录入口随上下文面板卸载，浮窗与监听一并清理。
  const [compacting, setCompacting] = useState(false);
  /** 上下文窗口大小自定义输入（当选择"其他"时）。 */
  const [customWindowSize, setCustomWindowSize] = useState('');
  /** 下拉框当前选中项：跟踪"custom"选中状态（与 globalCtxWindowSize 解耦）。 */
  const [windowSizeSelection, setWindowSizeSelection] = useState<'200k' | '400k' | '1M' | 'custom'>(() => {
    const v = useAppStore.getState().settings?.contextWindowSize ?? 200000;
    return v === 200000 ? '200k' : v === 400000 ? '400k' : v === 1000000 ? '1M' : 'custom';
  });

  // 当 globalCtxWindowSize 在其他地方被修改时，同步下拉框选择状态
  useEffect(() => {
    setWindowSizeSelection(
      globalCtxWindowSize === 200000 ? '200k' :
      globalCtxWindowSize === 400000 ? '400k' :
      globalCtxWindowSize === 1000000 ? '1M' : 'custom'
    );
  }, [globalCtxWindowSize]);

  // 加载项目渠道列表（用于对话绑定）
  // 刷新函数，可在多个时机调用
  const refreshChannelList = () => {
    if (!project) { setChannelList([]); return; }
    void window.api.listChannels(project.path).then((list: any[]) => {
      setChannelList(list.map((c) => {
        // 根据渠道类型判断是否支持入站（而不是依赖旧数据中的 inboundWebhookPath）
        // 单向渠道（email, feishu-webhook）不支持入站
        const supportsInbound = c.type !== 'email' && c.type !== 'feishu-webhook';
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          enabled: c.enabled,
          inboundWebhookPath: supportsInbound ? c.inboundWebhookPath : undefined,
        };
      }));
    });
  };

  useEffect(() => {
    refreshChannelList();
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // 对话切换时刷新，确保绑定的渠道信息是最新的
  useEffect(() => {
    refreshChannelList();
  }, [conv.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Stick to bottom" flag: true means we auto-scroll on new content; false
  // means the user has scrolled up to look at history and we leave them alone.
  // Default true so the very first send and conversation-open auto-scroll.
  const stickyRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const pinToBottom = () => {
    const el = scrollerRef.current;
    if (!el || !stickyRef.current || scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const current = scrollerRef.current;
      if (current && stickyRef.current) current.scrollTop = current.scrollHeight;
    });
  };

  // Auto-scroll on new content, but only when the user is still pinned to
  // the bottom (within 80px tolerance). useLayoutEffect runs synchronously
  // after DOM mutations and before paint, so scrollHeight reflects the
  // latest committed content — important for streaming markdown.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Keep React-committed streaming content pinned before paint to avoid a
    // visible one-frame jump; ResizeObserver changes are coalesced below.
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
  }, [conv.messages.length, conv.messages[conv.messages.length - 1]?.content, busy, pending.length]);

  // ResizeObserver fallback: ReactMarkdown re-renders sync, but inside it
  // syntax highlighting, fenced code blocks, and image onload can grow the
  // box AFTER our layout effect ran. Observe the scroller and its content
  // wrapper and re-pin to bottom whenever the height changes — but only
  // when the user hasn't scrolled away from the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      if (stickyRef.current) pinToBottom();
    });
    obs.observe(el);
    if (el.firstElementChild) obs.observe(el.firstElementChild);
    return () => {
      obs.disconnect();
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, []);

  const onScrollerScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    // Keep the pin threshold tight: plan/status cards can update repeatedly,
    // and a wide threshold steals the user's scroll when they inspect nearby content.
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  };

  // Switching to a different conversation: re-pin to bottom regardless of
  // where the user was in the previous one.
  useEffect(() => {
    stickyRef.current = true;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.id]);

  // 输入框自增高：默认 3 行，随内容增长；超过 5 行后固定高度并出现滚动条。
  const scheduledMessageTarget=useAppStore(s=>s.scheduledMessageTarget);
  useEffect(()=>{
    if(scheduledMessageTarget?.convId!==conv.id)return;
    const frame=requestAnimationFrame(()=>{
      const target=document.getElementById('chat-msg-'+scheduledMessageTarget.messageId)??document.querySelector<HTMLElement>(`[data-source-message-id="${CSS.escape(scheduledMessageTarget.messageId)}"]`);
      if(!target)return;
      stickyRef.current=false;
      for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;
      target.scrollIntoView({block:'center',behavior:'smooth'});
      target.classList.add('chat-plan-target');
      setTimeout(()=>target.classList.remove('chat-plan-target'),1800);
      useAppStore.setState({scheduledMessageTarget:undefined});
    });
    return()=>cancelAnimationFrame(frame);
  },[conv.id,scheduledMessageTarget]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    let lineHeight = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineHeight)) lineHeight = (parseFloat(cs.fontSize) || 14) * 1.5;
    const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const minH = lineHeight * COMPOSER_MIN_ROWS + padding;
    const maxH = lineHeight * COMPOSER_MAX_ROWS + padding;
    const next = Math.max(minH, Math.min(el.scrollHeight, maxH));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxH + 1 ? 'auto' : 'hidden';
  }, [text]);

  // 编辑用户消息：内容回收进输入框，并从该消息起截断。
  // - 末条且无回复：仅删除本条（内容已在输入框，无需确认）；
  // - 已有回复：确认后删除本条及其后全部回复。
  const handleEditUserMessage = useCallback(async (msg: ChatMessage) => {
    const store = useAppStore.getState();
    const conv = store.currentConversation;
    if (!conv) return;
    if (conv.archived) return; // 归档对话只读
    const realId = msg.timelineSourceId ?? msg.id;
    const idx = conv.messages.findIndex((x) => x.id === realId);
    if (idx < 0) return;
    const hasReplies = idx < conv.messages.length - 1;
    if (hasReplies && !(await confirmDialog({ message: t('chat.editMessageConfirm'), danger: true }))) return;
    setText(msg.content ?? '');
    setDraftImages(msg.images ?? []);
    textareaRef.current?.focus();
    void store.truncateFromMessage(realId);
  }, []);

  // reload：从该用户消息重新发起提问（删除本条及其后回复，再以原内容重发）。
  const handleReloadUserMessage = useCallback(async (msg: ChatMessage) => {
    const store = useAppStore.getState();
    const conv = store.currentConversation;
    if (!conv) return;
    if (conv.archived) return; // 归档对话只读
    const realId = msg.timelineSourceId ?? msg.id;
    const idx = conv.messages.findIndex((x) => x.id === realId);
    if (idx < 0) return;
    if (idx < conv.messages.length - 1 && !(await confirmDialog({ message: t('chat.reloadMessageConfirm'), danger: true }))) return;
    void store.reloadFromUserMessage(realId);
  }, []);

  const onSubmit = async () => {
    // 归档对话只读：不允许提交新输入
    if (isArchived) return;
    // Allow sending while busy — message enters FIFO queue (processed after current turn)
    if (!text.trim() && draftImages.length === 0 && draftPastedTexts.length === 0) return;
    // 优化输入进行中：输入框已锁定，此时发送会与稍后写回的优化结果互相覆盖
    if (optimizeInFlight) return;
    const submission = prepareImageSubmission(composeDraftText(text), draftImages, t('chat.fileImagePrompt'));
    const messageText = submission.text;
    const imgs = submission.attachments;
    const m = modeDraft;
    if (detectPotentialSecrets(messageText).length && !(await confirmDialog({
      title: t('chat.secretWarningTitle'),
      message: t('chat.secretWarningMessage'),
      okLabel: t('chat.secretWarningSend'),
      cancelLabel: t('chat.secretWarningReview'),
      danger: true,
    }))) return;
    setText('');
    setDraftImages([]);
    setDraftPastedTexts([]);
    // 已发送 → 草稿作废，避免切走再回来时卸载逻辑把空内容写回或残留旧内容
    useAppStore.getState().clearConvDraft(conv.id);
    await send(messageText, imgs.length > 0 ? imgs : undefined, m);
  };

  // 上下文用量：优先 meta.lastContextEstimate（每轮真实构建估算，整理后立即刷新），
  // 其次逐请求 contextUsage，最后才回退全轮累加 usage（口径见 shared/context-meter.ts）。
  const ctx = useMemo(
    () => readContextUsage({ lastContextEstimate: conv.lastContextEstimate, messages: conv.messages }),
    [conv.messages, conv.lastContextEstimate],
  );

  // ── 对话级上下文压缩策略 ──────────────────────────────────────────
  // 未单独设置的字段跟随全局（设置 → 上下文压缩策略）。面板里每个字段都能
  // 切回「跟随全局」，此时该字段会从对话配置中移除，而不是写入一个显式值。
  const convCtxStrategy: ContextStrategyConfig | null = conv.contextStrategy ?? null;
  const effCtxMode = convCtxStrategy?.mode ?? globalCtxStrategy?.mode ?? 'auto';
  const effCtxSummary =
    convCtxStrategy?.summaryStrategy ?? globalCtxStrategy?.summaryStrategy ?? 'auto';
  // 与 context-manager.ts 中 MODE_PRESETS 保持一致：未显式配置时按模式给默认值。
  const effKeepRecentTurns =
    convCtxStrategy?.keepRecentTurns ??
    globalCtxStrategy?.keepRecentTurns ??
    (effCtxMode === 'conservative' ? 5 : effCtxMode === 'aggressive' ? 2 : 3);

  /**
   * 清理翻译文本中括号里的说明后缀（如"均衡（默认）"→"均衡"）。
   * 用于"当前生效"显示：用户已明确选择某值时，不应再显示"（默认）"等提示。
   */
  const stripParenthetical = (text: string): string => text.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();

  /** 更新对话级策略的单个字段；传 undefined 表示该字段跟随全局。 */
  const patchConvCtx = async (patch: Partial<ContextStrategyConfig>) => {
    const next: ContextStrategyConfig = { ...(convCtxStrategy ?? {}), ...patch };
    for (const k of Object.keys(next) as Array<keyof ContextStrategyConfig>) {
      if (next[k] === undefined) delete next[k];
    }
    // 所有字段都跟随全局 → 整条配置清空，回到「沿用全局」状态
    const empty = Object.keys(next).length === 0;
    await useAppStore.getState().setConvContextStrategy(empty ? null : next);
  };

  /** 更新全局上下文窗口大小设置。 */
  const updateContextWindowSize = async (size: number | undefined) => {
    const current = useAppStore.getState().settings;
    const next = { contextWindowSize: size };
    await useAppStore.getState().saveSettings(next);
  };

  /** 整理上下文：把较早的对话压缩成摘要，只保留最近 N 轮完整对话。 */
  const onCompactContext = async () => {
    if (compacting) return;
    // 轮数跟随压缩策略：未显式配置且模式为 auto 时，主进程按内容在 2～5 轮间动态选择
    // （aggressive=2 / balanced=3 / conservative=5），确认文案里显示真实范围而不是写死的 3。
    const hasExplicitTurns =
      convCtxStrategy?.keepRecentTurns !== undefined || globalCtxStrategy?.keepRecentTurns !== undefined;
    const turnsLabel = !hasExplicitTurns && effCtxMode === 'auto' ? '2～5' : String(effKeepRecentTurns);
    const ok = await confirmDialog({
      message: t('chat.compactConfirm', { turns: turnsLabel }),
    });
    if (!ok) return;
    setCompacting(true);
    try {
      const result = await window.api.compactConversation(conv.id, effKeepRecentTurns);
      if (result.ok && result.stats) {
        // 更新当前对话
        if (result.meta) {
          useAppStore.setState({ currentConversation: result.meta });
        }
        // 刷新对话列表
        await useAppStore.getState().refreshConversations?.();
        setShowCtxPanel(false);
        // 显示成功提示（原始消息未删除，仅请求上下文用摘要替代）
        window.alert(
          t('chat.organizeOk', { summarized: result.stats.summarizedMessages, kept: result.stats.keptMessages })
        );
      } else {
        window.alert(t('chat.organizeFail', { error: result.error || t('chat.unknownError') }));
      }
    } catch (err) {
      console.error('[compactConversation] failed:', err);
      window.alert(t('chat.organizeFailConsole'));
    } finally {
      setCompacting(false);
    }
  };

  const addImages = async (files: FileList | File[], asFile = false) => {
    if (files.length) attachmentIntentRef.current = true;
    const next: ImageAttachment[] = [];
    for (const f of Array.from(files)) {
      const att = await fileToAttachment(f, maxImageBytes);
      if (att) {
        if (asFile) {
          const filePath = window.api.getPathForFile(f);
          if (!filePath) { window.alert(t('chat.fileImageNoPath')); continue; }
          att.attachmentPath = filePath;
        }
        next.push(att);
      }
    }
    if (next.length) setDraftImages((prev) => [...prev, ...next]);
  };

  /**
   * 附件按钮的统一入口：接受任意文件，按类型分流。
   *
   * 用户主动选择附件，按文件引用或文本内容提交：
   *  - 图片          → 文件引用（保留本地预览，发送路径供 Agent 读取）
   *  - 文本类文件     → 读取内容插入输入框（带路径标题），超大只插路径
   *  - 其它（二进制）  → 仅插入项目相对路径或绝对路径作为上下文引用
   *
   * 纯图片上传另有独立按钮（附件按钮左侧，accept 限定图片），
   * 粘贴图片同样走图片消息通道，不经过附件分流。
   */
  const addAttachments = async (files: FileList | File[]) => {
    const proj = project;
    const list = Array.from(files);
    if (list.length === 0 || !proj) return;
    attachmentIntentRef.current = true;

    const images: File[] = [];
    const texts: File[] = [];
    const others: File[] = [];
    for (const f of list) {
      // 图片作为文件引用保留预览；不混入模型视觉输入。
      if (f.type.startsWith('image/')) images.push(f);
      else if (isTextFile(f.name, f.type)) texts.push(f);
      else others.push(f);
    }

    if (images.length) await addImages(images, true);

    /** 通过 preload 读取本地路径；项目内文件转成相对路径。 */
    const pathFor = (file: File): string => {
      const full = window.api.getPathForFile(file);
      if (!full) return file.name;
      const prefix = proj.path.endsWith('/') ? proj.path : `${proj.path}/`;
      return full.startsWith(prefix)
        ? full.slice(prefix.length)
        : full;
    };

    // 文本文件：读内容插入输入框（与 dropChoice 的 content 分支同逻辑）
    for (const f of texts) {
      if (f.size > maxTextFileBytes) {
        const p = pathFor(f);
        setText((t) => (t ? `${t}\n${p}` : p));
        continue;
      }
      const text = await f.text();
      const p = pathFor(f);
      const block = `${p}:\n\`\`\`\n${text}\n\`\`\``;
      setText((prev) => (prev ? `${prev}\n\n${block}` : block));
    }

    // 二进制 / 不支持内联预览的文件：只插入路径引用
    if (others.length) {
      const block = others.map(pathFor).join('\n');
      setText((t) => (t ? `${t}\n${block}` : block));
    }
  };

  // ── 拖拽文件进入聊天区 ──────────────────────────────────────────
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      dragCounter.current++;
      if (dragCounter.current === 1) setIsDragging(true);
    }
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    attachmentIntentRef.current = true;

    // 图片走原有附件流程
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));

    if (images.length > 0) void addImages(images);

    // 非图片文件：弹出选择（多个文件只弹第一个）
    if (others.length > 0) {
      setDropChoice({ file: others[0] });
    }
  };

  /** 选择 1：只插入文件绝对路径到输入框 */
  const insertFilePath = () => {
    if (!dropChoice) return;
    const absPath = window.api.getPathForFile(dropChoice.file) || dropChoice.file.name;
    insertAtCursor(absPath);
    setDropChoice(null);
  };

  /** 选择 2：读取文件内容，附加在消息文本里一起发送 */
  const attachFileContent = async () => {
    if (!dropChoice) return;
    const file = dropChoice.file;
    const absPath = window.api.getPathForFile(file) || file.name;
    setDropChoice(null);

    if (file.size > maxTextFileBytes) {
      alert(t('chat.fileTooBig', { size: prettyBytes(file.size), max: prettyBytes(maxTextFileBytes) }));
      insertAtCursor(absPath);
      return;
    }
    try {
      const content = await file.text();
      // 把文件内容作为消息上下文拼入文本——Claude 能看到绝对路径和内容。
      const block = `\n\n[文件: ${absPath}]\n\`\`\`\n${content}\n\`\`\``;
      setText((prev) => (prev ? prev + block : block.trimStart()));
    } catch {
      alert(t('chat.fileReadFail', { name: file.name }));
      insertAtCursor(absPath);
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) {
      const plain = e.clipboardData?.getData('text/plain') ?? '';
      if (plain.length >= LONG_PASTE_THRESHOLD) {
        e.preventDefault();
        setDraftPastedTexts((prev) => [...prev, { id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: plain }]);
      }
      return;
    }
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && f.type.startsWith('image/')) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      await addImages(files);
      return;
    }
    const plain = e.clipboardData.getData('text/plain');
    if (plain.length >= LONG_PASTE_THRESHOLD) {
      e.preventDefault();
      setDraftPastedTexts((prev) => [...prev, { id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: plain }]);
    }
  };

  const composeDraftText = (plainText: string, pasted = draftPastedTexts) => [
    plainText.trim(),
    ...pasted.map((item, index) => `${t('chat.pasteCardPrompt', { n: index + 1 })}\n${item.text}`),
  ].filter(Boolean).join('\n\n');

  // 插话：在 AI 执行过程中注入消息，下一个安全边界生效（不停止当前执行）
  const onInterject = async () => {
    // 归档对话只读：输入区已经不渲染，这里再挡一道，免得快捷键/旧闭包绕过展示层直接打 IPC
    if (isArchived) return;
    const submission = prepareImageSubmission(composeDraftText(text), draftImages, t('chat.fileImagePrompt'));
    const trimmed = submission.text;
    if ((!trimmed && !submission.attachments.length) || !conv) return;
    if (detectPotentialSecrets(trimmed).length && !(await confirmDialog({
      title: t('chat.secretWarningTitle'),
      message: t('chat.secretWarningMessage'),
      okLabel: t('chat.secretWarningSend'),
      cancelLabel: t('chat.secretWarningReview'),
      danger: true,
    }))) return;
    // 清空输入框并重置高度（本组件状态变量是 text / setText）
    setText('');
    useAppStore.getState().clearConvDraft(conv.id);
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; }
    // 调用插话 IPC：执行中走插话队列；空闲时退化为普通发送
    if (busy) {
      // 图片与文字是一个整体：插话时把草稿图片一并带上，成功后才清空
      const imgs = submission.attachments.length > 0 ? submission.attachments : undefined;
      try {
        const result = await window.api.interjectChat(conv.id, trimmed, imgs);
        if (!result?.ok) {
          setText(current => current || text);
          useAppStore.getState().setConvError(result?.error ?? t('chat.interjectFail'));
        } else {
          setDraftImages([]);
          setDraftPastedTexts([]);
        }
      } catch (error) {
        setText(current => current || text);
        useAppStore.getState().setConvError(String(error));
      }
    } else {
      // 空闲退化发送：与 onSubmit 同口径携带图片与执行模式（否则首句会丢 mode）
      // 自动档：提交首句时按复杂度解析为智能体/专家团，并回写选择器（确认后即选中解析结果）
      await send(trimmed, submission.attachments.length > 0 ? submission.attachments : undefined, 'auto');
      setDraftImages([]);
      setDraftPastedTexts([]);
    }
  };

  // 优化输入：取输入框内容 → 主进程一次性调用生效模型 → 结果原地替换输入框
  // （不创建临时对话、不切换对话，输入框内容就地更新）
  // 优化期间输入框锁定只读；长按按钮弹出「取消优化」，避免模型无响应时把输入框永久锁死。
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [showOptimizeCancel, setShowOptimizeCancel] = useState(false);
  // ── 语音输入（macOS 系统听写）：可用性与文字输入一致（优化中锁定）；录音中实时写入输入框 ──
  const composerRef = useRef<HTMLDivElement>(null);
  const [voiceRec, setVoiceRec] = useState(false);
  const [voiceRequested, setVoiceRequested] = useState(false);
  const composerShortcutOverrides = useAppStore(s => s.settings?.shortcuts);
  const [voiceWave, setVoiceWave] = useState<number[]>([]);
  // 语音授权被拒时记录被拒面板（麦克风/语音识别），弹出带「打开系统设置」按钮的提示
  const [voiceDeniedPane, setVoiceDeniedPane] = useState<'microphone' | 'speech' | null>(null);
  // 采音失败的原始错误（NotAllowedError/NotFoundError/NotReadableError…），展示在提示框便于定位
  const [voiceDeniedDetail, setVoiceDeniedDetail] = useState('');
  const voiceEventConversation = useRef<string|null>(null);
  const currentVoiceConversation = useRef(conv.id);currentVoiceConversation.current=conv.id;
  const voiceBaseRef = useRef('');
  const voiceSegsRef = useRef<string[]>([]);
  const voiceLocaleRef = useRef('zh-CN');
  const voiceCaptureRef = useRef<VoiceCapture | null>(null);
  const stopVoiceCapture = useCallback(() => {
    voiceCaptureRef.current?.stop();
    voiceCaptureRef.current = null;
    setVoiceWave([]);
  }, []);

  // 订阅主进程识别事件：partial=当前段实时文本，segment=定稿段，end/error/status=状态收口
  useEffect(() => {
    return window.api.onVoiceEvent((ev) => {
      if(voiceEventConversation.current!==currentVoiceConversation.current)return;
      if (ev.t === 'partial') {
        setText(voiceBaseRef.current + joinVoiceText(voiceSegsRef.current, voiceLocaleRef.current) + (ev.text ?? ''));
      } else if (ev.t === 'segment') {
        if (ev.text) voiceSegsRef.current = [...voiceSegsRef.current, ev.text];
        setText(voiceBaseRef.current + joinVoiceText(voiceSegsRef.current, voiceLocaleRef.current));
      } else if (ev.t === 'status') {
        if (ev.auth && ev.auth !== 'authorized') {
          voiceSessionRef.current?.ended();
          setVoiceRec(false);
          stopVoiceCapture();
          setVoiceDeniedPane(ev.which === 'speech' ? 'speech' : 'microphone');
        }
      } else if (ev.t === 'error') {
        voiceSessionRef.current?.ended();
        setVoiceRec(false);
        stopVoiceCapture();
        alert(ev.message ? `${translate('chat.voiceError')}\n${ev.message}` : translate('chat.voiceError'));
      } else if (ev.t === 'end') {
        voiceSessionRef.current?.ended();
        setVoiceRec(false);
        stopVoiceCapture();
      }
    });
  }, []);

  // 录音中被「优化输入」：先停录音（输入框即将锁定，与文字输入一致）
  useEffect(() => {
    if (voiceRec && isOptimizing) {
      setVoiceRec(false);
      stopVoiceCapture();
      void window.api.voiceStop();
    }
  }, [isOptimizing, voiceRec, stopVoiceCapture]);

  // 切换对话/卸载时停止录音，避免麦克风跨对话占用
  useEffect(() => () => { stopVoiceCapture(); void window.api.voiceStop(); }, [stopVoiceCapture]);

  const voiceHooksRef = useRef({ text, isOptimizing, isArchived });
  voiceHooksRef.current = { text, isOptimizing, isArchived };
  const voiceSessionRef = useRef<VoiceSession>();
  if (!voiceSessionRef.current) voiceSessionRef.current = new VoiceSession({
    prepare: async () => {
      const current = voiceHooksRef.current;
      if (current.isOptimizing || current.isArchived) return false;
      voiceEventConversation.current=currentVoiceConversation.current;
      voiceBaseRef.current = current.text && !/\s$/.test(current.text) ? `${current.text} ` : current.text;
      voiceSegsRef.current = [];
      voiceLocaleRef.current = resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale) === 'en' ? 'en-US' : 'zh-CN';
      const result = await window.api.voiceEnsureMic();
      if (!result?.ok) { setVoiceDeniedDetail(`mic TCC: ${result?.status ?? 'denied'}`); setVoiceDeniedPane('microphone'); return false; }
      return true;
    },
    capture: async () => {
      const capture = await startVoiceCapture(b64 => window.api.voiceAudio(b64), useAppStore.getState().settings?.voiceInputDeviceId,
        level => setVoiceWave(previous => [...previous.slice(-1023), level]));
      voiceCaptureRef.current = capture; setVoiceDeniedDetail(''); return capture;
    },
    start: async () => {
      const result = await window.api.voiceStart(voiceLocaleRef.current);
      if (!result?.ok) {
        if (result?.error === 'mic-denied') setVoiceDeniedPane('microphone');
        else alert(`${translate(result?.error === 'missing' ? 'chat.voiceMissing' : 'chat.voiceBusy')} (${result?.error ?? 'unknown'})`);
      }
      return !!result?.ok;
    },
    stop: () => window.api.voiceStop(),
    active: active => { setVoiceRec(active); if (!active) stopVoiceCapture(); },
    requested: setVoiceRequested,
    error: error => { setVoiceDeniedDetail(String((error as Error)?.message ?? error)); setVoiceDeniedPane('microphone'); },
  });
  const toggleVoice = useCallback(() => {
    voiceSessionRef.current!.toggle();
  }, []);
  useEffect(() => {
    if (isOptimizing || isArchived) voiceSessionRef.current?.stop();
  }, [isOptimizing, isArchived]);
  useEffect(() => () => {voiceEventConversation.current=null;voiceSessionRef.current?.stop();}, [conv.id]);
  useComposerShortcuts(conv.id, !isArchived && !isOptimizing, !isArchived && !isOptimizing && !voiceRequested, {
    toggleVoice,
    beginHold: () => voiceSessionRef.current!.beginHold(),
    endHold: () => voiceSessionRef.current!.endHold(),
    captureScreenshot: () => { void window.api.captureScreenshot().catch(error => console.error('Screenshot window failed to open', error)); },
  });
  const voiceShortcutTitle = ['voiceHold', 'voiceToggle'].map(action => {
    const keys = shortcutDisplay(action, composerShortcutOverrides);
    return keys ? `${t(`settings.shortcuts.${action}`)}: ${keys}` : '';
  }).filter(Boolean).join('\n');
  const optimizeLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optimizeLongPressFiredRef = useRef(false);

  const clearOptimizeLongPress = useCallback(() => {
    if (optimizeLongPressRef.current) {
      clearTimeout(optimizeLongPressRef.current);
      optimizeLongPressRef.current = null;
    }
  }, []);

  // 取消优化：立刻恢复可输入，并中止主进程的模型请求；
  // 迟到的返回结果由 requestId 校验丢弃，不会覆盖用户当前输入。
  const cancelOptimize = useCallback(() => {
    const rid = optimizeRequestId;
    optimizeRequestId = null;
    optimizeInFlight = false;
    optimizeLongPressFiredRef.current = false;
    clearOptimizeLongPress();
    setShowOptimizeCancel(false);
    setIsOptimizing(false);
    if (rid) void window.api.llmCompleteAbort(rid).catch(() => {});
  }, [clearOptimizeLongPress]);

  useEffect(() => () => clearOptimizeLongPress(), [clearOptimizeLongPress]);

  // 优化中按 Esc 同样取消（键盘出口，与长按等效）
  useEffect(() => {
    if (!isOptimizing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelOptimize();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOptimizing, cancelOptimize]);

  // 优化中长按 500ms 弹出取消按钮（与发送按钮「长按停止」同一交互习惯）
  const startOptimizeLongPress = () => {
    clearOptimizeLongPress();
    optimizeLongPressRef.current = setTimeout(() => {
      optimizeLongPressFiredRef.current = true;
      optimizeLongPressRef.current = null;
      setShowOptimizeCancel(true);
    }, 500);
  };

  const onOptimizeInput = async () => {
    const original = text.trim();
    if (!original || !conv || optimizeInFlight) return;

    const requestId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    optimizeRequestId = requestId;
    optimizeInFlight = true;
    setIsOptimizing(true);
    setShowOptimizeCancel(false);
    try {
      const optimized = (await window.api.llmComplete({
        prompt: `请优化以下用户输入，使其更清晰、完整、易于理解。系统已以多轮历史消息形式提供当前对话上下文窗口内的内容，优化要点：
1. 结合对话上下文理解指代与话题延续（如"它""上面那个""继续"等），做针对性优化而非孤立改写
2. 补充必要的上下文和背景信息
3. 明确具体的需求或问题
4. 改善表达的准确性和流畅度
5. 保持原意不变；若原输入已足够清晰，只做轻微润色

用户输入：
${original}

请直接输出优化后的文本，不要添加任何解释或前缀。`,
        convId: conv.id,
        projectPath: conv.projectPath,
        requestId,
      })) as string;
      // 已被取消：丢弃结果，保持输入框原样
      if (optimizeRequestId !== requestId) return;
      const trimmed = (optimized ?? '').trim();
      if (trimmed) {
        setText(trimmed);
      } else {
        alert(t('chat.optimizeFailEmpty'));
      }
    } catch (err) {
      // 取消导致的中止不是错误，静默返回（输入框已在取消时恢复）
      if (optimizeRequestId !== requestId) return;
      console.error('[onOptimizeInput] Error:', err);
      alert(t('chat.optimizeFail', { error: (err as { message?: string })?.message ?? String(err) }));
    } finally {
      if (optimizeRequestId === requestId) {
        optimizeRequestId = null;
        optimizeInFlight = false;
        setIsOptimizing(false);
      }
      optimizeLongPressFiredRef.current = false;
      clearOptimizeLongPress();
      setShowOptimizeCancel(false);
    }
  };

  // 优化中的按钮点击：长按抬手产生的 click 吞掉（保持取消气泡可见），短按切换气泡显隐
  const onOptimizeBtnClick = () => {
    if (!isOptimizing) {
      void onOptimizeInput();
      return;
    }
    if (optimizeLongPressFiredRef.current) {
      optimizeLongPressFiredRef.current = false;
      return;
    }
    setShowOptimizeCancel((v) => !v);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && inputHistory.length > 0) {
      const el = e.currentTarget;
      const atBoundary = e.key === 'ArrowUp' ? (el.selectionStart === 0 && el.selectionEnd === 0) : (el.selectionStart === text.length && el.selectionEnd === text.length);
      if (atBoundary || historyIndexRef.current >= 0) {
        e.preventDefault();
        const next = e.key === 'ArrowUp'
          ? Math.min(inputHistory.length - 1, historyIndexRef.current < 0 ? 0 : historyIndexRef.current + 1)
          : Math.max(-1, historyIndexRef.current < 0 ? -1 : historyIndexRef.current - 1);
        historyIndexRef.current = next;
        setText(next < 0 ? '' : inputHistory[inputHistory.length - 1 - next]);
        requestAnimationFrame(() => { el.focus(); el.setSelectionRange(0, 0); });
        return;
      }
    }
    // Cmd/Ctrl + Enter = 插话（执行过程中注入，下一个安全边界生效）
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (busy) {
        onInterject();
      } else {
        onSubmit(); // 空闲时退化为普通发送
      }
      return;
    }
    // Enter to send, Shift+Enter for newline.
    // Skip when an IME is composing (e.g., committing Chinese/Japanese input).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  const insertAtCursor = (s: string) => {
    const el = textareaRef.current;
    if (!el) {
      setText((t) => t + s);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + s + text.slice(end);
    setText(next);
    // setText is async — wait for React to flush before restoring caret position.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + s.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // ── 右键上下文菜单：点击外部 / Escape 关闭 ──
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.file-ctx-menu')) return;
      setCtxMenu(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [ctxMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection()?.toString() ?? '';
    if (!sel.trim()) return; // 无选中文本时不弹菜单（保留浏览器默认右键）
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, text: sel.trim() });
  };

  const onCtxSearchFileName = () => {
    useAppStore.getState().setPendingFileTreeSearch({ query: ctxMenu!.text, mode: 'name' });
    setCtxMenu(null);
  };
  const onCtxSearchContent = () => {
    useAppStore.getState().setPendingFileTreeSearch({ query: ctxMenu!.text, mode: 'content' });
    setCtxMenu(null);
  };
  const onCtxCopy = async () => {
    try { await copyMarkdown(ctxMenu!.text); } catch { /* ignore */ }
    setCtxMenu(null);
  };
  const onCtxTranslate = async () => {
    const text = ctxMenu!.text;
    const { x, y } = ctxMenu!;
    setCtxMenu(null);
    // 与文件内 AI 翻译一致：浮窗跟在右键位置后，先占位 loading，模型返回后原地填充多语言译文
    setTranslatePop({ x, y, text, loading: true, items: [] });
    try {
      const result = await requestAiTranslation(text, useAppStore.getState().currentProject?.path);
      setTranslatePop(p => (p && p.text === text && p.loading ? { ...p, loading: false, detected: result.detected, items: result.items } : p));
    } catch (e: any) {
      setTranslatePop(p => (p && p.text === text && p.loading ? { ...p, loading: false, error: e?.message ?? String(e) } : p));
    }
  };
  const onCtxAiSearch = async () => {
    const text = ctxMenu!.text;
    setCtxMenu(null);
    // 新建对话发送检索指令，不污染当前对话上下文
    const meta = await useAppStore.getState().createConversation();
    if (!meta) return;
    await useAppStore.getState().sendChat(
      `请检索并分析以下内容，说明其背景知识、原理，以及在本项目中的用途和相关代码位置：\n\n${text}`,
    );
  };

  return (
    <div
      className={`chat-view${isDragging ? ' drag-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onContextMenu={handleContextMenu}
      onDrop={onDrop}
    >
      {/* 拖拽文件时的视觉提示 */}
      {isDragging ? (
        <div className="chat-drop-overlay">
          <FileText size={28} strokeWidth={1.5} />
          <span>{t('chat.dropFiles')}</span>
        </div>
      ) : null}

      <div className="chat-io-controls">
              {/* 渠道绑定（双向打通）：选择对话关联的通知渠道 */}
              {channelList.length > 0 ? (
                <div className="chat-channel-picker">
                  <button
                    type="button"
                    className={`chat-tool-btn chat-channel-btn${((conv.inboundChannelIds?.length ?? 0) + (conv.outboundChannelIds?.length ?? 0)) > 0 ? ' active' : ''}`}
                    title={t('channels.convBinding')}
                    aria-label={t('channels.convBinding')}
                    aria-expanded={showChannelPicker}
                    onClick={() => {
                      refreshChannelList();
                      setShowChannelPicker(!showChannelPicker);
                    }}
                  >
                    <CloudLightning size={16} />
                    {broadcastTotalCount > 0 ? (
                      <span className="chat-channel-count">{broadcastTotalCount}</span>
                    ) : null}
                  </button>
                  {showChannelPicker ? (
                    <>
                      <AnchoredPopover className="chat-channel-picker-dropdown">
                        {/* 发送方渠道（入站）：仅显示支持入站的渠道（有 inboundWebhookPath） */}
                        <div className="chat-channel-picker-section">
                          <div className="chat-channel-picker-title">
                            <span className="chat-channel-picker-title-icon"><Inbox size={12} /></span>
                            <span>{t('chat.bc.inboundTitle')}</span>
                            <span className="muted small">{t('chat.bc.inboundHint')}</span>
                          </div>
                          {channelList.filter((ch) => !!ch.inboundWebhookPath).length === 0 ? (
                            <div className="muted small chat-channel-picker-hint">
                              {t('chat.bc.noInbound')}
                            </div>
                          ) : (
                            channelList.filter((ch) => !!ch.inboundWebhookPath).map((ch) => {
                              const checked = conv.inboundChannelIds?.includes(ch.id) ?? false;
                              return (
                                <label key={ch.id} className={`chat-channel-option ${ch.enabled ? '' : 'disabled'}`}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={busy}
                                    onChange={async () => {
                                      const current = conv.inboundChannelIds ?? [];
                                      const next = checked
                                        ? current.filter((id) => id !== ch.id)
                                        : [...current, ch.id];
                                      await setConvInboundChannels(next);
                                    }}
                                  />
                                <span>{ch.name}<span className="muted small" style={{ marginLeft: 6 }}>（{ch.type}）</span></span>
                              </label>
                            );
                          })
                        )}
                      </div>

                      {/* 回答方渠道（出站） */}
                      <div className="chat-channel-picker-section">
                        <div className="chat-channel-picker-title">
                          <span className="chat-channel-picker-title-icon"><Send size={12} /></span>
                          <span>{t('chat.bc.outboundTitle')}</span>
                          <span className="muted small">{t('chat.bc.outboundHint')}</span>
                        </div>
                        {channelList.map((ch) => {
                          const checked = conv.outboundChannelIds?.includes(ch.id) ?? false;
                          return (
                            <label key={ch.id} className={`chat-channel-option ${ch.enabled ? '' : 'disabled'}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={busy}
                                onChange={async () => {
                                  const current = conv.outboundChannelIds ?? [];
                                  const next = checked
                                    ? current.filter((id) => id !== ch.id)
                                    : [...current, ch.id];
                                  await setConvOutboundChannels(next);
                                }}
                              />
                              <span>{ch.name}<span className="muted small" style={{ marginLeft: 6 }}>（{ch.type}）</span></span>
                            </label>
                          );
                        })}
                      </div>

                        {/* 广播渠道：每个渠道可以勾选多个消息类型 */}
                        <div className="chat-channel-picker-section">
                          <div className="chat-channel-picker-title">
                            <span className="chat-channel-picker-title-icon"><CloudLightning size={12} /></span>
                            <span>{t('chat.bc.title')}</span>
                            <span className="muted small">{t('chat.bc.hint')}</span>
                          </div>

                          <div className="chat-broadcast-header">
                            <span>{t('chat.bc.colChannel')}</span>
                            <div className="chat-broadcast-header-types">
                              <span title={t('chat.bc.typeUser')}><User size={12} /></span>
                              <span title={t('chat.bc.typeInbound')}><Inbox size={12} /></span>
                              <span title={t('chat.bc.typeAssistant')}><Bot size={12} /></span>
                            </div>
                          </div>

                          {channelList.map((ch) => {
                            const isUser = conv.broadcastUserChannelIds?.includes(ch.id) ?? false;
                            const isInbound = conv.broadcastInboundChannelIds?.includes(ch.id) ?? false;
                            const isAssistant = conv.broadcastAssistantChannelIds?.includes(ch.id) ?? false;

                            const toggleBroadcast = async (scope: 'user' | 'inbound' | 'assistant', current: boolean) => {
                              const setter = scope === 'user' ? setConvBroadcastUserChannels
                                : scope === 'inbound' ? setConvBroadcastInboundChannels
                                : setConvBroadcastAssistantChannels;
                              const list = scope === 'user' ? conv.broadcastUserChannelIds
                                : scope === 'inbound' ? conv.broadcastInboundChannelIds
                                : conv.broadcastAssistantChannelIds;
                              const next = current
                                ? (list ?? []).filter((id) => id !== ch.id)
                                : [...(list ?? []), ch.id];
                              await setter(next);
                            };

                            return (
                              <div key={ch.id} className={`chat-channel-option chat-broadcast-row ${ch.enabled ? '' : 'disabled'}`}>
                                <span className="chat-broadcast-channel-name">{ch.name}<span className="muted small" style={{ marginLeft: 4 }}>（{ch.type}）</span></span>
                                <div className="chat-broadcast-checkboxes">
                                  <label className="chat-broadcast-checkbox" title={t('chat.bc.typeUser')}>
                                    <input
                                      type="checkbox"
                                      checked={isUser}
                                      disabled={busy}
                                      onChange={() => toggleBroadcast('user', isUser)}
                                    />
                                  </label>
                                  <label className="chat-broadcast-checkbox" title={t('chat.bc.typeInbound')}>
                                    <input
                                      type="checkbox"
                                      checked={isInbound}
                                      disabled={busy}
                                      onChange={() => toggleBroadcast('inbound', isInbound)}
                                    />
                                  </label>
                                  <label className="chat-broadcast-checkbox" title={t('chat.bc.typeAssistant')}>
                                    <input
                                      type="checkbox"
                                      checked={isAssistant}
                                      disabled={busy}
                                      onChange={() => toggleBroadcast('assistant', isAssistant)}
                                    />
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </AnchoredPopover>
                    </>
                  ) : null}
                </div>
              ) : null}
              {conv.messages.length > 0 ? (
                <div className="chat-export-wrapper" style={{ position: 'relative', display: 'inline-block' }}>
                  <button
                    type="button"
                    className="chat-tool-btn"
                    title={t('chat.exportTitle')}
                    aria-label={t('chat.exportTitle')}
                    aria-expanded={showExportMenu}
                    onClick={() => setShowExportMenu(!showExportMenu)}
                  >
                    <Upload size={16} />
                  </button>
                  {showExportMenu ? (
                    <>
                      <div
                        className="chat-export-menu"
                        style={{
                          position: 'absolute',
                          top: 'calc(100% + 6px)',
                          right: 0,
                          zIndex: 51,
                          minWidth: '180px',
                          padding: '6px',
                          background: 'var(--bg-1)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-md)',
                          boxShadow: 'var(--shadow-lg)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                        }}
                      >
                        <button
                          type="button"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 12px',
                            border: 'none',
                            background: 'transparent',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontSize: '13px',
                            color: 'var(--text)',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--bg-2)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
                          onClick={onExportConvMarkdown}
                        >
                          <FileText size={14} />
                          <span>{t('chat.exportMd')}</span>
                        </button>
                        <button
                          type="button"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 12px',
                            border: 'none',
                            background: 'transparent',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontSize: '13px',
                            color: 'var(--text)',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--bg-2)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
                          onClick={onExportConvImage}
                        >
                          <ImageDown size={14} />
                          <span>{t('chat.exportPng')}</span>
                        </button>
                        <button
                          type="button"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 12px',
                            border: 'none',
                            background: 'transparent',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontSize: '13px',
                            color: 'var(--text)',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--bg-2)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
                          onClick={onCopyConvImageFromMenu}
                        >
                          <Images size={14} />
                          <span>{t('chat.copyImage')}</span>
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
      </div>

      <div className="chat-body">
        <div className="chat-nav-rail"><ConvNavigator /></div>
        <div className="chat-scroller" ref={scrollerRef} onScroll={onScrollerScroll}>
          <div className="chat-messages-inner" ref={messagesInnerRef}>
          <ScheduledConversationActivity convId={conv.id}/>
          {conv.messages.length === 0 ? (
            <div className="chat-hint">
              <p className="muted">{t('chat.hint', { assistant: backendLabel })}</p>
              <section className="chat-scheduled-intro">
                <h3><CalendarClock size={17} aria-hidden/>{t('chat.scheduledIntro.title')}</h3>
                <p>{t('chat.scheduledIntro.description')}</p>
                <p className="chat-scheduled-example">{t('chat.scheduledIntro.example')}</p>
                <p>{t('chat.scheduledIntro.output')}</p>
                <p className="small">{t('chat.scheduledIntro.runtime')}</p>
              </section>
            </div>
          ) : (
            (() => {
              // 按日期分组消息，插入日期分隔符
              const result: React.ReactNode[] = [];
              let lastDateLabel = '';

              // 连续的同类上下文整理标记融合为一条展示（避免「已自动整理」成排刷屏）
              const groups: Array<{ kind: 'msg'; m: ChatMessage } | { kind: 'compact'; items: ChatMessage[] } | { kind: 'execution'; items: ChatMessage[]; reported: boolean }> = [];
              const expertTree = groupExpertMessages(mergeExpertPlanNotices(projectChatTimeline(replaceExpertAttempts(conv.messages))));
              for (const group of groupExpertExecution(expertTree.roots)) {
                if (group.kind === 'execution') {
                  groups.push({kind: 'execution', items: group.messages, reported: group.reported});
                  continue;
                }
                const m = group.messages[0];
                const last = groups[groups.length - 1];
                if (m.contextCompaction) {
                  if (last && last.kind === 'compact' && last.items[0].contextCompaction?.trigger === m.contextCompaction?.trigger) {
                    last.items.push(m);
                  } else {
                    groups.push({ kind: 'compact', items: [m] });
                  }
                } else {
                  groups.push({ kind: 'msg', m });
                }
              }

              groups.forEach((g, idx) => {
                const head = g.kind === 'msg' ? g.m : g.items[0];
                const dateLabel = formatDateLabel(head.ts);
                const dateKey = formatDateTime(head.ts, 'YYYY-MM-DD');
                // 如果是第一条消息，或者日期标签变了，插入日期分隔符
                if (idx === 0 || dateKey !== lastDateLabel) {
                  result.push(
                    <div key={`date-${head.id}`} className="chat-date-divider">
                      <span className="chat-date-divider-label">{dateLabel}</span>
                    </div>
                  );
                  lastDateLabel = dateKey;
                }
                if (g.kind === 'execution') {
                  const tasks = g.items.filter(m => m.experts?.kind === 'task');
                  const currentTasks = tasks.map(m => resolveExpertTask(conv.expertsPlan, m)).filter((task): task is ExpertTask => !!task && (!task.msgId || tasks.some(m => (m.timelineSourceId ?? m.id) === task.msgId)));
                  const complete = currentTasks.length === tasks.length
                    ? expertTasksComplete(conv.expertsPlan?.tasks ?? [])
                    : g.reported && tasks.every(m => !m.pending && !m.error);
                  result.push(<ExpertExecutionDetails key={`execution-${head.id}`} complete={complete}>
                    {g.items.map(m => m.experts
                      ? <ExpertsMessage key={m.id} m={m} busy={busy} archived={isArchived} nestedMessages={expertTree.children.get(m.id)}/>
                      : <Message key={m.id} m={m} busy={busy} archived={isArchived} onEdit={handleEditUserMessage} onReload={handleReloadUserMessage}/>) }
                  </ExpertExecutionDetails>);
                } else if (g.kind === 'compact') {
                  result.push(<ContextCompactionNoticeGroup key={g.items[0].id} items={g.items} />);
                } else {
                  result.push(g.m.experts ? <ExpertsMessage key={g.m.id} m={g.m} busy={busy} archived={isArchived} nestedMessages={expertTree.children.get(g.m.id)} /> : <Message key={g.m.id} m={g.m} busy={busy} archived={isArchived} onEdit={handleEditUserMessage} onReload={handleReloadUserMessage} />);
                }
              });

              return result;
            })()
          )}

          {pending.map((p) => (
            <ApprovalCard key={p.requestId} req={p} />
          ))}

          {/* 同一批次的多个澄清问题合并成一张卡片，逐个作答。 */}
          {clarifies.filter(req=>!req.scheduledProposal).length > 0 ? <ClarifyBatchCard reqs={clarifies.filter(req=>!req.scheduledProposal)} /> : null}
          {clarifies.filter(req=>req.scheduledProposal).map(req=><ScheduledTaskEditor key={req.requestId} proposal={req.scheduledProposal!} onCancel={()=>void useAppStore.getState().respondClarify(req.requestId,JSON.stringify({confirmed:false}))} onConfirm={async task=>{await useAppStore.getState().respondClarify(req.requestId,JSON.stringify({confirmed:true,task}));}}/>)}

          {/* 底部「正在响应」提示：仅当尾部消息气泡自身没有活动指示时才显示。
              气泡内已有「深度思考 · Ns」计时或运行中工具的转圈动画时，
              再显示这一行就是重复指示（用户反馈：两者同时出现很冗余）。 */}
          {busy && !bubbleShowsActivity && pending.length === 0 && clarifies.length === 0 ? (
            <div className="chat-typing">
              <span className="dot-pulse"></span>
              <span className="muted small">{t('chat.responding', { assistant: backendLabel })}</span>
            </div>
          ) : null}
          </div>
        </div>
        <ChatActivityFooter messages={conv.messages} projectPath={project?.path??conv.projectPath} convId={conv.id} busy={busy} scroller={scrollerRef} queuedCount={conv.messages.filter(m=>m.queued).length} en={resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)==='en'}>
          {!isArchived && conv.expertsPlan && <FloatingExecutionPlan key={conv.id+':'+conv.expertsPlan.id} plan={conv.expertsPlan}
            busy={busy} onResume={()=>useAppStore.getState().expertsRetryFailedTasks()}
            en={resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)==='en'}
            roleLabel={role=>resolveExpertMeta(role, expertDefinitions, expertsEn).name}
            managerLabel={`${resolveExpertMeta('lead', expertDefinitions, expertsEn).name} ${resolveExpertMeta('lead', expertDefinitions, expertsEn).humanName}`}
            onNavigate={task=>{
              const target=task.msgId?document.getElementById('chat-msg-'+task.msgId):null;
              if(!target)return;
              stickyRef.current=false;
              for (let parent = target.parentElement; parent; parent = parent.parentElement) { if (parent instanceof HTMLDetailsElement) parent.open = true; }
              target.scrollIntoView({behavior:'smooth',block:'start'});
              target.classList.add('chat-plan-target');
              setTimeout(()=>target.classList.remove('chat-plan-target'),1800);
            }}/>}
        </ChatActivityFooter>
      </div>

      {/* 排队消息面板：在输入区上方，支持拖拽重排和单条删除。
          key={conv.id}：切换对话时强制重挂载，重置拖拽状态，
          避免拖拽中切换对话导致 dragend 丢失、卡片样式残留不可见。 */}
      <MessageQueue
        key={conv.id}
        messages={conv.messages}
        readOnly={isArchived}
        busy={busy}
        onEdit={(content, images) => {
          const restored = splitQueuedPasteCards(content);
          setText(restored.text);
          setDraftPastedTexts(restored.pastedTexts);
          setDraftImages(images ?? []);
          textareaRef.current?.focus();
        }}
      />

      {/* 归档对话：整个输入区替换为只读提示条，重试/编辑/删除等一律不可用 */}
      {isArchived ? (
        <footer className="chat-input chat-input-archived">
          <div className="chat-archived-banner">
            {t('chat.archivedReadonly')}
          </div>
        </footer>
      ) : (
      <footer className="chat-input">
        <PluginSlot slot="conversation.header" context={{conversationId:conv.id}}/><PluginSlot slot="conversation.input"/>
        <ModelSetupNotice/>
        <div className="chat-composer" ref={composerRef}>
        {!mainSupportsVision && (draftImages.some(image => !image.attachmentPath) || conv.selectedVisionModel) && <div className="chat-vision-selector">
          <ModelSelector label={t('chat.visionModel')} providers={modelProviders} visionOnly
            value={conv.selectedVisionModel ?? null}
            inheritedValue={effectiveModelSelection(project?.selectedVisionModel, globalVisionModel)}
            emptyLabel={t('chat.visionFollow')} help={t('chat.visionAuto')}
            onChange={value => { void window.api.updateConvMeta(conv.id, {selectedVisionModel:value ?? undefined}).then(result => {
              if (!result?.ok) throw Error('保存视觉模型失败');
              useAppStore.setState(state => ({currentConversation:state.currentConversation?.id === conv.id ? {...state.currentConversation,selectedVisionModel:value ?? undefined} : state.currentConversation, conversations:state.conversations.map(c => c.id === conv.id ? {...c,selectedVisionModel:value ?? undefined} : c)}));
            }).catch(error => useAppStore.getState().setConvError(String(error))); }}/>
        </div>}
        {draftImages.length > 0 ? (
          <div className="chat-attachments">
            {draftImages.map((img, i) => (
              <div className={`chat-attachment ${img.attachmentPath ? 'is-file-reference' : 'is-model-image'}`} key={i}>
                <span className="msg-img-badge">{i + 1}</span>
                <img
                  src={`data:${img.mimeType};base64,${img.dataBase64}`}
                  alt={img.name}
                  className="chat-attachment-preview"
                  onClick={() => { setDraftLightboxIndex(i); setDraftLightboxSrc(`data:${img.mimeType};base64,${img.dataBase64}`); }}
                  title={t('chat.imgZoomTitle')}
                />
                {img.attachmentPath && <span className="chat-image-delivery" title={t('chat.fileImageHint')}>
                  <Paperclip size={12}/>
                  {t('chat.fileImageLabel')}
                </span>}
                <CornerRemoveButton
                  className="chat-attachment-remove"
                  title={t('chat.imgRemove')}
                  onClick={() => setDraftImages((prev) => prev.filter((_, j) => j !== i))}
                />
              </div>
            ))}
          </div>
        ) : null}
        {draftPastedTexts.length > 0 ? (
          <div className="chat-pasted-text-list">
            {draftPastedTexts.map((item) => {
              const preview = item.text.replace(/\s+/g, ' ').trim();
              return (
                <div className="chat-pasted-text-card" key={item.id}>
                  <span className="chat-pasted-text-icon" aria-hidden="true"><FileText size={19}/></span>
                  <div className="chat-pasted-text-body">
                    <div className="chat-pasted-text-title">{t('chat.pasteCardLabel')}</div>
                    <div className="chat-pasted-text-preview" title={preview}>{preview}</div>
                    <button type="button" className="chat-pasted-text-restore" onClick={() => {
                      setDraftPastedTexts((prev) => prev.filter((entry) => entry.id !== item.id));
                      setText((prev) => `${prev}${prev && !prev.endsWith('\n') ? '\n\n' : ''}${item.text}`);
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }}>{t('chat.pasteCardRestore')} <ChevronRight size={14}/></button>
                  </div>
                  <CornerRemoveButton
                    className="chat-pasted-text-remove"
                    title={t('chat.imgRemove')}
                    onClick={() => setDraftPastedTexts((prev) => prev.filter((entry) => entry.id !== item.id))}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
          <textarea
            ref={textareaRef}
            className={`chat-composer-textarea${isOptimizing ? ' optimizing' : ''}`}
            value={text}
            onChange={(e) => { historyIndexRef.current = -1; setText(e.target.value); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            readOnly={isOptimizing || voiceRec} // 优化中/录音中锁定输入：避免内容被写回的优化结果或听写文本覆盖
            placeholder={
              isOptimizing
                ? t('chat.optimizingPh')
                : busy
                  ? t('chat.placeholderQueued', { assistant: backendLabel })
                  : t('chat.placeholder', { assistant: backendLabel })
            }
            rows={COMPOSER_MIN_ROWS}
          />
          <div className="chat-toolbar" ref={toolbarRef}>
            <div className="chat-toolbar-left"><ChatCapabilities project={conv.projectPath} disabled={isOptimizing || voiceRec || isArchived} onSelect={request=>{
              const input=textareaRef.current;const start=input?.selectionStart??text.length,end=input?.selectionEnd??text.length;
              setText(text.slice(0,start)+request+text.slice(end));
              requestAnimationFrame(()=>{input?.focus();input?.setSelectionRange(start+request.length,start+request.length);});
            }}/><PluginSlot slot="toolbar"/><PluginSlot slot="conversation"/><PluginSlot slot="conversation.actions" context={{conversationId:conv.id}}/>
              {backendEngine && backendEngine !== 'api' ? (
                <button type="button" className="chat-model-picker-btn" aria-label={t('settings.codexModelHelp')} onClick={() => useAppStore.getState().openSettingsTab({initialTab:'plugins'})}>
                  <span className="chat-model-picker-label">{backendEngine}</span>
                </button>
              ) : modelProviders.length > 0 ? (
                <ModelCombo providers={modelProviders} value={conv.selectedModel??null} showTooltip={false}
                  inheritedValue={effectiveModelSelection(project?.selectedModel,globalSelectedModel)}
                  followLabel={project?t('fml.followProject'):t('fml.followGlobal')}
                  effort={conv.thinkingEffort}
                  onChange={value=>void useAppStore.getState().setConvSelectedModel(value)}
                  onEffortChange={value=>void setConvThinkingEffort(value)}/>
              ) : modelProfiles.length > 0 ? (
                <div className="chat-model-picker">
                  <Bot size={14} className="chat-model-picker-icon" />
                  <select
                    className="chat-model-select"
                    aria-label={t('chat.model.title')}
                    value={conv.modelProfileId ?? ''}
                    onChange={(e) => void setConvModel(e.target.value || undefined)}
                  >
                    <option value="">{t('chat.model.follow')}</option>
                    {modelProfiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              ) : null}
              {ctx ? (() => {
                // 上下文用量九宫格：按 200k 窗口估算占比，每格 = 10%。
                // 填充顺序：从左下角开始，自下而上逐行、行内从左到右。
                const CTX_WINDOW = globalCtxWindowSize;
                const pct = ctx.total / Math.max(1, CTX_WINDOW);
                const filledCount = Math.min(9, Math.round(pct * 10));
                // CSS grid 按行从上到下编号 0-8；填充顺序为底行→中行→顶行
                const fillOrder = [6, 7, 8, 3, 4, 5, 0, 1, 2];
                const filledSet = new Set(fillOrder.slice(0, filledCount));
                return (
                <div className="chat-ctx-wrapper">
                  <button
                    type="button"
                    className="chat-ctx-meter"
                    aria-label={t('chat.ctxPanel.windowSizeTitle')}
                    aria-expanded={showCtxPanel}
                    onClick={() => setShowCtxPanel(!showCtxPanel)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="chat-ctx-bar">
                      {Array.from({ length: 9 }, (_, i) => (
                        <span
                          key={i}
                          className={`chat-ctx-cell${filledSet.has(i) ? ' filled' : ''}`}
                        />
                      ))}
                    </span>
                  </button>
                  {/* 自定义 tooltip：原生 title 位置由系统决定（在按钮下方），
                      改为悬停时固定在按钮上方显示；面板打开时不显示 */}
                  {!showCtxPanel ? (
                    <span className="chat-ctx-meter-tooltip" aria-hidden="true">
                      <span>
                        {(pct * 100).toFixed(0)}% {formatTokens(ctx.total)} / {formatTokens(CTX_WINDOW)} {t(ctx.source === 'estimate' ? 'chat.ctxPanel.tokensEstimated' : 'chat.ctxPanel.tokensUsed')}
                      </span>
                      <span>
                        {ctx.source === 'estimate' ? t('chat.ctxPanel.cacheUnknown') : <>{t('chat.ctxPanel.reuseRate')}: {(ctx.reusePct * 100).toFixed(0)}% | {t('chat.ctxPanel.rebuildRate')}: {(ctx.rebuildPct * 100).toFixed(0)}%</>}
                      </span>
                    </span>
                  ) : null}
                  {showCtxPanel ? (
                    <>
                      <AnchoredPopover className="chat-ctx-panel" align="end" role="dialog" aria-label={t('chat.ctxPanel.windowSizeTitle')}>
                        {/* ── 用量 ── */}
                        <div className="chat-ctx-panel-usage">
                          {/* 第一行：百分比 + 具体数据 + 缓存统计 */}
                          <div className="chat-ctx-panel-summary">
                            <span className="chat-ctx-panel-percentage">{(pct * 100).toFixed(0)}%</span>
                            <span className="chat-ctx-panel-separator">·</span>
                            <span className="chat-ctx-panel-tokens">
                              {formatTokens(ctx.total)} / {formatTokens(CTX_WINDOW)} {t(ctx.source === 'estimate' ? 'chat.ctxPanel.tokensEstimated' : 'chat.ctxPanel.tokensUsed')}
                            </span>
                            <span className="chat-ctx-panel-separator">·</span>
                            <span className="chat-ctx-panel-cache">
                              {ctx.source === 'estimate' ? t('chat.ctxPanel.cacheUnknown') : <>{t('chat.ctxPanel.reuseRate')}: {(ctx.reusePct * 100).toFixed(0)}% ｜ {t('chat.ctxPanel.rebuildRate')}: {(ctx.rebuildPct * 100).toFixed(0)}%</>}
                            </span>
                          </div>
                        </div>

                        {/* ── 上下文窗口大小 ── */}
                        <div className="chat-ctx-panel-section">
                          <div className="chat-ctx-panel-title">{t('chat.ctxPanel.windowSizeTitle')}</div>
                          <label className="chat-ctx-panel-field">
                            <select
                              value={windowSizeSelection}
                              onChange={(e) => {
                                const v = e.target.value as '200k' | '400k' | '1M' | 'custom';
                                setWindowSizeSelection(v);
                                if (v === 'custom') {
                                  setCustomWindowSize(String(globalCtxWindowSize));
                                } else if (v === '200k') {
                                  void updateContextWindowSize(200000);
                                } else if (v === '400k') {
                                  void updateContextWindowSize(400000);
                                } else if (v === '1M') {
                                  void updateContextWindowSize(1000000);
                                }
                              }}
                            >
                              <option value="200k">200K {t('unit.tokens')}</option>
                              <option value="400k">400K {t('unit.tokens')}</option>
                              <option value="1M">1M {t('unit.tokens')}</option>
                              <option value="custom">{t('chat.ctxPanel.windowSizeCustom')}</option>
                            </select>
                          </label>
                          {windowSizeSelection === 'custom' ? (
                            <label className="chat-ctx-panel-field chat-ctx-panel-custom-input">
                              <input
                                type="number"
                                min={10000}
                                step={10000}
                                value={customWindowSize}
                                onChange={(e) => setCustomWindowSize(e.target.value)}
                                onBlur={() => {
                                  const n = parseInt(customWindowSize, 10);
                                  if (Number.isFinite(n) && n > 0) {
                                    void updateContextWindowSize(n);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const n = parseInt(customWindowSize, 10);
                                    if (Number.isFinite(n) && n > 0) {
                                      void updateContextWindowSize(n);
                                    }
                                  }
                                }}
                                placeholder={t('chat.ctxPanel.windowSizePlaceholder')}
                              />
                            </label>
                          ) : null}
                        </div>

                        {/* ── 对话级压缩策略：默认沿用全局，可单独覆盖 ── */}
                        <div className="chat-ctx-panel-section">
                          <div className="chat-ctx-panel-title">
                            {t('chat.ctxPanel.strategyTitle')}
                            {convCtxStrategy ? (
                              <button
                                type="button"
                                className="chat-ctx-panel-reset"
                                title={t('chat.ctxPanel.resetHint')}
                                onClick={() =>
                                  void useAppStore.getState().setConvContextStrategy(null)
                                }
                              >
                                {t('chat.ctxPanel.reset')}
                              </button>
                            ) : null}
                          </div>

                          <label className="chat-ctx-panel-field">
                            <span>{t('settings.contextMode')}</span>
                            <select
                              value={(convCtxStrategy?.extension??globalCtxStrategy?.extension)||effCtxMode}
                              onChange={(e) =>
                                void patchConvCtx({
                                  extension:e.target.value.includes('/')?e.target.value:'',
                                  mode: (e.target.value.includes('/')?'auto':e.target.value) as ContextStrategyConfig['mode'],
                                })
                              }
                            >
                              <option value="auto">{resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)==='en'?'Auto':'自动'}</option>
                              <option value="conservative">{t('settings.contextMode.conservative')}</option>
                              <option value="balanced">{t('settings.contextMode.balanced')}</option>
                              <option value="aggressive">{t('settings.contextMode.aggressive')}</option>
                              <ExtensionOptions point="sage/context.compact" selected={convCtxStrategy?.extension??globalCtxStrategy?.extension}/>
                            </select>
                          </label>

                          <label className="chat-ctx-panel-field">
                            <span>{t('settings.summaryStrategy')}</span>
                            <select
                              value={effCtxSummary}
                              onChange={(e) =>
                                void patchConvCtx({
                                  summaryStrategy: e.target.value as ContextStrategyConfig['summaryStrategy'],
                                })
                              }
                            >
                              <option value="auto">{resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)==='en'?'Auto':'自动'}</option>
                              <option value="truncate">{t('settings.summaryStrategy.truncate')}</option>
                              <option value="llm">{t('settings.summaryStrategy.llm')}</option>
                            </select>
                          </label>

                          <div className="chat-ctx-panel-effective muted small chat-ctx-nowrap">
                            <span title={`${t('chat.ctxPanel.effective', {
                              mode: t(`settings.contextMode.${effCtxMode}`),
                              summary: t(`settings.summaryStrategy.${effCtxSummary}`),
                            })}`}>
                              {t('chat.ctxPanel.effective', {
                                mode: stripParenthetical(t(`settings.contextMode.${effCtxMode}`)),
                                summary: stripParenthetical(t(`settings.summaryStrategy.${effCtxSummary}`)),
                              })}
                            </span>
                          </div>
                        </div>

                        {/* ── 整理上下文 ── */}
                        <button
                          type="button"
                          className="btn-primary chat-ctx-compact-btn"
                          disabled={compacting}
                          onClick={() => void onCompactContext()}
                        >
                          {compacting ? <Loader2 size={12} className="tool-spin" /> : null}
                          {compacting ? t('chat.ctxPanel.compacting') : t('chat.ctxPanel.compact')}
                        </button>
                        <div className="chat-ctx-audit-wrap">
                          <ContextAuditTrigger className="chat-ctx-audit-link" audits={conv.contextCompactionAudits ?? []} showList>
                            <FileSearch size={12} />
                            {t('chat.ctxPanel.audit', { count: conv.contextCompactionAudits?.length ?? 0 })}
                          </ContextAuditTrigger>
                        </div>
                      </AnchoredPopover>
                    </>
                  ) : null}
                </div>
                );
              })() : null}
              <button
                type="button"
                className="chat-tool-btn"
                title={t('chat.attachImage')}
                onClick={() => imageInputRef.current?.click()}
              >
                <ImagePlus size={16} />
              </button>
              {/* 纯图片选择：只接受图片格式，直接走图片消息通道 */}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                ref={imageInputRef}
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) void addImages(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="chat-tool-btn"
                title={t('chat.attachFile')}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={16} />
              </button>
              {/* 附件选择：接受任意文件，addAttachments 内部按类型分流
                  （图片 → 附件预览；文本 → 插入内容；其它 → 插入路径） */}
              <input
                type="file"
                multiple
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) void addAttachments(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="chat-toolbar-right">
              <SecurityMenu busy={busy} conversationShortcut />
              {/* 优化输入按钮：输入框有内容即显示（忙碌时与插话按钮并存）
                  优化中按钮不再 disabled，而是转为「长按弹出取消」的入口 */}
              {text.trim() && (
                <span className="chat-optimize-wrapper">
                  <button
                    type="button"
                    className={`chat-optimize-btn${isOptimizing ? ' optimizing' : ''}`}
                    title={isOptimizing ? t('chat.optimizeBusyTitle') : t('chat.optimizeTitle')}
                    onClick={onOptimizeBtnClick}
                    onPointerDown={isOptimizing ? startOptimizeLongPress : undefined}
                    onPointerUp={isOptimizing ? clearOptimizeLongPress : undefined}
                    onPointerLeave={isOptimizing ? clearOptimizeLongPress : undefined}
                    onPointerCancel={isOptimizing ? clearOptimizeLongPress : undefined}
                  >
                    {isOptimizing ? (
                      <Loader2 size={16} className="tool-spin" />
                    ) : (
                      <Sparkles size={14} />
                    )}
                  </button>
                  {isOptimizing && showOptimizeCancel ? (
                    <button type="button" className="chat-optimize-cancel" onClick={cancelOptimize}>
                      <X size={12} />
                      <span>{t('chat.cancelOptimize')}</span>
                    </button>
                  ) : null}
                </span>
              )}
              {/* 插话按钮：执行过程中注入消息（不停止当前执行），仅执行中显示 */}
              {busy && (
                <button
                  type="button"
                  className="chat-interject-btn"
                  title={t('chat.interjectTitle')}
                  disabled={(!text.trim() && draftPastedTexts.length === 0) || isOptimizing}
                  onClick={() => void onInterject()}
                >
                  <CornerUpLeft size={16} strokeWidth={2.2} />
                </button>
              )}
              {/* 语音输入按钮：优化与发送之间；优化中禁用（与输入框 readOnly 一致），
                  录音中红色脉冲，点击或手动开关快捷键停止 */}
              <button
                type="button"
                className={`chat-voice-btn${voiceRequested ? ' recording' : ''}`}
                title={`${voiceRequested ? t('chat.voiceStopTitle') : t('chat.voiceTitle')}\n${voiceShortcutTitle}`}
                aria-label={voiceRequested ? t('chat.voiceStopTitle') : t('chat.voiceTitle')}
                aria-pressed={voiceRequested}
                aria-busy={voiceRequested && !voiceRec}
                disabled={isOptimizing}
                onClick={() => { void toggleVoice(); }}
              >
                <Mic size={16} />
              </button>
              {/* 智能发送/停止按钮：长按停止（需确认），单击发送 */}
              <button
                type="button"
                className={`chat-send-btn${busy ? ' chat-send-btn--busy' : ''}`}
                title={busy ? t('chat.sendQueued') : t('chat.send')}
                disabled={isOptimizing || (!busy && !text.trim() && draftImages.length === 0 && draftPastedTexts.length === 0)}
                onClick={() => {
                  // 如果长按已经触发了停止确认，不再发送
                  if (showStopConfirm) return;
                  onSubmit();
                }}
                onMouseDown={busy ? () => {
                  // 长按 500ms 触发停止确认
                  longPressTimerRef.current = setTimeout(() => {
                    setShowStopConfirm(true);
                    longPressTimerRef.current = null;
                  }, 500);
                } : undefined}
                onMouseUp={() => {
                  if (longPressTimerRef.current) {
                    clearTimeout(longPressTimerRef.current);
                    longPressTimerRef.current = null;
                  }
                }}
                onMouseLeave={() => {
                  if (longPressTimerRef.current) {
                    clearTimeout(longPressTimerRef.current);
                    longPressTimerRef.current = null;
                  }
                }}
              >
                {busy ? <Clock size={16} /> : <ArrowUp size={16} strokeWidth={2.5} />}
              </button>
            </div>
          </div>
        </div>
        {voiceRec && <VoiceWaveform anchor={composerRef} levels={voiceWave} label={t('chat.voiceStopTitle')}/>}
      </footer>
      )}

      {/* 停止确认对话框 */}
      {showStopConfirm ? (
        <WindowOverlay className="chat-stop-confirm-backdrop" onClick={() => setShowStopConfirm(false)}>
          <div className="chat-stop-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="chat-stop-confirm-icon">
              <Square size={20} fill="currentColor" />
            </div>
            <p className="chat-stop-confirm-title">{t('chat.stopTitle')}</p>
            <p className="chat-stop-confirm-desc muted small">
              {t('chat.stopDesc')}
            </p>
            <div className="chat-stop-confirm-actions">
              <button className="btn-ghost" onClick={() => setShowStopConfirm(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => {
                abort();
                setShowStopConfirm(false);
              }}>
                {t('chat.stopBtn')}
              </button>
            </div>
          </div>
        </WindowOverlay>
      ) : null}

      {/* 文件拖入选择弹窗：非图片文件拖入后，让用户选择插入路径还是附加内容 */}
      {dropChoice ? (
        <WindowOverlay className="chat-drop-choice-backdrop" onClick={() => setDropChoice(null)}>
          <div className="chat-drop-choice" onClick={(e) => e.stopPropagation()}>
            <div className="chat-drop-choice-head">
              <FileText size={18} strokeWidth={1.5} />
              <div>
                <strong>{dropChoice.file.name}</strong>
                <span className="muted small" style={{ marginLeft: 8 }}>
                  {prettyBytes(dropChoice.file.size)}
                </span>
              </div>
            </div>
            <p className="chat-drop-choice-desc muted small">
              {t('chat.dropChoiceDesc')}
            </p>
            <div className="chat-drop-choice-actions">
              <button className="btn-ghost" onClick={insertFilePath}>
                <Link size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                {t('chat.dropInsertPath')}
              </button>
              {isTextFile(dropChoice.file.name, dropChoice.file.type) ? (
                <button className="btn-primary" onClick={attachFileContent}>
                  <FileText size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                  {t('chat.dropAttach')}
                </button>
              ) : (
                <button
                  className="btn-primary"
                  disabled
                  title={t('chat.dropTextOnlyTitle')}
                >
                  {t('chat.dropTextOnly')}
                </button>
              )}
            </div>
          </div>
        </WindowOverlay>
      ) : null}

      {/* 输入区草稿图片放大预览 */}
      {draftLightboxSrc ? (
        <ImageLightbox src={draftLightboxSrc} initialIndex={draftLightboxIndex} sources={draftImages.map(img=>({src:`data:${img.mimeType};base64,${img.dataBase64}`,name:img.name,description:t(img.attachmentPath ? 'chat.fileImageHint' : 'chat.modelImageHint')}))} onClose={() => setDraftLightboxSrc(null)} />
      ) : null}

      {/* 入站消息实时 toast：外部渠道消息进入时短暂显示 */}
      {latestInboundToast && latestInboundToast.projectPath === project?.path ? (
        <InboundToast
          payload={latestInboundToast}
          onDismiss={() => {
            dismissInboundToast();
            // 如果 toast 对应一个具体对话，点击可跳转
            if (latestInboundToast.convId) {
              void useAppStore.getState().selectConversation(latestInboundToast.convId);
            }
          }}
        />
      ) : null}

      {/* 右键上下文菜单（贴光标弹，底部放不下时自动翻向上方） */}
      {ctxMenu ? <CursorMenu x={ctxMenu.x} y={ctxMenu.y}>
        <div className="file-ctx-menu-header muted small">
          「{ctxMenu.text.length > 40 ? ctxMenu.text.slice(0, 40) + '…' : ctxMenu.text}」
        </div>
        <button className="file-ctx-item" onClick={onCtxSearchFileName}>
          <FileSearch size={13} /> {t('chat.selName')}
        </button>
        <button className="file-ctx-item" onClick={onCtxSearchContent}>
          <Search size={13} /> {t('chat.selContent')}
        </button>
        <div className="file-ctx-sep" />
        <button className="file-ctx-item" onClick={onCtxTranslate}>
          <Languages size={13} /> {t('chat.selTranslate')}
        </button>
        <button className="file-ctx-item" onClick={onCtxAiSearch}>
          <Sparkles size={13} /> {t('chat.selSearch')}
        </button>
        <div className="file-ctx-sep" />
        <button className="file-ctx-item" onClick={onCtxCopy}>
          <Copy size={13} /> {t('common.copy')}
        </button>
      </CursorMenu> : null}

      {/* AI 翻译浮窗（Portal 到 body）：与文件内同一组件，点外部/Esc 关闭 */}
      {translatePop ? <TranslatePop pop={translatePop} onClose={() => setTranslatePop(null)} /> : null}


      {/* 语音授权被拒提示（Portal 到 body）：macOS 不能手动添加应用，
          提供「打开系统设置」一键跳到对应隐私面板；Enter=打开，Esc=关闭 */}
      {voiceDeniedPane && createPortal(
        <WindowOverlay className="voice-denied-backdrop" onClick={() => setVoiceDeniedPane(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setVoiceDeniedPane(null); }}>
          <div className="voice-denied-dialog" role="alertdialog" aria-modal="true"
            onClick={(e) => e.stopPropagation()}>
            <div className="voice-denied-msg">{translate('chat.voiceDenied')}{`\n${translate('chat.voiceDeniedHint')}`}{voiceDeniedDetail ? `\n${voiceDeniedDetail}` : ''}</div>
            <div className="voice-denied-actions">
              <button type="button" className="voice-denied-dismiss"
                onClick={() => {
                  setVoiceDeniedDetail(translate('chat.voiceResetting'));
                  void (async () => {
                    try {
                      const r = await window.api.voiceResetMicTcc();
                      const ensure = await window.api.voiceEnsureMic();
                      if (ensure?.ok) { setVoiceDeniedPane(null); setVoiceDeniedDetail(''); void toggleVoice(); return; }
                      setVoiceDeniedDetail(`mic TCC: ${ensure?.status ?? 'denied'}（reset: ${r?.status ?? '?'}）`);
                    } catch (e) {
                      setVoiceDeniedDetail(`reset: ${(e as Error)?.message ?? String(e)}`);
                    }
                  })();
                }}>
                {translate('chat.voiceResetRetry')}
              </button>
              <button type="button" className="btn-primary voice-denied-open"
                style={{ background: 'var(--accent, #6558d6)', color: '#fff' }} autoFocus
                onClick={() => { void window.api.openSystemPrivacy(voiceDeniedPane); setVoiceDeniedPane(null); }}>
                {translate('chat.voiceOpenSettings')}
              </button>
              <button type="button" className="voice-denied-dismiss" onClick={() => setVoiceDeniedPane(null)}>
                {translate('chat.voiceDismiss')}
              </button>
            </div>
          </div>
        </WindowOverlay>,
        document.body,
      )}

      {/* 文件链接右键菜单 */}
      {fileLinkMenu ? <CursorMenu x={fileLinkMenu.x} y={fileLinkMenu.y}>
        <div className="file-ctx-menu-header muted small">
          {fileLinkMenu.filePath}
        </div>
        <button className="file-ctx-item" onClick={async () => {
          await window.api.openInFinder(fileLinkMenu.absPath);
          setFileLinkMenu(null);
        }}>
          <FolderOpen size={13} /> {t('ft.finderShow')}
        </button>
        <button className="file-ctx-item" onClick={async () => {
          // 触发下载：创建隐藏 a 标签
          const a = document.createElement('a');
          a.href = `file://${fileLinkMenu.absPath}`;
          a.download = fileLinkMenu.filePath.split('/').pop() || 'file';
          a.click();
          setFileLinkMenu(null);
        }}>
          <Download size={13} /> {t('chat.selSaveAs')}
        </button>
        <div className="file-ctx-sep" />
        <button className="file-ctx-item" onClick={() => {
          void copyMarkdown(fileLinkMenu.filePath);
          setFileLinkMenu(null);
        }}>
          <Link2 size={13} /> {t('ft.copyPath')}
        </button>
      </CursorMenu> : null}
    </div>
  );
}

/**
 * 排队消息面板：在对话区和输入区之间显示一个独立的"Message queued"卡片区域。
 * 每张卡片：
 *  - 左侧拖拽手柄（⠿ 六边形图标），支持上下拖动重排
 *  - 中间显示消息预览（前 3 行 + 图片缩略图）
 *  - 右侧编辑、复制、删除按钮
 */
function MessageQueue({
  messages,
  onEdit,
  readOnly = false,
  busy = false,
}: {
  busy?: boolean;
  messages: ChatMessage[];
  onEdit: (content: string, images?: ImageAttachment[]) => void;
  /** 归档对话：队列只展示不可操作（不能重试/跳过/重排/取消）。 */
  readOnly?: boolean;
}) {
  const t = useT();
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage);
  const reorderQueuedMessages = useAppStore((s) => s.reorderQueuedMessages);
  const retryQueue = useAppStore((s) => s.retryQueue);
  const resumeQueue = useAppStore((s) => s.resumeQueue);
  const clearQueueStopped = useAppStore((s) => s.clearQueueStopped);
  const queueStoppedByConv = useAppStore((s) => s.queueStoppedByConv);
  const currentConvId = useAppStore((s) => s.currentConversation?.id);
  const queueStopped = currentConvId ? queueStoppedByConv[currentConvId] : undefined;
  const [lightboxImages,setLightboxImages] = useState<ImageAttachment[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [promoting, setPromoting] = useState<string>();
  const promote = async (message:ChatMessage) => {
    if (!currentConvId || !message.queueId || promoting) return;
    setPromoting(message.queueId);
    try {
      const result = await window.api.interjectChat(currentConvId, message.content, message.images, message.queueId);
      if (!result?.ok) useAppStore.getState().setConvError(result?.error ?? t('chat.interjectFail'));
    } catch(error) { useAppStore.getState().setConvError(String(error)); }
    finally { setPromoting(undefined); }
  };

  const queuedMsgs = useMemo(
    () => messages.filter((m) => m.queued),
    [messages]
  );

  // Drag & drop state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const onDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    // Use the current element as drag image with slight opacity
    const target = e.currentTarget as HTMLElement;
    target.classList.add('queue-card-dragging');
  };

  const onDragEnd = (e: React.DragEvent) => {
    const target = e.currentTarget as HTMLElement;
    target.classList.remove('queue-card-dragging');
    setDragIdx(null);
    setOverIdx(null);
  };

  const onDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragIdx === null || dragIdx === idx) return;
    setOverIdx(idx);
  };

  const onDrop = (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === dropIdx) return;
    // Build new queueId order
    const reordered = [...queuedMsgs];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(dropIdx, 0, moved);
    const newQueueIds = reordered.map((m) => m.queueId).filter(Boolean) as string[];
    void reorderQueuedMessages(newQueueIds);
    setDragIdx(null);
    setOverIdx(null);
  };

  const getPreview = (content: string): string => {
    // Show up to 3 lines, max ~200 chars
    const lines = visibleImageMessage(content).split('\n').filter((l) => l.trim().length > 0);
    const first = lines.slice(0, 3).join(' ');
    const clean = first.replace(/[#*`>\-]/g, '').trim();
    return clean.length > 200 ? clean.slice(0, 200) + '…' : clean || t('chat.emptyMsg');
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await retryQueue();
    } finally {
      setRetrying(false);
    }
  };

  const handleResume = async () => {
    await resumeQueue();
  };

  // 完全没有排队消息且没有失败状态时不渲染
  if (queuedMsgs.length === 0 && !queueStopped) return null;

  return (
    <>
    <div className="queue-panel" ref={containerRef} data-read-only={readOnly ? '1' : undefined}>
      {/* 队列失败横幅 */}
      {queueStopped ? (
        <div className="queue-stopped-banner">
          <div className="queue-stopped-banner-icon">⚠️</div>
          <div className="queue-stopped-banner-body">
            <div className="queue-stopped-banner-title">{t('queue.stopped.title')}</div>
            <div className="queue-stopped-banner-error muted small">
              <ConversationErrorText error={queueStopped.error} />
              {queueStopped.failedText && visibleImageMessage(queueStopped.failedText) ? (
                <>
                  {' · '}
                  <span className="queue-stopped-failed-preview">
                    「{getPreview(queueStopped.failedText)}」
                  </span>
                </>
              ) : null}
              {queueStopped.remaining > 0 ? (
                <>
                  {' · '}
                  <span>{t('queue.stopped.remaining', { n: queueStopped.remaining })}</span>
                </>
              ) : null}
            </div>
          </div>
          {readOnly ? null : (
          <div className="queue-stopped-banner-actions">
            <button
              className="btn-ghost btn-sm"
              onClick={() => void handleResume()}
              title={t('queue.stopped.skipHint')}
            >
              {t('queue.stopped.skip')}
            </button>
            <button
              className="btn-primary btn-sm"
              onClick={() => void handleRetry()}
              disabled={retrying}
            >
              <RefreshCw size={12} className={retrying ? 'tool-spin' : ''} />
              {t('queue.stopped.retry')}
            </button>
          </div>
          )}
          <button
            className="queue-stopped-banner-close"
            onClick={() => clearQueueStopped()}
            title={t('common.close')}
          >
            ×
          </button>
        </div>
      ) : null}

      {queuedMsgs.length > 0 ? (
        <div className="queue-panel-list">
          {queuedMsgs.map((m, idx) => (
            <div
              key={m.id}
              className={`queue-card${dragIdx === idx ? ' queue-card-dragging' : ''}${overIdx === idx ? ' queue-card-over' : ''}`}
              draggable={!readOnly}
              onDragStart={(e) => onDragStart(e, idx)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, idx)}
              onDrop={(e) => onDrop(e, idx)}
            >
              <div className="queue-card-drag-handle" title={readOnly ? '' : 'Drag to reorder'} style={readOnly ? { visibility: 'hidden' } : undefined}>
                <svg width="10" height="14" viewBox="0 0 12 16" fill="currentColor">
                  <circle cx="3" cy="3" r="1.3" />
                  <circle cx="9" cy="3" r="1.3" />
                  <circle cx="3" cy="8" r="1.3" />
                  <circle cx="9" cy="8" r="1.3" />
                  <circle cx="3" cy="13" r="1.3" />
                  <circle cx="9" cy="13" r="1.3" />
                </svg>
              </div>
              <div className="queue-card-body">
                {m.images && m.images.length > 0 ? (
                  <div className="queue-card-images">
                    {m.images.map((img, i) => (
                      <div className="queue-card-img-wrap" key={i}>
                        <span className="msg-img-badge sm">{t('chat.imgN', { n: i + 1 })}</span>
                        <img
                          src={`data:${img.mimeType};base64,${img.dataBase64}`}
                          alt={img.name}
                          className="queue-card-img"
                          onClick={() => {setLightboxImages(m.images ?? []);setLightboxSrc(`data:${img.mimeType};base64,${img.dataBase64}`);}}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="queue-card-text">{getPreview(m.content)}</div>
              </div>
              <div className="queue-card-actions">
                {!readOnly && <button className="queue-card-action-btn" title={t('chat.queueInterject')} aria-label={t('chat.queueInterject')} disabled={!busy || !!promoting || !m.queueId} onClick={() => void promote(m)}><CornerUpLeft size={12}/><span>{t('chat.queueInterject')}</span></button>}
                {!readOnly && (
                <button
                  className="queue-card-action-btn"
                  title={t('common.edit')}
                  onClick={() => {
                    if (m.queueId) void removeQueuedMessage(m.queueId);
                    onEdit(m.content, m.images);
                  }}
                >
                  <Pencil size={12} />
                </button>
                )}
                <button
                  className="queue-card-action-btn"
                  title={t('common.copy')}
                  onClick={() => {
                    void copyMarkdown(m.content);
                  }}
                >
                  <Copy size={12} />
                </button>
                {!readOnly && (
                <button
                  className="queue-card-delete"
                  title={t('chat.queuedCancel')}
                  onClick={() => {
                    if (m.queueId) void removeQueuedMessage(m.queueId);
                  }}
                >
                  <Trash2 size={12} />
                </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="queue-panel-empty muted small" style={{ padding: '8px 14px' }}>
          {t('queue.stopped.allSkippedHint')}
        </div>
      )}
    </div>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} sources={lightboxImages.map(img=>({src:`data:${img.mimeType};base64,${img.dataBase64}`,name:img.name}))} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

function Message({ m, busy, archived = false, onEdit, onReload }: { m: ChatMessage; busy: boolean; archived?: boolean; onEdit?: (msg: ChatMessage) => void; onReload?: (msg: ChatMessage) => void }) {
  const isUser = m.role === 'user';
  // Queued messages are rendered in the MessageQueue panel (above the composer),
  // not as inline chat bubbles. Skip them here.
  if (m.queued) {
    console.log('[Message] Skipping queued message:', m.id);
    return null;
  }
  const t = useT();
  const mdRef = useRef<HTMLDivElement>(null);
  // 时间线多段文本：逐段登记 DOM，富文本复制时合成完整内容（首段 ref 旧方案会丢后续段）
  const mdSegEls = useRef<Array<HTMLDivElement | null>>([]);
  const getRichSource = useCallback((): HTMLElement | null => {
    const els = mdSegEls.current.filter((el): el is HTMLDivElement => !!el);
    if (els.length === 0) return mdRef.current;
    if (els.length === 1) return els[0];
    const wrap = document.createElement('div');
    for (const el of els) wrap.appendChild(el.cloneNode(true));
    return wrap;
  }, []);
  /** 图片放大预览：点击小图弹出大图 lightbox。 */
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const visibleContent = isUser ? visibleImageMessage(m.content || '') : m.content;
  const showCopy = !isUser && !!m.content;
  // pending 与 busy 总是同置同清；仅以 busy 为准，保证「不在执行」的僵尸消息也能删除
  const interruptedLabel = resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)==='en' ? 'Interrupted · Can resume' : '已中断 · 可继续';
  // 归档对话完全只读：不能删除/重发/编辑/分叉，只能看与复制
  const canDelete = !busy && !archived;
  const canSaveImage = !isUser && !!m.content && !m.pending;
  const deleteChatMessage = useAppStore((s) => s.deleteChatMessage);
  const resendChatMessage = useAppStore((s) => s.resendChatMessage);
  const canResend = !busy && !m.pending && !isUser && !!m.error && !archived;
  // 复制消息为图片到剪贴板：点击后直接写入系统剪贴板，无需先保存到磁盘。
  const [msgImgCopied, setMsgImgCopied] = useState(false);
  const msgImgTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCopyMsgImage = useCallback(async () => {
    if (!bubbleRef.current) return;
    const ok = await copyElementToClipboard(bubbleRef.current);
    if (ok) {
      setMsgImgCopied(true);
      clearTimeout(msgImgTimer.current);
      msgImgTimer.current = setTimeout(() => setMsgImgCopied(false), 1500);
    }
  }, []);
  useEffect(() => () => clearTimeout(msgImgTimer.current), []);

  // Context compaction markers are durable timeline entries, but carry no
  // model-visible content.  Render them as a clickable audit notice.
  if (m.contextCompaction) {
    return <ContextCompactionNotice m={m} />;
  }

  // ── 专家团模式消息特殊渲染 ──
  if (m.experts) {
    return <ExpertsMessage m={m} busy={busy} archived={archived} />;
  }

  // ── 入站消息特殊渲染 ──
  // 来自外部渠道（企微/钉钉/飞书/邮件等）的消息用专用卡片展示。
  // 渠道来源信息放在 footer（与时间戳同排），不单独占一行 header。
  if (m.inbound) {
    const bodyContent = stripInboundPrefix(m.content);
    const sender = m.inbound.senderName || m.inbound.senderId || m.inbound.channelName;
    return (
      <div id={`chat-msg-${m.id}`} className="chat-msg chat-msg-user chat-msg-inbound">
        <div className={`chat-bubble${isUser && !visibleContent ? ' chat-bubble-no-text' : ''}`} ref={bubbleRef}>
          {bodyContent ? (
            <div className="md" ref={mdRef}>
              <div data-markdown-document><ReactMarkdown remarkPlugins={[remarkGfm, remarkLocalImages]} components={mermaidMarkdownComponents}>{bodyContent}</ReactMarkdown></div>
            </div>
          ) : null}
          <div className="chat-msg-footer">
            <div className="chat-msg-footer-left">
              {canDelete ? (
                <button
                  className="chat-msg-delete-btn"
                  title={t('chat.deleteMessage')}
                  onClick={async () => {
                    if (await confirmDialog({ message: t('chat.deleteMessageConfirm'), danger: true })) {
                      deleteChatMessage(m.timelineSourceId ?? m.id);
                    }
                  }}
                >
                  <Trash2 size={12} />
                </button>
              ) : null}
            </div>
            <div className="chat-msg-footer-right">
              <span className="inbound-source">{channelIcon(m.inbound.channelType)} {m.inbound.channelName} · {sender}</span>
              {m.ts && <span className="chat-msg-time">{formatMessageTime(m.ts)}</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id={`chat-msg-${m.id}`} data-source-message-id={m.timelineSourceId??m.id} className={`chat-msg chat-msg-${m.role}`}>
        {!isUser && <MessageWorkDuration m={m} busy={busy}/>}
        {m.images && m.images.length > 0 ? (
          <div className="msg-images">
            {m.images.map((img, i) => {
              const src = `data:${img.mimeType};base64,${img.dataBase64}`;
              return (
                <div className="msg-img-wrap" key={i}>
                  <span className="msg-img-badge">{t('chat.imgN', { n: i + 1 })}</span>
                  <img
                    src={src}
                    alt={img.name}
                    title={t('chat.imageClickEnlarge')}
                    className="msg-img-thumb"
                    onClick={() => setLightboxSrc(src)}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
        {lightboxSrc ? (
          <ImageLightbox src={lightboxSrc} sources={m.images?.map(img=>({src:`data:${img.mimeType};base64,${img.dataBase64}`,name:img.name}))} onClose={() => setLightboxSrc(null)} />
        ) : null}
      <div className={`chat-bubble${isUser && !visibleContent ? ' chat-bubble-no-text' : ''}`} ref={bubbleRef}>
        {/* 插话消息角标：标识这条消息是在执行过程中插话的 */}
        {m.interjection && (
          <div className="msg-interject-badge" title={t('chat.interjectBadgeTitle')}>
            <CornerUpLeft size={11} />
            {t('chat.interjectBadge')}
          </div>
        )}
        {visibleContent || (m.toolCalls && m.toolCalls.length > 0) ? (
          isUser ? (
            <div className="user-text">{visibleContent}</div>
          ) : (
            <div className="msg-segments" data-debug={`role=${m.role}, content.length=${(m.content ?? '').length}`}>
              {(() => {
                const segs = buildMessageSegments(m);
                // 如果分段为空（所有文本都是空白），不渲染
                if (segs.length === 0) return null;

                // 尾部思考指示：pending 且（还没有任何输出 / 末段是已完成的工具组）
                // 时，在末尾补一个「深度思考 · Ns」；若有工具仍在运行，
                // 工具卡自带转圈动画，不再重复显示。
                const calls = m.toolCalls ?? [];
                const anyRunning = calls.length > 0 && !calls[calls.length - 1].result;
                const showThinking =
                  m.pending && !anyRunning &&
                  (segs.length === 0 || segs[segs.length - 1].kind === 'tools');
                return (
                  <>
                    {segs.map((seg, i) =>
                      seg.kind === 'text' ? (
                        <div className="md msg-seg-text" key={`t${i}`} ref={(el) => { mdSegEls.current[i] = el; }}>
                          <div data-markdown-document><ReactMarkdown remarkPlugins={[remarkGfm, remarkLocalImages]} components={mermaidMarkdownComponents}>{seg.text}</ReactMarkdown></div>
                        </div>
                      ) : (
                        <ToolCallsGroup key={`c${i}`} calls={seg.calls} busy={busy && m.pending} />
                      ),
                    )}
                    <UploadResults calls={m.toolCalls}/>
                    {showThinking ? <ThinkingIndicator key="think" msg={m} isThinking /> : null}
                  </>
                );
              })()}
            </div>
          )
        ) : m.pending && busy ? (
          <ThinkingIndicator msg={m} isThinking />
        ) : null}
        {m.pending && busy && m.retryInfo ? (
          <div className="chat-retry-hint muted small">
            {t('chat.retrying', {
              attempt: m.retryInfo.attempt,
              max: m.retryInfo.max,
              seconds: (m.retryInfo.waitMs / 1000).toFixed(1),
            })}
          </div>
        ) : null}
        {m.error ? (
          <div className="msg-error">
            <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            <span className="msg-error-text"><ConversationErrorText error={m.error} /></span>
            <ModelSetupNotice error={m.error}/>
            {canResend ? (
              <button
                className="msg-error-retry"
                onClick={() => void resendChatMessage(m.timelineSourceId ?? m.id)}
                title={t('chat.resend')}
              >
                <RotateCcw size={12} />
                {t('chat.resend')}
              </button>
            ) : null}
          </div>
        ) : null}

      </div>
        <div className="chat-msg-footer">
          {/* 会话执行期间：已完成（非 pending）消息的操作排常显，
              避免「模型在跑时整排消失」导致跑完的气泡无法复制 */}
          <div className={`chat-msg-footer-left${busy && !m.pending ? ' show' : ''}`}>
            {showCopy ? (
              <CopyButtons markdown={m.content!} htmlRef={mdRef} htmlGetter={getRichSource} compact />
            ) : null}
            {/* 重新编辑按钮：所有用户消息可用；编辑后内容回收进输入框并从本条起截断；
                执行中改为禁用（而非隐藏），保证操作排不整体塌陷 */}
            {isUser && onEdit && m.content && !archived ? (
              <button
                className="chat-msg-action-btn"
                title={t('chat.reedit')}
                disabled={busy}
                onClick={() => onEdit(m)}
              >
                <Pencil size={12} />
              </button>
            ) : null}
            {/* reload 按钮：从本条重新发起提问（删除本条及其后回复，再以原内容重发） */}
            {isUser && onReload && !archived && (m.content || (m.images && m.images.length > 0)) ? (
              <button
                className="chat-msg-action-btn"
                title={t('chat.reask')}
                disabled={busy}
                onClick={() => onReload(m)}
              >
                <RotateCcw size={12} />
              </button>
            ) : null}
            {/* 分叉按钮：从这条消息分叉出新对话（保留到该消息为止的上下文）
                仅助手消息提供：用户提问侧不需要分叉 */}
            {!archived && !m.pending && !m.timelinePartial && m.role === 'assistant' && (m.content || (m.toolCalls && m.toolCalls.length > 0)) ? (
              <button
                className="chat-msg-action-btn"
                title={t('chat.fork')}
                disabled={busy}
                onClick={() => {
                  void useAppStore.getState().forkConversationFromMessage(m.timelineSourceId ?? m.id);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 21V3m-4 4 4-4 4 4M7 21c0-8 4-10 14-10m-4-4 4 4-4 4"/></svg>
              </button>
            ) : null}
            {canSaveImage ? (
              <button
                className="chat-msg-img-btn"
                title={t('chat.saveImage')}
                onClick={() => {
                  if (bubbleRef.current) {
                    void saveElementAsImage(bubbleRef.current, imageFilename('message'), {
                      exclude: ['chat-msg-actions'],
                    });
                  }
                }}
              >
                <ImageDown size={12} />
              </button>
            ) : null}
            {canSaveImage ? (
              <button
                className={`chat-msg-img-btn${msgImgCopied ? ' copied' : ''}`}
                title={msgImgCopied ? t('chat.imageCopied') : t('chat.copyImage')}
                onClick={onCopyMsgImage}
              >
                {msgImgCopied ? <Check size={12} /> : <Images size={12} />}
              </button>
            ) : null}
            {/* 归档对话连“删除这条”都不给：隐藏而非禁用，避免成排灰色图标误导还有可做的事 */}
            {archived ? null : (
            <button
              className="chat-msg-delete-btn"
              title={t('chat.deleteMessage')}
              disabled={!canDelete}
              onClick={async () => {
                if (await confirmDialog({ message: t('chat.deleteMessageConfirm'), danger: true })) {
                  deleteChatMessage(m.timelineSourceId ?? m.id);
                }
              }}
            >
              <Trash2 size={12} />
            </button>
            )}
            {!isUser && m.role === 'assistant' ? <button className="chat-msg-action-btn" title={t('chat.debugRequest')} aria-label={t('chat.debugRequest')} onClick={() => useAppStore.getState().openMessageMonitor(m.timelineSourceId ?? m.id)}><Bug size={12} /></button> : null}
          </div>
          {m.ts && <div className="chat-msg-time">{formatMessageTime(m.ts)}</div>}
        </div>
    </div>
  );
}

export function ExpertExecutionDetails({ complete, children, nested = false }: { complete: boolean; children: React.ReactNode; nested?: boolean }) {
  const en = resolveLanguage(useAppStore(s => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  return <details className={`expert-execution-details${nested ? ' experts-child-team' : ''}`} open={!complete}>
    <summary className={nested ? 'experts-child-toggle' : 'expert-execution-toggle'}>
      <ChevronRight size={14}/><ListChecks size={14}/>
      {en ? 'Task execution details' : '任务执行详情'}
    </summary>
    <div className={nested ? 'experts-child-content' : 'expert-execution-content'}>{children}</div>
  </details>;
}

/**
 * 专家团模式消息渲染（借鉴 Qoder Experts Mode）。
 * 四种形态：status（过程状态细条）/ plan（执行计划卡片）/
 * task（专家执行卡片，流式展示执行过程）/ summary（汇总报告）。
 */
export function ExpertsMessage({ m, busy, archived = false, nestedMessages = [], subPlan }: { m: ChatMessage; busy: boolean; archived?: boolean; nestedMessages?: ChatMessage[]; subPlan?: ExpertsPlan }) {
  const t = useT();
  const mdRef = useRef<HTMLDivElement>(null);
  // 多段文本逐段登记，富文本复制时合成完整内容
  const mdSegEls = useRef<Array<HTMLDivElement | null>>([]);
  const getRichSource = useCallback((): HTMLElement | null => {
    const els = mdSegEls.current.filter((el): el is HTMLDivElement => !!el);
    if (els.length === 0) return mdRef.current;
    if (els.length === 1) return els[0];
    const wrap = document.createElement('div');
    for (const el of els) wrap.appendChild(el.cloneNode(true));
    return wrap;
  }, []);
  const deleteChatMessage = useAppStore((s) => s.deleteChatMessage);
  const expertsConfirmPlan = useAppStore((s) => s.expertsConfirmPlan);
  const expertsRetryFailedTasks = useAppStore((s) => s.expertsRetryFailedTasks);
  const conversationPlan = useAppStore((s) => s.currentConversation?.expertsPlan);
  const plan = subPlan ?? conversationPlan;
  const expertDefinitions = useAppStore((s) => s.settings?.expertDefinitions ?? {});
  const expertsEn = resolveLanguage(useAppStore((s) => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  const [showReplanInput, setShowReplanInput] = useState(false);
  const [replanFeedback, setReplanFeedback] = useState('');
  // 执行中和出错时展开，完成后收起；用户仍可手动查看历史。
  // 注意：useState 必须在组件顶层调用，不能放进 kind 条件分支。
  const [taskExpanded, setTaskExpanded] = useState<boolean | undefined>();
  const resolvedTask = resolveExpertTask(plan, m);
  useEffect(() => { setTaskExpanded(undefined); }, [resolvedTask?.status]);

  const kind = m.experts?.kind;
  const role = m.experts?.role ?? 'lead';
  const meta = resolveExpertMeta(role, expertDefinitions, expertsEn);
  // pending 与 busy 总是同置同清；仅以 busy 为准，保证「不在执行」的僵尸消息也能删除
  const interruptedLabel = resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)==='en' ? 'Interrupted · Can resume' : '已中断 · 可继续';
  const canDelete = !busy && !archived;

  const footer = (
    <div className="chat-msg-footer">
      {/* 执行期间已完成消息操作排常显：专家团单卡跑完即可复制，不必等整轮结束 */}
      <div className={`chat-msg-footer-left${busy && !m.pending ? ' show' : ''}`}>
        {m.content && kind !== 'status' ? <CopyButtons markdown={m.content} htmlRef={mdRef} htmlGetter={getRichSource} compact /> : null}
        {archived ? null : (
        <button
          className="chat-msg-delete-btn"
          title={t('chat.deleteMessage')}
          disabled={!canDelete}
          onClick={async () => {
            if (await confirmDialog({ message: t('chat.deleteMessageConfirm'), danger: true })) {
              deleteChatMessage(m.timelineSourceId ?? m.id);
            }
          }}
        >
          <Trash2 size={12} />
        </button>
        )}
      </div>
      {m.ts && <div className="chat-msg-time">{formatMessageTime(m.ts)}</div>}
    </div>
  );

  // ── status: 过程状态细条 ──
  if (kind === 'status') {
    // Legacy nested status messages repeated the parent identity already shown by the card.
    const statusText = m.experts?.parentTaskId ? m.content
      .replace(/^🧩 .*?（主任务：.*?）发现任务需要进一步拆解，正在组建子团队…/, '正在拆分子任务…')
      .replace(/^.*? 的子团队计划已生成/, '子团队计划已生成') : m.content;
    return (
      <div id={`chat-msg-${m.id}`} className="chat-msg chat-msg-assistant chat-experts-status">
        <div className="experts-status-line">
          <span className="experts-status-icon"><span className="experts-status-dot" /></span>
          <span className="experts-status-text">{statusText}</span>
          {m.pending && busy ? <span className="experts-status-spinner" /> : null}
        </div>
      </div>
    );
  }

  // ── plan: 执行计划卡片 ──
  if (kind === 'plan') {
    const planStatus = subPlan && expertTasksComplete(subPlan.tasks) ? 'done' : plan?.status ?? 'draft';
    const planManager = !subPlan ? resolveExpertMeta('lead', expertDefinitions, expertsEn) : null;
    const taskCounts = {
      done: plan?.tasks.filter(task => task.status === 'done').length ?? 0,
      error: plan?.tasks.filter(task => task.status === 'error').length ?? 0,
      running: plan?.tasks.filter(task => task.status === 'running').length ?? 0,
      pending: plan?.tasks.filter(task => task.status === 'pending').length ?? 0,
    };
    const statusLabel: Record<string, string> = {
      draft: t('experts.stDraft'), confirmed: t('experts.stConfirmed'), running: t('experts.stRunning'), done: t('experts.stDone'), canceled: t('experts.stCanceled'),
    };
    return (
      <div id={`chat-msg-${m.id}`} className="chat-msg chat-msg-assistant experts-plan-message">
        {plan?.goal ? <div className="experts-plan-outline">{plan.goal.replace(/[。.!]+$/, '')}{expertsEn ? '. The execution plan is outlined below.' : '。据此制定了以下执行计划。'}</div> : null}
        <details className="chat-bubble experts-card experts-plan-overview" open={!subPlan && planStatus === 'draft'}>
          <summary className="experts-card-header">
            <span className="experts-card-title"><ChevronRight className="experts-plan-chevron" size={13}/><ListChecks size={14} /> {subPlan ? (expertsEn ? 'Subtask execution plan' : '子任务执行计划') : t('experts.planTitle')}{planManager && <span className="experts-plan-manager">· {planManager.name} {planManager.humanName}</span>}</span>
            {plan ? <span className="experts-plan-counts">
              <span>{expertsEn ? `${plan.tasks.length} tasks` : `共 ${plan.tasks.length} 项`}</span>
              <span>{expertsEn ? `${taskCounts.done} completed` : `已完成 ${taskCounts.done} 项`}</span>
              {taskCounts.error > 0 && <span className="experts-plan-failed">{expertsEn ? `${taskCounts.error} failed` : `失败 ${taskCounts.error} 项`}</span>}
              {taskCounts.running > 0 && <span>{expertsEn ? `${taskCounts.running} ${busy ? 'running' : 'interrupted'}` : `${busy ? '进行中' : '已中断'} ${taskCounts.running} 项`}</span>}
              {taskCounts.pending > 0 && <span>{expertsEn ? `${taskCounts.pending} pending` : `待执行 ${taskCounts.pending} 项`}</span>}
            </span> : null}
            {['draft', 'confirmed', 'canceled'].includes(planStatus) && <span className="experts-plan-state">{statusLabel[planStatus]}</span>}
          </summary>
          {plan && plan.tasks.length > 0 ? (
            <div className="experts-plan-tasks">
              {plan.tasks.map((task, i) => (
                <div key={task.id} className={`experts-plan-task ${task.status}`}>
                  <span className="experts-plan-task-status">
                    {task.status === 'done' ? '✓' : task.status === 'running' ? (
                      <>{busy ? <span className="experts-task-spinner" /> : <CircleAlert size={13}><title>{interruptedLabel}</title></CircleAlert>}</>
                    ) : task.status === 'error' ? '✗' : '○'}
                  </span>
                  <div className="experts-plan-task-body">
                    <div className="experts-plan-task-title">
                      {i + 1}. {task.title}
                      <span className="experts-plan-task-expert">
                        {(() => {
                          const em = resolveExpertMeta(task.expert, expertDefinitions, expertsEn);
                          return (<><ExpertGlyph meta={em} size={11} /> {em.name} {task.expertName ?? em.humanName}</>);
                        })()}
                      </span>
                    </div>
                    <div className="experts-plan-task-desc muted small">{task.description}</div>
                    {task.dependsOn && task.dependsOn.length > 0 ? (
                      <div className="experts-plan-task-dep muted small">{t('experts.dep', { deps: task.dependsOn.join(', ') })}</div>
                    ) : null}
                    {task.subPlan ? (
                      <div className="experts-plan-task-dep experts-plan-task-sub muted small">
                        {t('experts.subSplit', { n: task.subPlan.tasks.length })}
                        {t('experts.doneN', { n: task.subPlan.tasks.filter((x) => x.status === 'done').length })}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="md" ref={mdRef}>
              <div data-markdown-document><ReactMarkdown remarkPlugins={[remarkGfm, remarkLocalImages]} components={mermaidMarkdownComponents}>{m.content}</ReactMarkdown></div>
            </div>
          )}
          {/* 待确认状态：确认 / 重新规划 / 取消。
              注意：计划等待确认时后端仍处于 busy（挂起等确认），
              所以这里不能用 !busy 作为渲染条件，否则按钮永远不出现。 */}
          {planStatus === 'draft' && !archived && !subPlan ? (
            <div className="experts-plan-actions">
              <button className="btn btn-primary" onClick={() => void expertsConfirmPlan('confirm')}>▶ {t('experts.confirmRun')}</button>
              <button className="btn" onClick={() => setShowReplanInput(!showReplanInput)}>↺ {t('experts.replan')}</button>
              <button className="btn btn-danger" onClick={() => void expertsConfirmPlan('cancel')}>{t('common.cancel')}</button>
            </div>
          ) : null}
          {planStatus === 'done' && plan?.hasFailedTasks && !archived && !subPlan ? (
            <div className="experts-plan-actions">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void expertsRetryFailedTasks()}
              >
                ↻ {t('experts.retryFailed')}
              </button>
              <span className="muted small">{t('experts.retryHint')}</span>
            </div>
          ) : null}
          {showReplanInput && !archived ? (
            <div className="experts-replan-box">
              <textarea
                className="experts-replan-input"
                placeholder={t('experts.replanPh')}
                value={replanFeedback}
                onChange={(e) => setReplanFeedback(e.target.value)}
                rows={2}
                autoFocus
              />
              <div className="experts-replan-actions">
                <button
                  className="btn btn-primary"
                  disabled={!replanFeedback.trim()}
                  onClick={() => {
                    setShowReplanInput(false);
                    void expertsConfirmPlan('replan', replanFeedback.trim());
                    setReplanFeedback('');
                  }}
                >
                  {t('experts.submitFeedback')}
                </button>
                <button className="btn" onClick={() => setShowReplanInput(false)}>{t('experts.back')}</button>
              </div>
            </div>
          ) : null}
        </details>
        {!subPlan && footer}
      </div>
    );
  }

  // ── task: 专家执行任务卡片 ──
  if (kind === 'task') {
    // 嵌套支持：depth>1 的任务数据在父任务的 subPlan 里（专家团嵌套专家团）
    const markerDepth = m.experts?.depth ?? 1;
    const isNested = markerDepth > 1 && !!m.experts?.parentTaskId;
    const task = resolvedTask;
    const historicalAttempt = !!task?.msgId && task.msgId !== (m.timelineSourceId ?? m.id);
    const attemptBusy = busy && !historicalAttempt;
    const historicalLabel = resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)==='en' ? 'Interrupted · Continued in a new attempt' : '已中断 · 已继续';
    const expertMeta = resolveExpertMeta(role, expertDefinitions, expertsEn);
    // 人名优先取任务实例名（同角色并行时各不同），回退消息内嵌名，再回退角色主名
    const displayName = m.experts?.expertName ?? task?.expertName ?? expertMeta.humanName;
    const taskStatusLabel = historicalAttempt ? historicalLabel : task?.status === 'done' ? t('experts.stDone')
      : task?.status === 'running' ? (attemptBusy ? t('experts.stRunning') : interruptedLabel)
      : task?.status === 'error' ? t('experts.stError') : t('experts.stWaiting');

    // 执行中自动展开，完成后折叠，最终汇总结论保持可见。
    // 点击标题栏展开查看完整过程（流式文本 + 工具调用）。
    // 出错时自动展开。
    const expanded = taskExpanded ?? (!historicalAttempt && (task?.status === 'error' || attemptBusy && task?.status === 'running'));
    const childTasks = task?.subPlan?.tasks ?? [];
    const parent = isNested ? plan?.tasks.find(t => t.id === m.experts?.parentTaskId) : undefined;

    // 折叠态的一行摘要：
    //  - 执行中：最近一条工具调用（正在做什么）
    //  - 已完成：输出末尾的一段总结（专家被要求最后输出总结）
    const lastCall = m.toolCalls && m.toolCalls.length > 0 ? m.toolCalls[m.toolCalls.length - 1] : null;
    const collapsedSummary = (() => {
      if (historicalAttempt) return historicalLabel;
      if (!busy && (task?.status === 'running' || (!task && m.pending))) return interruptedLabel;
      if (task?.status === 'running' || m.pending) {
        if (lastCall) {
          const s = formatToolSummary({ id: '', name: lastCall.name, input: lastCall.input });
          return `${displayToolName(lastCall)}${s ? ' · ' + s : ''}`;
        }
        return t('experts.thinking');
      }
      if (task?.status === 'error' && m.error) return m.error;
      const src = (!historicalAttempt && task?.result) || m.content || '';
      // 取末尾非空的一小段作为摘要
      const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return '';
      const tail = lines[lines.length - 1]
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^[#>\s\d.)-]+/, '').replace(/[*_`~]/g, '').replace(/\s*\|\s*/g, ' · ').replace(/^(?: · )+|(?: · )+$/g, '').trim();
      return tail.length > 120 ? tail.slice(0, 120) + '…' : tail;
    })();

    return (
      <div id={`chat-msg-${m.id}`} className={`chat-msg chat-msg-assistant experts-task-message${isNested ? ' experts-msg-nested' : ''}`}>
        <div className={`chat-bubble experts-card experts-task-card${expanded ? '' : ' collapsed'}`}>
          <button type="button"
            className="experts-card-header clickable"
            aria-expanded={expanded}
            onClick={() => setTaskExpanded(!expanded)}
            title={expanded ? t('experts.collapseTitle') : t('experts.expandTitle')}
          >
            <span className="experts-card-title">
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="experts-task-primary">{task?.title ?? displayName}</span>
              <span className="experts-task-owner">{expertMeta.name} {displayName}</span>
              {isNested ? <span className="experts-nested-badge" title={parent?.title}>{parent?.expertName ? `${parent.expertName} · ` : ''}{t('experts.nested')}</span> : null}
            </span>
            {task ? <span className={`experts-plan-badge ${historicalAttempt ? 'interrupted' : task.status}`}>{expanded && attemptBusy && task.status === 'running' ? <span className="experts-task-spinner" /> : null}{taskStatusLabel}</span> : null}
          </button>
          {expanded ? (
            <div className="experts-task-body">
              {m.content || (m.toolCalls && m.toolCalls.length > 0) ? (
                <div className="msg-segments">
                  {buildMessageSegments(m).map((seg, i) =>
                    seg.kind === 'text' ? (
                      <div className="md msg-seg-text" key={`t${i}`} ref={(el) => { mdSegEls.current[i] = el; }}>
                        <div data-markdown-document><ReactMarkdown remarkPlugins={[remarkGfm, remarkLocalImages]} components={mermaidMarkdownComponents}>{seg.text}</ReactMarkdown></div>
                      </div>
                    ) : (
                      <ToolCallsGroup key={`c${i}`} calls={seg.calls} busy={attemptBusy && (m.pending || task?.status === 'running')} />
                    ),
                  )}
                  <UploadResults calls={m.toolCalls}/>
                  {m.pending && attemptBusy && !m.content && (!m.toolCalls || m.toolCalls.length === 0) ? (
                    <ThinkingIndicator msg={m} isThinking />
                  ) : null}
                </div>
              ) : m.pending && attemptBusy ? (
                <ThinkingIndicator msg={m} isThinking />
              ) : null}
              {m.error ? (
                <div className="msg-error">
                  <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  <span className="msg-error-text"><ConversationErrorText error={m.error} /></span>
            <ModelSetupNotice error={m.error}/>
                </div>
              ) : null}
            </div>
          ) : collapsedSummary ? (
            <div className={`experts-task-summary muted small${task?.status === 'error' ? ' is-error' : ''}`}>
              {attemptBusy && (task?.status === 'running' || m.pending) ? <span className="experts-task-spinner" /> : (historicalAttempt || !busy && (task?.status === 'running' || (!task && m.pending))) ? <CircleAlert size={13} /> : null}
              <span>{collapsedSummary}</span>
            </div>
          ) : null}
          {(nestedMessages.length > 0 || childTasks.length > 0) && <section className="experts-subteam">
              {task?.subPlan && <ExpertsMessage
                m={{ ...m, id: `${m.id}-subplan`, content: '', experts: { ...m.experts, kind: 'plan' } }}
                busy={attemptBusy} archived={archived} subPlan={task.subPlan}
              />}
              {nestedMessages.length > 0 && <ExpertExecutionDetails nested complete={expertTasksComplete(childTasks)}>
                {nestedMessages.map(child => <ExpertsMessage key={child.id} m={child} busy={busy} archived={archived}/>)}
              </ExpertExecutionDetails>}
          </section>}
        </div>
        {footer}
      </div>
    );
  }

  // ── summary: 项目经理汇总报告 ──
  return (
    <div id={`chat-msg-${m.id}`} className="chat-msg chat-msg-assistant experts-summary-message">
      <div className="chat-bubble experts-card experts-summary-card">
        <div className="experts-card-header">
          <span className="experts-card-title"><Brain size={14} /> {t('experts.summaryTitle', { name: resolveExpertMeta('lead', expertDefinitions, expertsEn).humanName })}</span>
        </div>
        {m.content ? (
          <div className="md" ref={mdRef}>
            <div data-markdown-document><ReactMarkdown remarkPlugins={[remarkGfm, remarkLocalImages]} components={mermaidMarkdownComponents}>{m.content}</ReactMarkdown></div>
          </div>
        ) : m.pending && busy ? (
          <span className="muted small">…</span>
        ) : null}
        {m.error ? (
          <div className="msg-error">
            <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            <span className="msg-error-text"><ConversationErrorText error={m.error} /></span>
            <ModelSetupNotice error={m.error}/>
          </div>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

/**
 * 工具调用列表：默认折叠，只显示最后一条（正在/最近执行的操作），
 * 其余折叠成一行按钮，点击「查看全部 N 条操作」展开。
 * 流式进行中（streaming）同样只显示最后一条，保证焦点在当前操作上。
 */
function formatThinkingElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/**
 * 「深度思考 · Ns」指示器。
 *
 * 计时起点 = 进入思考态的那一刻（由 isThinking prop 决定）：
 *   isThinking: false → true：记录当前时间为起点，从 0 开始累计
 *   isThinking: true → false：清空起点，重置计时
 *
 * 这样每次从工具执行完成 → 模型继续思考，都会重置计时，
 * 不会把工具执行时间算进「深度思考」里。
 *
 * 计时起点保存在模块级 Map 中（keyed by msg.id），而非 useState，
 * 防止切换对话导致组件卸载/重挂载时计时重置为 0。
 */
const thinkingStartTimes = new Map<string, number>();

function ThinkingIndicator({ msg, isThinking }: { msg: ChatMessage; isThinking: boolean }) {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);

  const [started, setStarted] = useState<number | null>(() => thinkingStartTimes.get(msg.id) ?? null);

  // isThinking 变化时：进入思考态记录起点，离开时清空
  useEffect(() => {
    if (isThinking) {
      const start = thinkingStartTimes.get(msg.id) ?? Date.now();
      thinkingStartTimes.set(msg.id, start);
      setStarted(start);
    } else {
      thinkingStartTimes.delete(msg.id);
      setStarted(null);
      setElapsed(0);
    }
  }, [isThinking, msg.id]);

  // 计时定时器：只在有起点时运行
  useEffect(() => {
    if (started === null) return;
    // 挂载时立即计算一次，避免切回来显示 0
    setElapsed(Math.floor((Date.now() - started) / 1000));
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [started]);

  if (!isThinking || started === null) return null;

  return (
    <div className="thinking-indicator">
      {/* 原子轨道图标（静态、浅灰色） —— 参考图1风格 */}
      <span className="thinking-icon">
        <Atom size={12} />
      </span>
      <span className="thinking-label">{t('chat.thinking', { seconds: formatThinkingElapsed(elapsed) })}</span>
    </div>
  );
}

/** 消息流片段：正文文本段 或 一组工具调用卡。 */
type MsgSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; calls: ToolCall[] };

/**
 * 按时间顺序交错正文与工具卡片。
 *
 * 每个 ToolCall 携带 contentOffset（后端在 tool_use 发起时刻记录的正文长度），
 * 据此把正文切成多段，与工具卡按真实发生顺序排列：
 *   正文[0..off1] → 工具卡1 → 正文[off1..off2] → 工具卡2 → … → 尾部正文
 *
 * 修复「倒挂」：提问（AskUser）之后的回复文本此前固定渲染在工具卡上方，
 * 时间顺序错乱；现在回答后的输出正确出现在问题澄清卡片之后。
 *
 * 旧消息（无 contentOffset）回退为旧布局：正文在前、工具卡在后。
 *
 * 过滤掉纯空白文本段，避免渲染出空的气泡。
 */
function buildMessageSegments(m: ChatMessage): MsgSegment[] {
  const rows = uploadResults(m.toolCalls);
  return rawMessageSegments(m).map(seg => seg.kind === 'text' && rows.length ? {...seg, text: withoutUploadSummary(seg.text, rows)} : seg).filter(seg => seg.kind !== 'text' || seg.text.trim());
}
function rawMessageSegments(m: ChatMessage): MsgSegment[] {
  const content = m.content ?? '';
  const calls = m.toolCalls ?? [];
  if (calls.length === 0) {
    // 只返回非空内容
    const trimmed = content.trim();
    return trimmed ? [{ kind: 'text', text: content }] : [];
  }
  const hasOffsets = calls.some((c) => typeof c.contentOffset === 'number');
  if (!hasOffsets) {
    const segs: MsgSegment[] = [];
    if (content.trim()) segs.push({ kind: 'text', text: content });
    segs.push({ kind: 'tools', calls });
    return segs;
  }
  const withOffsets = calls
    .map((c) => ({
      call: c,
      offset:
        typeof c.contentOffset === 'number'
          ? Math.max(0, Math.min(c.contentOffset, content.length))
          : content.length,
    }))
    .sort((a, b) => a.offset - b.offset);

  const segs: MsgSegment[] = [];
  let pos = 0;
  let i = 0;
  while (i < withOffsets.length) {
    const off = withOffsets[i].offset;
    if (off > pos) {
      const textSlice = content.slice(pos, off);
      // 只添加非空的文本段
      if (textSlice.trim()) {
        segs.push({ kind: 'text', text: textSlice });
      }
      pos = off;
    }
    // 同一 offset 的工具调用（同轮批量发起、中间无正文）归为一组
    const group: ToolCall[] = [];
    while (i < withOffsets.length && withOffsets[i].offset === pos) {
      group.push(withOffsets[i].call);
      i++;
    }
    if (group.length > 0) segs.push({ kind: 'tools', calls: group });
  }
  if (pos < content.length) {
    const remaining = content.slice(pos);
    // 只添加非空的文本段
    if (remaining.trim()) {
      segs.push({ kind: 'text', text: remaining });
    }
  }
  return segs;
}

/**
 * 渲染层轻量版 options 规整（与主进程 normalizeAskUserOptions 同思路）：
 * 兼容数组 / JSON 字符串 / {options|choices|…} 包裹 / 字符串项等多种形态。
 */
function extractAskUserOptions(raw: any): Array<{ label: string; description?: string }> {
  if (!raw) return [];
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (value && !Array.isArray(value) && typeof value === 'object') {
    for (const k of ['options', 'choices', 'answers', 'suggestions', 'items']) {
      if (Array.isArray(value[k])) {
        value = value[k];
        break;
      }
    }
  }
  if (!Array.isArray(value)) return [];
  const out: Array<{ label: string; description?: string }> = [];
  for (const item of value) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string' || typeof item === 'number') {
      const label = String(item).trim();
      if (label) out.push({ label });
    } else if (typeof item === 'object') {
      const label = String(
        item.label ?? item.title ?? item.text ?? item.name ?? item.value ?? '',
      ).trim();
      const desc = item.description ?? item.desc ?? item.detail ?? item.hint;
      if (label) out.push({ label, description: desc ? String(desc) : undefined });
    }
    if (out.length >= 16) break;
  }
  return out;
}

/** AskUser 结果是否代表「澄清被取消」。 */
function isAskUserCanceled(tc: ToolCall): boolean {
  return !!tc.result && tc.result.startsWith('(澄清被取消');
}

/** AskUser 是否已有有效回答（非取消）。 */
function isAskUserAnswered(tc: ToolCall): boolean {
  return !!tc.result && !tc.isError && !tc.result.startsWith('Unknown tool:') && !isAskUserCanceled(tc);
}

/**
 * AskUser 提问卡片（参考「问题澄清」样式，不折叠、信息全展开）。
 *
 * 同批次（同一 tool 组）里连续多个 AskUser 会合并进一张卡片，
 * 逐条编号列出，避免一堆重复卡片刷屏。
 *
 * 选项展示策略：**已回答后只留存「问题 + 我的回答」，不再展示候选选项**
 * （选项只在等待回答时作为上下文提示）。
 *
 * 视觉去重策略：**等待回答时，消息流中的卡片只显示一行提示**，
 * 引导用户向下滚动到底部的交互面板（ClarifyCard）作答——
 * 底部交互面板才是唯一的完整交互界面，避免两处同时展示相同问题+选项。
 */
function clarificationMode(input: {options?: unknown; multiSelect?: boolean}): string {
  return Array.isArray(input.options) && input.options.length ? input.multiSelect ? '可多选' : '单选' : '自由填写';
}

function AskUserGroupCard({ calls: originalCalls }: { calls: ToolCall[] }) {
  const pending = useAppStore(s => s.pendingClarifiesByConv[s.currentConversation?.id ?? '']);
  const calls = originalCalls.flatMap(tc => {
    if (tc.input?.questions && tc.result) {
      try {
        const answers = JSON.parse(tc.result).answers;
        if (Array.isArray(answers) && answers.length && answers.every(a => typeof a.question === 'string' && Array.isArray(a.selected) && a.selected.every((v: unknown) => typeof v === 'string') && typeof a.text === 'string')) {
          return answers.map((a, index) => ({...tc,id:`${tc.id}:${index}`,input:{...(tc.input.questions.find((q: any) => q.id === a.id) ?? tc.input.questions[index]),question:a.question},result:[...a.selected,a.text].filter(Boolean).join('；')}));
        }
      } catch { /* Legacy text result. */ }
    }
    return [{...tc,input:{...tc.input,question:tc.input?.question || tc.input?.questions?.[0]?.question}}];
  });
  const anyWaiting = calls.some(c => !c.result);
  if (anyWaiting && calls.every(c => !c.result && pending?.some(req =>
    req.question === c.input?.question || req.questions?.some(q => q.question === c.input?.question)))) return null;
  const reason = originalCalls.map(c => c.input?.reason).filter((r): r is string => typeof r === 'string' && !!r.trim()).filter((r,i,all)=>all.indexOf(r)===i).join(' ');
  const answeredCount = calls.filter(isAskUserAnswered).length;
  return <div className="askuser-card askuser-simple">
    <div className="askuser-intro">{reason && <span>{reason} </span>}{anyWaiting ? `有 ${calls.length} 项需要你确认` : `已确认 ${answeredCount} 项${answeredCount < calls.length ? `，另 ${calls.length-answeredCount} 项未完成` : ''}`}</div>
    <div className="askuser-items">
      {calls.map(tc => <div key={tc.id} className="askuser-item">
        <div className="askuser-item-body">
          <div className="askuser-question">{tc.input?.question}<span className="clarify-mode">（{clarificationMode(tc.input)}）</span></div>
          <div className="askuser-answer"><span className="askuser-answer-text">{isAskUserCanceled(tc) ? '已取消' : tc.result || '请在下方确认后继续'}</span></div>
        </div>
      </div>)}
    </div>
  </div>;
}

/** 是否为 AskUser 澄清类工具调用（含 CLI 路径的 mcp__sage__AskUser 别名）。 */
function isAskUserCall(tc: ToolCall): boolean {
  return tc.name === 'AskUser' || tc.name.endsWith('__AskUser');
}

/**
 * 把工具调用序列切成渲染单元：连续的 AskUser 合并为一个 askuser 单元
 * （同批次多维度提问合成一张卡片），其余各自为 tool 单元。
 */
type ToolRenderUnit =
  | { kind: 'askuser'; calls: ToolCall[] }
  | { kind: 'tool'; call: ToolCall };

function partitionToolCalls(calls: ToolCall[]): ToolRenderUnit[] {
  const units: ToolRenderUnit[] = [];
  let askRun: ToolCall[] = [];
  const flushAsk = () => {
    if (askRun.length > 0) {
      units.push({ kind: 'askuser', calls: askRun });
      askRun = [];
    }
  };
  for (const tc of calls) {
    if (isAskUserCall(tc)) {
      askRun.push(tc);
    } else {
      flushAsk();
      units.push({ kind: 'tool', call: tc });
    }
  }
  flushAsk();
  return units;
}

export function ToolCallsGroup({ calls, busy }: { calls: ToolCall[]; busy?: boolean }) {
  const en = resolveLanguage(useAppStore(s => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  const [view, setView] = useState<'all' | 'failed' | 'denied' | 'canceled' | null>(null);
  const units = useMemo(() => partitionToolCalls(calls), [calls]);
  const complete = calls.every(c => c.result !== undefined || toolOutcome(c));
  useEffect(() => { if (complete) setView(null); }, [complete]);
  const latestRunning = busy ? units.findLastIndex(unit => unit.kind === 'tool' && !toolOutcome(unit.call) && unit.call.result === undefined) : -1;

  const renderUnit = (u: ToolRenderUnit, key: string) => u.kind === 'askuser'
    ? <AskUserGroupCard key={key} calls={u.calls}/>
    : <ToolCallView key={key} tc={u.call} busy={busy}/>;
  if (units.length === 0 || (units.length === 1 && units[0].kind === 'askuser' && !calls.some(toolOutcome))) return <div className="tool-calls tool-timeline">{units.map((u,i)=>renderUnit(u,`u${i}`))}</div>;
  const visible = units.map((unit, index) => ({unit, index})).filter(({unit, index}) => {
    const items = unit.kind === 'askuser' ? unit.calls : [unit.call];
    if (view === 'all') return true;
    if (view) return items.some(call => toolOutcome(call) === view);
    return unit.kind === 'askuser' ? items.some(call => !toolOutcome(call) && call.result === undefined) : index === latestRunning;
  });
  const label = complete ? (en ? `Ran ${calls.length} ${calls.length === 1 ? 'tool' : 'tools'}` : `已执行 ${calls.length} 项操作`) : (en ? `${calls.length} tool calls` : `${calls.length} 项操作`);
  return <div className="tool-calls tool-timeline">
    {calls.map(call=><ScheduledTaskFeedback key={call.id} call={call} en={en}/>)}
    <div className="tool-group-heading">
      <button type="button" className="tool-calls-toggle" aria-expanded={view === 'all'} onClick={()=>setView(view === 'all' ? null : 'all')}>
        <span className="tool-timeline-chevron">{view ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}</span>
        <span>{label}</span>
      </button>
      {(['failed', 'denied', 'canceled'] as const).map(outcome => {
        const count = calls.filter(call => toolOutcome(call) === outcome).length;
        const name = en ? {failed:'failed',denied:'denied',canceled:'canceled'}[outcome] : {failed:'失败',denied:'拒绝',canceled:'取消'}[outcome];
        return count > 0 && <button key={outcome} type="button" className="tool-group-exception" data-outcome={outcome} aria-pressed={view === outcome} onClick={()=>setView(view === outcome ? null : outcome)}>{en ? `${count} ${name}` : `${name} ${count} 项`}</button>;
      })}
    </div>
    {visible.length > 0 && <div className="tool-timeline-items">
      {visible.map(({unit,index}) => renderUnit(unit,`u${index}`))}
    </div>}
  </div>;
}

/** 是否为终端/Bash 类工具调用（含 CLI 路径的 mcp__sage__Bash 别名）。 */
function isBashCall(tc: ToolCall): boolean {
  return tc.name === 'Bash' || tc.name.endsWith('__Bash');
}

/** 是否为 Edit 类工具调用（Edit 或 mcp__xxx__Edit）。 */
function isEditCall(tc: ToolCall): boolean {
  return tc.name === 'Edit' || tc.name.endsWith('__Edit');
}

/**
 * LCS（最长公共子序列）按行对比 oldLines/newLines，
 * 返回一个 diff 结果：每一行标记 add/del/ctx，含行号。
 * 用于 Edit 工具的 diff 视图。
 */
type DiffLine = { kind: 'add' | 'del' | 'ctx'; oldNo?: number; newNo?: number; text: string };
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  // 防止超大 diff 拖垮 UI：超过 800 行直接返回 raw 对比（按行）
  if (m + n > 1600) {
    const out: DiffLine[] = [];
    for (let i = 0; i < m; i++) out.push({ kind: 'del', oldNo: i + 1, text: oldLines[i] });
    for (let i = 0; i < n; i++) out.push({ kind: 'add', newNo: i + 1, text: newLines[i] });
    return out;
  }
  // 标准 DP LCS（按字符串匹配，O(mn) 时间）
  const dp: number[][] = new Array(m + 1).fill(null).map(() => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  let oldNo = 1, newNo = 1;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: 'ctx', oldNo: oldNo, newNo: newNo, text: oldLines[i] });
      i++; j++; oldNo++; newNo++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: 'del', oldNo: oldNo, text: oldLines[i] });
      i++; oldNo++;
    } else {
      result.push({ kind: 'add', newNo: newNo, text: newLines[j] });
      j++; newNo++;
    }
  }
  while (i < m) {
    result.push({ kind: 'del', oldNo: oldNo, text: oldLines[i] });
    i++; oldNo++;
  }
  while (j < n) {
    result.push({ kind: 'add', newNo: newNo, text: newLines[j] });
    j++; newNo++;
  }
  return result;
}

/**
 * Edit 工具的 Diff 视图：用红/绿显示 old_string → new_string 差异。
 * 当 old_string == new_string（无变更）时返回 null。
 */
function EditDiffView({ tc }: { tc: ToolCall }) {
  const t = useT();
  const oldStr = tc.input?.old_string;
  const newStr = tc.input?.new_string;
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
  if (oldStr === newStr) {
    return (
      <div className="tool-diff">
        <div className="tool-diff-header">
          <span className="tool-diff-header-label">Edit</span>
          <span>{t('chat.noChanges')}</span>
        </div>
      </div>
    );
  }
  const diff = useMemo(() => computeLineDiff(oldStr, newStr), [oldStr, newStr]);
  const adds = diff.filter((d) => d.kind === 'add').length;
  const dels = diff.filter((d) => d.kind === 'del').length;
  return (
    <div className="tool-diff">
      <div className="tool-diff-header">
        <span className="tool-diff-header-label">Edit</span>
        <span className="tool-diff-stats">
          <span className="tool-diff-stats-add">+{adds}</span>
          <span className="tool-diff-stats-del">−{dels}</span>
        </span>
      </div>
      <div className="tool-diff-body">
        {diff.map((line, idx) => {
          const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
          const no = line.kind === 'del' ? line.oldNo : line.kind === 'add' ? line.newNo : (line.oldNo ?? '');
          return (
            <div key={idx} className={`tool-diff-line ${line.kind === 'ctx' ? 'ctx' : line.kind === 'add' ? 'add' : 'del'}`}>
              <span className="tool-diff-line-num">{no}</span>
              <span className="tool-diff-line-sign">{sign}</span>
              <span className="tool-diff-line-content">{line.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolCallView({ tc, busy }: { tc: ToolCall; busy?: boolean }) {
  const t = useT();
  const en = resolveLanguage(useAppStore(s => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  const summary = useMemo(() => formatToolSummary(tc), [tc]);

  // AskUser 由 ToolCallsGroup 合并成 AskUserGroupCard 渲染，这里不应到达；
  // 兜底仍渲染单张卡片，避免任何路径下问题被显示成折叠的工具行。
  if (isAskUserCall(tc)) {
    return <AskUserGroupCard calls={[tc]} />;
  }

  // TodoWrite → 专用任务清单卡片（参考「添加待办」风格）
  const isTodoWrite = tc.name === 'TodoWrite' || tc.name.endsWith('__TodoWrite');
  if (isTodoWrite && Array.isArray(tc.input?.todos)) {
    return <TodoWriteCard tc={tc} />;
  }

  // file_path 类参数：渲染为可点击链接，点击直接打开项目内文件
  const filePath: string | undefined =
    typeof tc.input?.file_path === 'string'
      ? tc.input.file_path
      : typeof tc.input?.notebook_path === 'string'
        ? tc.input.notebook_path
        : undefined;

  // 运行状态：result 未返回且对话仍 busy → 执行中（转圈）；否则已完成（对勾）
  const running = tc.result === undefined && busy === true && tc.approval !== 'denied' && !tc.aborted;
  // Bash（终端命令）与普通工具在文案与 icon 上区分
  const isBash = isBashCall(tc);
  // Edit 工具：显示 diff 视图，更直观
  const isEdit = isEditCall(tc);
  // Edit 工具的 diff 统计（在标题后显示）
  const editStats = useMemo(() => {
    if (!isEdit) return null;
    const oldStr = tc.input?.old_string;
    const newStr = tc.input?.new_string;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
    if (oldStr === newStr) return null;
    const diff = computeLineDiff(oldStr, newStr);
    const adds = diff.filter((d) => d.kind === 'add').length;
    const dels = diff.filter((d) => d.kind === 'del').length;
    return { adds, dels };
  }, [isEdit, tc.input?.old_string, tc.input?.new_string]);

  return (
    <details className="tool-call">
      <summary>
        <span className={`tool-state-icon ${tc.aborted || tc.approval === 'denied' || tc.isError ? 'failed' : running ? 'running' : tc.result !== undefined ? 'done' : 'pending'}`}
          title={tc.aborted ? (t('chat.askuser.canceled')) : tc.approval === 'denied' ? t('chat.approvalDenied') : tc.isError ? (resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale) === 'en' ? 'Failed' : '执行失败') : running ? t('chat.tool.running') : tc.result !== undefined ? t('chat.status.done') : t('experts.stWaiting')}>
          {tc.aborted || tc.approval === 'denied' || tc.isError ? <CircleAlert size={12}/> : running ? <Loader2 size={12} className="tool-spin"/> : tc.result !== undefined ? <CheckCircle2 size={12}/> : <Wrench size={12}/>}
        </span>
        <span className="tool-name" title={tc.name}>
          {displayToolName(tc)}
        </span>
        {/* 命令摘要（可省略） */}
        {filePath ? (
          <span
            className="tool-summary tool-summary-file muted small"
            title={t('chat.openFileTitle')}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void openProjectFileByRef(filePath);
            }}
          >{summary}</span>
        ) : (
          <span className="tool-summary muted small">{summary}</span>
        )}
        {/* Edit 工具的 diff 统计：+N −M 紧跟在文件名后 */}
        {editStats ? (
          <span className="tool-edit-stats muted small">
            {editStats.adds > 0 ? (
              <span className="tool-edit-stats-add">+{editStats.adds}</span>
            ) : null}
            {editStats.dels > 0 ? (
              <span className="tool-edit-stats-del">−{editStats.dels}</span>
            ) : null}
          </span>
        ) : null}
        {/* 状态标签（放最后，按优先级） */}
        {tc.aborted ? (
          <span className="tool-approval-tag">{en ? 'Canceled' : '已取消'}</span>
        ) : tc.approval === 'denied' ? (
          <span className="tool-approval-tag denied" title={tc.approvalReason ?? tc.result}>{t('chat.approvalDenied')}</span>
        ) : tc.isError ? (
          <span className="tool-approval-tag denied">{en ? 'Failed' : '执行失败'}</span>
        ) : tc.approval === 'allowed' && tc.result === undefined ? (
          <span className="tool-approval-tag allowed">{t('chat.approvalAllowed')}</span>
        ) : null}
      </summary>
      <div className="tool-identifier muted small" style={{ margin: '8px 0', overflowWrap: 'anywhere' }}>
        {en ? 'Tool identifier: ' : '工具标识：'}<code>{tc.name}</code>
      </div>
      {/* Edit 工具：用 diff 视图替代原始 JSON input，更直观 */}
      {isEdit ? <EditDiffView tc={tc} /> : (
        tc.input ? (
          <pre className="tool-input">{JSON.stringify(tc.input, null, 2)}</pre>
        ) : null
      )}
      {tc.approval === 'denied' && !tc.aborted ? <p className="msg-error" role="status">
        {approvalLabel(tc, en)}{en ? ': ' : '：'}{approvalReason(tc, en)}
      </p> : null}
      {tc.result && (tc.approval !== 'denied' || tc.aborted) ? <pre className={`tool-result${toolOutcome(tc) ? ' tool-result-exception' : ''}`}>{tc.result}</pre> : null}
      {toolOutcome(tc) === 'failed' && <p className="msg-error tool-failure-reason" role="status">{en ? 'Failed: ' : '执行失败：'}{toolFailureReason(tc, en)}</p>}
      {toolOutcome(tc) === 'canceled' && <p className="msg-error" role="status">{en ? 'This operation was canceled; completion was not confirmed.' : '本次操作已取消，未获得执行完成的确认。'}</p>}
    </details>
  );
}

/**
 * TodoWrite 工具专用渲染：任务清单卡片（参考「添加待办」风格）。
 * 直接展示每条任务的状态圆圈（待办/进行中/已完成），比 JSON 参数可读性高得多。
 */
function TodoWriteCard({ tc }: { tc: ToolCall }) {
  const t = useT();
  const todos: Array<{ content: string; status: string; activeForm?: string }> =
    Array.isArray(tc.input?.todos) ? tc.input.todos : [];
  if (todos.length === 0) return null;
  const doneCount = todos.filter((x) => x.status === 'completed').length;

  return (
    <div className="todo-card">
      <div className="todo-card-head">
        <ListChecks size={13} />
        <span className="todo-card-title">{t('chat.todo.title')}</span>
        <span className="todo-card-count muted small">{doneCount}/{todos.length}</span>
      </div>
      <ul className="todo-card-list">
        {todos.map((todo, i) => {
          const cls =
            todo.status === 'completed' ? 'done'
            : todo.status === 'in_progress' ? 'active'
            : 'pending';
          return (
            <li key={i} className={`todo-card-item ${cls}`}>
              {cls === 'done' ? <CheckCircle2 size={13} /> :
               cls === 'active' ? <Loader2 size={13} className="tool-spin" /> :
               <Circle size={13} />}
              <span className="todo-card-text">{todo.content}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ApprovalCard({ req }: { req: PendingApproval }) {
  const commandApproval = req.toolName.replace(/^mcp__sage__/, '') === 'Bash';
  const networkApproval = commandApproval && req.input?.network === true;
  const respond = useAppStore((s) => s.respondApproval);
  const conv = useAppStore((s) => s.currentConversation);
  const expertDefinitions = useAppStore((s) => s.settings?.expertDefinitions ?? {});
  const expertsEn = resolveLanguage(useAppStore((s) => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  const t = useT();
  // 审批卡片标题中的助手名与左下角后端引擎保持一致（sage / claude）
  const assistant = useBackendLabel();
  const toolName = displayToolName({ name: req.toolName, displayName: req.displayName });
  const title = req.title ?? t('chat.approvalTitle', { assistant, tool: toolName });
  const summary = useMemo(() => formatToolSummary({ id: '', name: req.toolName, input: req.input }), [req]);

  // 专家团模式：标记是哪个专家成员/任务在请求。
  // 同角色并行（Sam 和 Max 同时干活）时，审批请求不会混淆归属。
  const expertInfo = useMemo(() => {
    if (!conv || !req.msgId) return null;
    const msg = conv.messages.find((mm) => mm.id === req.msgId);
    if (!msg?.experts || msg.experts.kind !== 'task' || !msg.experts.role) return null;
    const em = resolveExpertMeta(msg.experts.role, expertDefinitions, expertsEn);
    const task = resolveExpertTask(conv.expertsPlan, msg);
    const memberName = msg.experts.expertName ?? task?.expertName ?? em.humanName;
    const parent = msg.experts.parentTaskId ? conv.expertsPlan?.tasks.find(t => t.id === msg.experts!.parentTaskId) : undefined;
    const name = parent ? `${parent.expertName ?? parent.title} › ${memberName}` : memberName;
    return { meta: em, role: em.name, name, taskTitle: task?.title };
  }, [conv, expertDefinitions, expertsEn, req.msgId]);

  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="approval-tag">{t('chat.approvalNeeded')}</span>
        <strong>{title}</strong>
      </div>
      {expertInfo ? (
        <div className="approval-expert">
          <ExpertGlyph meta={expertInfo.meta} size={12} />
          <span>{expertInfo.role} {expertInfo.name}</span>
          {expertInfo.taskTitle ? <span className="muted">· {expertInfo.taskTitle}</span> : null}
        </div>
      ) : null}
      <p className="muted small">{expertsEn ? 'You can also reply “allow” or “deny” for this one operation. With multiple requests, use the cards.' : '也可在对话中回复“允许”或“拒绝”处理本次操作；多项待确认时请使用对应卡片。'}</p>
      {req.description ? <div className="approval-desc muted small">{req.description}</div> : null}
      {networkApproval && Array.isArray(req.input.networkTargets) ? <p className="approval-desc muted small">目标：{req.input.networkTargets.map((x:any)=>`${x.host}:${x.port}`).join('、')}。仅这些目标的出站连接可用。请查看命令发送的数据与服务归属。</p> : null}
      {networkApproval && req.input.networkTargets===undefined ? <p className="msg-error" role="alert">联网目标范围缺失，不能批准。</p> : null}
      {commandApproval ? <div className="approval-desc muted small">{t(networkApproval ? 'chat.networkApprovalDesc' : 'chat.approvalDesc')}</div> : null}
      {commandApproval ? <pre className="approval-network-command" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{req.input.command}</pre> : null}
      <div className="approval-tool">
        <code title={req.toolName}>{toolName}</code>
        {summary ? <span className="muted small">— {summary}</span> : null}
      </div>
      {req.input ? (
        <details className="approval-details">
          <summary>{t('chat.viewParams')}</summary>
          <div className="muted small" style={{ overflowWrap: 'anywhere' }}>{expertsEn ? 'Tool identifier: ' : '工具标识：'}<code>{req.toolName}</code></div>
          <pre>{JSON.stringify(Object.fromEntries(Object.entries(req.input).filter(([key]) => !key.startsWith('__sage'))), null, 2)}</pre>
        </details>
      ) : null}
      <div className="approval-actions">
        <button
          className="btn-ghost"
          onClick={() => respond(req.requestId, 'deny')}
        >
          {t('chat.approval.deny')}
        </button>
        <button
          className="btn-ghost"
          onClick={() => respond(req.requestId, 'allow')}
        >
          {t(networkApproval ? 'chat.networkAllowOnce' : 'chat.approval.allowOnce')}
        </button>
      </div>
    </div>
  );
}

function displayToolName(tool: string | ToolDisplayIdentity): string {
  return toolDisplayName(tool, resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale));
}

function formatToolSummary(tc: { id: string; name: string; input?: any }): string {
  const inp = tc.input;
  if (!inp) return '';
  if (typeof inp.file_path === 'string') return inp.file_path;
  if (typeof inp.path === 'string') return inp.path;
  if (typeof inp.command === 'string') return inp.command.slice(0, 80);
  if (typeof inp.pattern === 'string') return inp.pattern;
  if (typeof inp.query === 'string') return inp.query;
  if (typeof inp.url === 'string') return inp.url;
  if (typeof inp.question === 'string') return inp.question.slice(0, 80);
  if (typeof inp.skill_name === 'string') return inp.skill_name;
  return '';
}

/** 每题独立编辑；一个多题工具请求统一提交一次，失败保留草稿。 */
type ClarifyDraft = {selected: string[]; text: string};
export function ClarifyBatchCard({ reqs }: { reqs: ClarifyRequest[] }) {
  const t = useT();
  const respond = useAppStore(s => s.respondClarify);
  const [answers, setAnswers] = useState<Record<string, ClarifyDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  useEffect(() => { setQuestionIndex(0); }, [reqs[0]?.requestId]);
  const questions = reqs.flatMap(req => (req.questions?.length ? req.questions : [{...req,id:'legacy'}]).map(q => ({...req,...q,key:`${req.requestId}:${q.id}`})));
  const answered = (key: string) => !!(answers[key]?.selected.length || answers[key]?.text.trim());
  const allAnswered = questions.length > 0 && questions.every(q => answered(q.key));
  const index = Math.min(questionIndex, Math.max(0, questions.length - 1));
  const current = questions[index];
  const cancel = async () => {
    if (submitting) return;
    setSubmitting(true);setError('');
    try { for (const req of reqs) await respond(req.requestId, '(澄清被取消: user canceled)'); }
    catch(e) {setError(String((e as Error).message));}
    finally {setSubmitting(false);}
  };
  const submitAll = async () => {
    if (submitting || !allAnswered) return;
    setSubmitting(true); setError('');
    try {
      for (const req of reqs) {
        const items = questions.filter(q => q.requestId === req.requestId).map(q => ({id:q.id,question:q.question,selected:answers[q.key].selected,text:answers[q.key].text.trim()}));
        const answer = req.questions?.length ? JSON.stringify({answers:items}) : [...items[0].selected,items[0].text].filter(Boolean).join('\n');
        await respond(req.requestId, answer);
      }
    } catch (e) {setError(String((e as Error).message));}
    finally {setSubmitting(false);}
  };
  const reason = [...new Set(reqs.map(req=>req.reason?.trim()).filter(Boolean))].join(' ');
  return <div className="clarify-section">
    <div className="clarify-intro">{reason && <span>{reason} </span>}有 {questions.length} 项需要你确认</div>
    <div className="clarify-card clarify-step-card">
    <div className="clarify-head"><div className="clarify-question clarify-current-title">{current?.question}</div><div className="clarify-pagination"><button type="button" aria-label={t('chat.clarify.previous')} disabled={submitting||index===0} onClick={()=>setQuestionIndex(index-1)}><ChevronUp size={14}/></button><span>{index+1} / {questions.length}</span><button type="button" aria-label={t('chat.clarify.next')} disabled={submitting||index>=questions.length-1} onClick={()=>setQuestionIndex(index+1)}><ChevronDown size={14}/></button></div></div>
    <fieldset disabled={submitting} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <div className="clarify-questions-list">{current&&<div key={current.key}><ClarifyQuestionItem req={current} answer={answers[current.key]??{selected:[],text:''}} onAnswer={answer=>setAnswers(prev=>({...prev,[current.key]:answer}))}/></div>}</div>
      {error&&<p role="alert">{error}</p>}
      <div className="clarify-actions"><button type="button" onClick={()=>void cancel()}>{t('chat.clarify.cancel')}</button><button className="btn-primary clarify-submit-btn" disabled={submitting||!current||!answered(current.key)||(index===questions.length-1&&!allAnswered)} onClick={()=>{if(index<questions.length-1)setQuestionIndex(index+1);else void submitAll();}}>{submitting?t('chat.clarify.submitting'):t(index<questions.length-1?'chat.clarify.next':'chat.clarify.submit')}</button></div>
    </fieldset>
  </div></div>;
}

/**
 * 单个澄清问题的回答组件（内嵌在 ClarifyBatchCard 中）
 */
function ClarifyQuestionItem({
  req,
  answer,
  onAnswer,
}: {
  req: ClarifyRequest;
  answer: ClarifyDraft;
  onAnswer: (answer: ClarifyDraft) => void;
}) {
  const options = req.options ?? [];
  const multi = !!req.multiSelect;
  const t = useT();
  const conv = useAppStore((s) => s.currentConversation);
  const expertDefinitions = useAppStore((s) => s.settings?.expertDefinitions ?? {});
  const expertsEn = resolveLanguage(useAppStore((s) => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';

  const selected = answer.selected;

  // 专家团模式：标记是哪个专家成员在提问
  const expertInfo = useMemo(() => {
    if (!conv || !req.msgId) return null;
    const msg = conv.messages.find((mm) => mm.id === req.msgId);
    if (!msg?.experts || msg.experts.kind !== 'task' || !msg.experts.role) return null;
    const em = resolveExpertMeta(msg.experts.role, expertDefinitions, expertsEn);
    const task = resolveExpertTask(conv.expertsPlan, msg);
    const memberName = msg.experts.expertName ?? task?.expertName ?? em.humanName;
    const parent = msg.experts.parentTaskId ? conv.expertsPlan?.tasks.find(t => t.id === msg.experts!.parentTaskId) : undefined;
    const name = parent ? `${parent.expertName ?? parent.title} › ${memberName}` : memberName;
    return { meta: em, role: em.name, name };
  }, [conv, expertDefinitions, expertsEn, req.msgId]);

  // 切换选项（多选）
  const toggle = (label: string) => {
    if (!multi) {
      // 单选：直接设置
      onAnswer({...answer,selected:[label]});
      return;
    }
    // 多选：切换
    const newSelected = selected.includes(label)
      ? selected.filter(l => l !== label)
      : [...selected, label];
    onAnswer({...answer,selected:newSelected});
  };

  // 自由文本输入
  const handleFreeText = (text: string) => {
    onAnswer({...answer,text});
  };


  return (
    <div className="clarify-question-item">
      {expertInfo ? (
        <span className="clarify-expert">
          <ExpertGlyph meta={expertInfo.meta} size={11} />
          {expertInfo.role} {expertInfo.name}
        </span>
      ) : null}
      <div className="clarify-mode">{clarificationMode(req)}{options.length > 0 ? ' · 也可以补充自己的答案' : ''}</div>
      {/* 选项 */}
      {options.length > 0 ? (
        <div className="clarify-options">
          {options.map((o, optionIndex) => {
            const active = selected.includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                className={`clarify-option${active ? ' active' : ''}`}
                aria-pressed={active}
                title={o.description}
                onClick={() => toggle(o.label)}
              >
                <span className="clarify-option-letter">{String.fromCharCode(65+optionIndex)}</span>
                <span className="clarify-option-label">{o.label}</span>
                {o.description ? <span className="clarify-option-desc muted small">{o.description}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {/* 自由输入 */}
      <div className="clarify-input-row">
        {options.length>0&&<span className="clarify-option-letter">{String.fromCharCode(65+options.length)}</span>}
        <textarea
          className="clarify-input"
          aria-label={t('chat.clarify.customPlaceholder')}
          rows={2}
          placeholder={options.length > 0 ? t('chat.askPhCustom') : t('chat.askPh')}
          value={answer.text}
          onChange={(e) => handleFreeText(e.target.value)}
          onClick={(e) => {
            // 确保点击 textarea 时不会被其他事件拦截
            e.stopPropagation();
          }}
          onMouseDown={(e) => {
            // 确保 mousedown 事件不会冒泡到父级导致失焦
            e.stopPropagation();
          }}
        />
      </div>
    </div>
  );
}

function splitClarifyQuestions(question: string): string[] {
  if (!question) return [];
  const numPrefix = String.raw`(?:\d+\u3001|\d+[.)\uff09]|\uff08\d+\uff09|\(\d+\)|[\u2460-\u2464])`;
  const splitter = new RegExp('\\n(?=' + numPrefix + ')');
  const stripper = new RegExp('^' + numPrefix + '\\s*');
  const parts = question
    .split(splitter)
    .map((s) => s.replace(stripper, '').trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [question.trim()];
}

// ── 入站消息 helper ──────────────────────────────────────────────────────────
// 剥离去站消息第一行的 "[来自 XX 的 YY]\n..." 前缀。
// Claude 看到的 user message 带此前缀以便感知来源，UI 已经用 header 卡片渲染了，
// 所以正文里再显示一次会重复。
function stripInboundPrefix(content: string): string {
  if (!content) return '';
  // 匹配形如 "[来自 XX 的 YY]" 的第一行
  const m = content.match(/^\[来自\s+[^\]]+\]\s*\n?/);
  if (m) return content.slice(m[0].length).trim();
  return content;
}

// 渠道类型 → 简短 emoji/图标名（避免引入一堆 icon）
function channelIcon(type: string): string {
  switch (type) {
    case 'wechat': return '💬';
    case 'dingtalk': return '🔔';
    case 'feishu':
    case 'feishu-webhook':
    case 'feishu-app': return '🐦';
    case 'email': return '✉️';
    default: return '📨';
  }
}

// ── 入站消息 toast ──────────────────────────────────────────────────────────
// 外部渠道消息到达时，在对话底部短暂显示（3s 后自动消失，点击可跳转）。
function InboundToast({ payload, onDismiss }: { payload: import('../../shared/types').InboundEventPayload; onDismiss: () => void }) {
  const t = useT();
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss, payload]);

  const sender = payload.message.senderName || payload.message.senderId || payload.channelName || t('chat.unknown');
  const statusText =
    payload.status === 'delivered' ? t('channels.inboundDelivered')
    : payload.status === 'no_binding' ? t('channels.inboundNoBinding')
    : t('channels.inboundError');

  return (
    <div className="inbound-toast" onClick={onDismiss} role="button">
      <span className="inbound-toast-icon">{channelIcon(payload.channelType ?? payload.message.channelType)}</span>
      <div className="inbound-toast-body">
        <div className="inbound-toast-title">
          {payload.channelName || t('chat.unknownChannel')} · {statusText}
        </div>
        <div className="inbound-toast-content">
          <span className="inbound-toast-sender">{sender}:</span> {payload.message.text.slice(0, 80)}{payload.message.text.length > 80 ? '…' : ''}
        </div>
      </div>
    </div>
  );
}
