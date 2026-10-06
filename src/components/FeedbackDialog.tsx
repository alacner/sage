import {WindowOverlay} from './WindowOverlay';
import {CornerRemoveButton} from './CornerRemoveButton';
import {ImageLightbox} from './ChatView';
/**
 * 反馈入口（标题栏最右）+ 提交反馈对话框
 *
 * 界面参考 Chrome/ChatGPT 反馈面板并结合 Sage 自身能力：
 *   - 反馈类型 chips（单选）
 *   - 详情与附件二选一（2000 字上限 + 计数），支持直接粘贴截图
 *   - 附件截图（可选，最多 5 张，单张 ≤20MB）
 *   - 上下文勾选：当前会话日志 / 系统信息 / 配置摘要（非敏感）
 *   - 联系邮箱（可选，localStorage 记忆）
 * 提交走主进程 ipc（拼装上下文 + x-sage-client 头）POST 到反馈服务器。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessagesSquare, Paperclip, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useServiceHealth, watchFeedbackService } from '../lib/service-health';
import { useT, translate } from '../i18n';

/** 反馈类型 i18n 键（提交时按当前语言翻译为可读文本上传）。 */
const FEEDBACK_TYPE_KEYS = [
  'fb.type.feature',
  'fb.type.perf',
  'fb.type.security',
  'fb.type.positive',
  'fb.type.suggestion',
  'fb.type.other',
];
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_MB = 20;
const MAX_DETAILS = 2000;
const EMAIL_KEY = 'sage.feedback.email';

interface Attachment {
  name: string;
  mime: string;
  /** base64（不含 data: 前缀），随提交上传 */
  data: string;
  /** 本地预览用 data url */
  preview: string;
  automatic?: boolean;
}

function screenshotAttachment(screenshot: string): Attachment {
  return { name: 'current-window.png', mime: 'image/png', data: screenshot.slice(screenshot.indexOf(',') + 1), preview: screenshot, automatic: true };
}

function readFileAsAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const data = url.slice(url.indexOf(',') + 1);
      resolve({ name: file.name || 'screenshot.png', mime: file.type || 'image/png', data, preview: url });
    };
    reader.onerror = () => reject(new Error(translate('fb.readFailed')));
    reader.readAsDataURL(file);
  });
}

export function FeedbackDialog({ open, onClose, screenshot, captureFailed = false, serviceAvailable }: { open: boolean; onClose: () => void; screenshot?: string; captureFailed?: boolean; serviceAvailable: boolean }) {
  const t = useT();
  const [type, setType] = useState(FEEDBACK_TYPE_KEYS[0]);
  const [details, setDetails] = useState('');
  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem(EMAIL_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [preview,setPreview]=useState<string|null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [incLog, setIncLog] = useState(true);
  const [incSys, setIncSys] = useState(true);
  const [incCfg, setIncCfg] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const attachmentLimitExceeded = attachments.length > MAX_ATTACHMENTS;
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setDone(false);
    setError(null);
    setAttachments(previous => {
      const manual = previous.filter(item => !item.automatic);
      return screenshot ? [screenshotAttachment(screenshot), ...manual] : manual;
    });
  }, [open, screenshot]);

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS - prev.length;
      if (room <= 0) {
        setError(translate('fb.maxAttachments', { n: MAX_ATTACHMENTS }));
        return prev;
      }
      const taken = images.slice(0, room);
      // 异步读取后并入；超限部分提示
      void Promise.all(
        taken.map(async (f) => {
          if (f.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
            setError(translate('fb.tooLarge', { name: f.name, mb: MAX_ATTACHMENT_MB }));
            return null;
          }
          try {
            return await readFileAsAttachment(f);
          } catch {
            return null;
          }
        }),
      ).then((list) => {
        const ok = list.filter((x): x is Attachment => !!x);
        if (ok.length > 0) {
          setAttachments((cur) => [...cur, ...ok].slice(0, MAX_ATTACHMENTS));
          setError(null);
        }
      });
      return prev;
    });
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items
        .filter((it) => it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const reset = useCallback(() => {
    setDetails('');
    setAttachments(screenshot ? [screenshotAttachment(screenshot)] : []);
    setError(null);
    setDone(false);
  }, [screenshot]);

  const handleSubmit = useCallback(async () => {
    // 详情与附件二选一：任一有内容即可提交
    if (!serviceAvailable || (!details.trim() && attachments.length === 0) || attachments.length > MAX_ATTACHMENTS || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // 会话摘要：当前对话标题 + 最近 20 条消息（截断长文本），由渲染层提供
      const conv = useAppStore.getState().currentConversation;
      const session = conv
        ? {
            projectPath: useAppStore.getState().currentProject?.path,
            conversationTitle: conv.title,
            recentMessages: conv.messages.slice(-20).map((m) => ({
              role: m.role,
              ts: m.ts,
              text: (m.content ?? '').slice(0, 400),
            })),
          }
        : undefined;
      const res = await window.api.submitFeedback({
        type: translate(type),
        details,
        email: email.trim() || undefined,
        attachments: attachments.map(({ name, mime, data }) => ({ name, mime, data })),
        includeSessionLog: incLog,
        includeSystemInfo: incSys,
        includeConfig: incCfg,
        session,
      });
      if (res?.ok) {
        if (email.trim()) {
          try {
            localStorage.setItem(EMAIL_KEY, email.trim());
          } catch {
            /* 忽略 */
          }
        }
        setDone(true);
        setDetails('');
        setAttachments([]);
      } else {
        setError(res?.error || translate('fb.submitFailed'));
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }, [serviceAvailable, details, submitting, type, email, attachments, incLog, incSys, incCfg]);

  if (!open) return null;

  return (
    <WindowOverlay className="fb-overlay" onEscape={onClose} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {preview&&<ImageLightbox src={preview} sources={attachments.map(a=>({src:a.preview,name:a.name}))} onClose={()=>setPreview(null)}/>}
      <div className="fb-dialog">
        <div className="fb-head">
          <span className="fb-title">{done ? t('fb.titleDone') : t('fb.titleSubmit')}</span>
          <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {done ? (
          <div className="fb-done">
            <div className="fb-done-text">{t('fb.doneText')}</div>
            <div className="fb-foot">
              <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
                {t('common.close')}
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  setDone(false);
                  reset();
                }}
              >
                {t('fb.again')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="fb-body">
              <div className="fb-label">{t('fb.typeLabel')}</div>
              <div className="fb-chips">
                {FEEDBACK_TYPE_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`fb-chip ${type === k ? 'active' : ''}`}
                    onClick={() => setType(k)}
                  >
                    {type === k ? '• ' : ''}
                    {t(k)}
                  </button>
                ))}
              </div>

              <div className="fb-label">
                {t('fb.detailLabel')} <span className="fb-req">{t('fb.detailOrAttachment')}</span>
              </div>
              <div className="fb-textarea-wrap">
                <textarea
                  className="fb-textarea"
                  placeholder={t('fb.detailPlaceholder')}
                  maxLength={MAX_DETAILS}
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  onPaste={handlePaste}
                />
                <span className="fb-count">
                  {details.length} / {MAX_DETAILS}
                </span>
              </div>

              <div className="fb-label">
                {t('fb.attachLabel')} <span className="fb-opt">{t('fb.attachHint', { n: MAX_ATTACHMENTS })}</span>
              </div>
              {attachments.some(item => item.automatic) && <p className="fb-opt" role="status">{t('fb.autoScreenshot')}</p>}
              {captureFailed && <p className="fb-error" role="status">{t('fb.captureFailed')}</p>}
              {!serviceAvailable && <p className="fb-error" role="status">{t('fb.serviceUnavailable')}</p>}
              <div className="fb-attach-row">
                <button type="button" className="btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
                  <Paperclip size={13} /> {t('fb.addScreenshot')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) void addFiles(files);
                    e.target.value = '';
                  }}
                />
                {attachments.map((a, i) => (
                  <span key={`${a.name}-${i}`} className="fb-thumb">
                    <button type="button" className="fb-thumb-preview" title={t('chat.imgZoomTitle')} aria-label={`${t('chat.imgZoomTitle')} ${a.name}`} onClick={()=>setPreview(a.preview)}><img src={a.preview} alt={a.name} /></button>
                    <CornerRemoveButton
                      className="fb-thumb-del"
                      title={t('fb.remove')}
                      onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                    />
                  </span>
                ))}
              </div>

              <input
                type="text"
                className="fb-email"
                placeholder={t('fb.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />

              <div className="fb-checks">
                <label className="fb-check">
                  <input type="checkbox" checked={incLog} onChange={(e) => setIncLog(e.target.checked)} />
                  {t('fb.includeLogs')}
                </label>
                <label className="fb-check">
                  <input type="checkbox" checked={incSys} onChange={(e) => setIncSys(e.target.checked)} />
                  {t('fb.includeSystem')}
                </label>
                <label className="fb-check">
                  <input type="checkbox" checked={incCfg} onChange={(e) => setIncCfg(e.target.checked)} />
                  {t('fb.includeConfig')}
                </label>
              </div>
            </div>

            <div className="fb-foot">
              {attachmentLimitExceeded || error ? <span className="fb-error">{attachmentLimitExceeded ? t('fb.maxAttachments', { n: MAX_ATTACHMENTS }) : error}</span> : <span />}
              <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="fb-submit"
                disabled={!serviceAvailable || (!details.trim() && attachments.length === 0) || attachmentLimitExceeded || submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? t('fb.submitting') : t('fb.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    </WindowOverlay>
  );
}

export function FeedbackEntry() {
  const [open, setOpen] = useState(false);
  const [screenshot, setScreenshot] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const [captureFailed, setCaptureFailed] = useState(false);
  const health = useServiceHealth();
  const settings = useAppStore(state => state.settings);
  const t = useT();
  useEffect(watchFeedbackService, [settings?.relayUrl, settings?.relayToken, settings?.relayEnabled]);
  const openFeedback = async () => {
    if (capturing) return;
    setCapturing(true);
    setCaptureFailed(false);
    try {
      setScreenshot(await window.api.captureFeedbackScreenshot());
    } catch {
      setScreenshot(undefined);
      setCaptureFailed(true);
    } finally {
      setCapturing(false);
      setOpen(true);
    }
  };
  const serviceAvailable = !!health.feedback?.ok;
  return (
    <>
      {serviceAvailable && (
        <div className="titlebar-right">
          <button type="button" className="titlebar-btn" title={t('fb.titleSubmit')} disabled={capturing} onClick={() => void openFeedback()}>
            <MessagesSquare size={14} />
          </button>
        </div>
      )}
      <FeedbackDialog screenshot={screenshot} captureFailed={captureFailed} open={open} serviceAvailable={serviceAvailable} onClose={() => setOpen(false)} />
    </>
  );
}
