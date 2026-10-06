import {WindowOverlay} from '../../../components/WindowOverlay';
import {RefreshButton} from '../../../components/RefreshButton';
import {PluginSlot} from '../../../components/plugins/PluginWorkbench';
/**
 * Browser Plugin — Main View
 *
 * Embedded Chrome browser using Electron's <webview> tag.
 * Supports URL navigation, history, and developer tools.
 *
 * Note: HTMLWebViewElement type definitions are minimal — we use `as any`
 * casts for the Electron-specific methods (loadURL, openDevTools, etc.)
 * because the standard lib.dom.d.ts doesn't include them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, RefreshCw, Home, ExternalLink, Wrench, MonitorSmartphone, Copy, X, Star, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { CursorMenu } from '../../../components/CursorMenu';
import { useT, translate } from '../../../i18n';
import { normalizeUrlInput } from '../url';
import {
  useBookmarks,
  addBookmark,
  updateBookmark,
  touchBookmarkFavicon,
  rememberFavicon,
  lookupFavicon,
  BookmarkDialog,
} from '../bookmarks';
import { recordPortVisit } from '../ports';
import { recordRecentVisit, DEFAULT_RECENT_LIMIT } from '../recent-visits';
import { copyMarkdown } from '../../../lib/clipboard';
import { parseHttpLink } from '../../../../shared/link-download';

interface Props {
  initialUrl?: string;
  compact?: boolean;
  interactionLocked?: boolean;
  viewport?: {width:number;height:number};
  /** 外部触发重新加载的计数器（tab 右键「重新加载」）；变化时 reload webview。 */
  reloadNonce?: number;
  /** 所属 tab id：站点标题/favicon 回传 store 更新 tab 栏展示。 */
  tabId?: string;
  /** 无痕标签页：webview 使用独立内存 partition（cookie/存储不持久、不与普通 tab 共享）。 */
  incognito?: boolean;
  toolbarTarget?: HTMLElement;
}

/** 设备规格（对齐 Chrome DevTools 设备工具栏：尺寸 + DPR + 移动端 UA）。 */
interface DeviceSpec {
  id: string;
  label: string;
  width: number;
  height: number;
  dpr?: number;
  /** 移动端设备：模拟时切换为移动 UA */
  mobile?: boolean;
  ua?: string;
  /** UA 类型（Chrome 表单的 Mobile/Desktop 选择） */
  uaType?: 'Mobile' | 'Desktop';
  /** User agent client hints（Sec-CH-UA 系列，经 CDP 应用到 webview） */
  hints?: ClientHints;
  /** 用户自定义设备（持久化于 localStorage） */
  custom?: boolean;
}

/** Chrome DevTools 自定义设备表单的 client hints 字段集。 */
interface ClientHints {
  /** User agent (Sec-CH-UA)：Brand + Significant version 列表 */
  brands: Array<{ brand: string; version: string }>;
  /** Full version list (Sec-CH-UA-Full-Version-List) */
  fullBrands: Array<{ brand: string; version: string }>;
  /** Full browser version (Sec-CH-UA-Full-Version) */
  fullVersion: string;
  /** Form Factors (Sec-CH-UA-Form-Factors) */
  formFactors: string[];
  platform: string;
  platformVersion: string;
  arch: string;
  model: string;
}

const FORM_FACTORS = ['Desktop', 'Mobile', 'XR', 'Watch', 'Automotive', 'Tablet', 'EInk'];

const emptyHints = (): ClientHints => ({
  brands: [],
  fullBrands: [],
  fullVersion: '',
  formFactors: [],
  platform: '',
  platformVersion: '',
  arch: '',
  model: '',
});

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 内置设备预设（取 Chrome DevTools Standard 列表的常用子集）。 */
const BUILTIN_DEVICES: DeviceSpec[] = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, dpr: 2, mobile: true, ua: UA_IPHONE },
  { id: 'iphone-xr', label: 'iPhone XR', width: 414, height: 896, dpr: 2, mobile: true, ua: UA_IPHONE },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', width: 390, height: 844, dpr: 3, mobile: true, ua: UA_IPHONE },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', width: 430, height: 932, dpr: 3, mobile: true, ua: UA_IPHONE },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915, dpr: 2.6, mobile: true, ua: UA_ANDROID },
  { id: 'galaxy-s8', label: 'Samsung Galaxy S8+', width: 360, height: 740, dpr: 3, mobile: true, ua: UA_ANDROID },
  { id: 'galaxy-s20-ultra', label: 'Samsung Galaxy S20 Ultra', width: 412, height: 915, dpr: 3.5, mobile: true, ua: UA_ANDROID },
  { id: 'galaxy-z-fold-5', label: 'Galaxy Z Fold 5', width: 344, height: 882, dpr: 3, mobile: true, ua: UA_ANDROID },
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024, dpr: 2, mobile: true, ua: UA_IPAD },
  { id: 'ipad-air', label: 'iPad Air', width: 820, height: 1180, dpr: 2, mobile: true, ua: UA_IPAD },
  { id: 'ipad-pro', label: 'iPad Pro', width: 1024, height: 1366, dpr: 2, mobile: true, ua: UA_IPAD },
  { id: 'surface-pro-7', label: 'Surface Pro 7', width: 912, height: 1368, dpr: 2 },
  { id: 'nest-hub', label: 'Nest Hub', width: 1024, height: 600, dpr: 2 },
];

const CUSTOM_DEVICES_KEY = 'sage.browser.customDevices';

function loadCustomDevices(): DeviceSpec[] {
  try {
    const raw = localStorage.getItem(CUSTOM_DEVICES_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((d) => d && typeof d.width === 'number' && typeof d.height === 'number');
  } catch {
    return [];
  }
}

function saveCustomDevices(list: DeviceSpec[]): void {
  try {
    localStorage.setItem(CUSTOM_DEVICES_KEY, JSON.stringify(list));
  } catch {
    /* 忽略配额/隐私模式异常 */
  }
}

// Electron's <webview> adds extra methods beyond standard HTMLWebViewElement.
type ElectronWebview = HTMLWebViewElement & {
  loadURL: (url: string) => Promise<void> | void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => Promise<void> | void;
  goForward: () => Promise<void> | void;
  reload: () => Promise<void> | void;
  openDevTools: () => void;
  inspectElement: (x: number, y: number) => void;
  addEventListener: (type: string, listener: (e: any) => void) => void;
  removeEventListener: (type: string, listener: (e: any) => void) => void;
};

/**
 * webview 导航类方法在被中断时会 reject ERR_ABORTED(-3)（如加载未完成就
 * reload / 重复 loadURL），属于正常中断而非错误；统一吞掉避免未捕获异常
 * 抛到控制台（GUEST_VIEW_MANAGER_CALL 报错即来源于此）。
 */
function safeWebViewCall(fn: () => unknown): void {
  try {
    const r = fn() as any;
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    /* 同步异常同样忽略：webview 未就绪等瞬态 */
  }
}

/**
 * 自定义设备表单（对齐 Chrome DevTools「Edit devices」全字段）：
 * Device（名称/宽/高/DPR）+ User agent string（+Mobile/Desktop）+
 * User agent client hints（Sec-CH-UA / Full-Version-List / Full-Version /
 * Form Factors / Platform / Architecture / Device model）。
 */
function CustomDeviceModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (spec: DeviceSpec) => void;
}) {
  const [name, setName] = useState('');
  const [width, setWidth] = useState('400');
  const [height, setHeight] = useState('700');
  const [dpr, setDpr] = useState('');
  const [uaString, setUaString] = useState('');
  const [uaType, setUaType] = useState<'Mobile' | 'Desktop'>('Mobile');
  const [hintsOpen, setHintsOpen] = useState(true);
  const [hints, setHints] = useState<ClientHints>(emptyHints);
  const t = useT();

  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  const valid = Number.isFinite(w) && Number.isFinite(h) && w >= 100 && h >= 100;

  const patchHints = (patch: Partial<ClientHints>) => setHints((cur) => ({ ...cur, ...patch }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const dprNum = Number(dpr);
    onAdd({
      id: `custom-${Date.now()}`,
      label: name.trim() || `${w}×${h}`,
      width: w,
      height: h,
      dpr: dprNum > 0 ? dprNum : undefined,
      mobile: uaType === 'Mobile' || hints.formFactors.includes('Mobile'),
      ua: uaString.trim() || (uaType === 'Mobile' ? UA_ANDROID : undefined),
      uaType,
      hints,
      custom: true,
    });
  };

  return (
    <WindowOverlay className="cdf-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="cdf-dialog" onSubmit={submit}>
        <div className="cdf-head">
          <span className="cdf-title">{t('browser.customDevice')}</span>
          <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="cdf-body">
          <div className="cdf-group">
            <div className="cdf-label">Device</div>
            <input type="text" placeholder="Device Name" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="cdf-row3">
              <input type="number" min={100} value={width} onChange={(e) => setWidth(e.target.value)} required />
              <input type="number" min={100} value={height} onChange={(e) => setHeight(e.target.value)} required />
              <input type="number" min={0.5} step={0.5} placeholder="Device pixel ratio" value={dpr} onChange={(e) => setDpr(e.target.value)} />
            </div>
          </div>

          <div className="cdf-group">
            <div className="cdf-label">User agent string</div>
            <div className="cdf-ua-row">
              <input type="text" placeholder="User agent string" value={uaString} onChange={(e) => setUaString(e.target.value)} />
              <select value={uaType} onChange={(e) => setUaType(e.target.value as 'Mobile' | 'Desktop')}>
                <option value="Mobile">Mobile</option>
                <option value="Desktop">Desktop</option>
              </select>
            </div>
          </div>

          <div className="cdf-group">
            <button type="button" className="cdf-collapse" onClick={() => setHintsOpen((v) => !v)}>
              {hintsOpen ? '▾' : '▸'} User agent client hints
            </button>
            {hintsOpen ? (
              <>
                <div className="cdf-label">User agent (Sec-CH-UA)</div>
                {hints.brands.map((b, i) => (
                  <div key={`b${i}`} className="cdf-brand-row">
                    <input
                      placeholder="Brand"
                      value={b.brand}
                      onChange={(e) =>
                        patchHints({ brands: hints.brands.map((x, j) => (j === i ? { ...x, brand: e.target.value } : x)) })
                      }
                    />
                    <input
                      placeholder="Significant version (e.g. 87)"
                      value={b.version}
                      onChange={(e) =>
                        patchHints({ brands: hints.brands.map((x, j) => (j === i ? { ...x, version: e.target.value } : x)) })
                      }
                    />
                    <button type="button" className="bdm-del" title={t('common.delete')} onClick={() => patchHints({ brands: hints.brands.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="cdf-addlink" onClick={() => patchHints({ brands: [...hints.brands, { brand: '', version: '' }] })}>
                  + Add Brand
                </button>

                <div className="cdf-label">Full version list (Sec-CH-UA-Full-Version-List)</div>
                {hints.fullBrands.map((b, i) => (
                  <div key={`f${i}`} className="cdf-brand-row">
                    <input
                      placeholder="Brand"
                      value={b.brand}
                      onChange={(e) =>
                        patchHints({ fullBrands: hints.fullBrands.map((x, j) => (j === i ? { ...x, brand: e.target.value } : x)) })
                      }
                    />
                    <input
                      placeholder="Version (e.g. 87.0.4280.88)"
                      value={b.version}
                      onChange={(e) =>
                        patchHints({ fullBrands: hints.fullBrands.map((x, j) => (j === i ? { ...x, version: e.target.value } : x)) })
                      }
                    />
                    <button type="button" className="bdm-del" title={t('common.delete')} onClick={() => patchHints({ fullBrands: hints.fullBrands.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="cdf-addlink" onClick={() => patchHints({ fullBrands: [...hints.fullBrands, { brand: '', version: '' }] })}>
                  + Add Brand
                </button>

                <div className="cdf-label">Full browser version (Sec-CH-UA-Full-Version)</div>
                <input
                  type="text"
                  placeholder="Full browser version (e.g. 87.0.4280.88)"
                  value={hints.fullVersion}
                  onChange={(e) => patchHints({ fullVersion: e.target.value })}
                />

                <div className="cdf-label">Form Factors (Sec-CH-UA-Form-Factors)</div>
                <div className="cdf-factors">
                  {FORM_FACTORS.map((f) => (
                    <label key={f} className="bdm-form-check">
                      <input
                        type="checkbox"
                        checked={hints.formFactors.includes(f)}
                        onChange={(e) =>
                          patchHints({
                            formFactors: e.target.checked
                              ? [...hints.formFactors, f]
                              : hints.formFactors.filter((x) => x !== f),
                          })
                        }
                      />
                      {f}
                    </label>
                  ))}
                </div>

                <div className="cdf-label">Platform (Sec-CH-UA-Platform / Sec-CH-UA-Platform-Version)</div>
                <div className="cdf-row2">
                  <input placeholder="Platform (e.g. Android)" value={hints.platform} onChange={(e) => patchHints({ platform: e.target.value })} />
                  <input placeholder="Platform version" value={hints.platformVersion} onChange={(e) => patchHints({ platformVersion: e.target.value })} />
                </div>

                <div className="cdf-label">Architecture (Sec-CH-UA-Arch)</div>
                <input type="text" placeholder="Architecture (e.g. x86)" value={hints.arch} onChange={(e) => patchHints({ arch: e.target.value })} />

                <div className="cdf-label">Device model (Sec-CH-UA-Model)</div>
                <input type="text" placeholder="Device model (Sec-CH-UA-Model)" value={hints.model} onChange={(e) => patchHints({ model: e.target.value })} />
              </>
            ) : null}
          </div>
        </div>
        <div className="cdf-foot">
          <button type="button" className="bdm-cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="bdm-add" disabled={!valid}>
            {t('common.add')}
          </button>
        </div>
      </form>
    </WindowOverlay>
  );
}

export function BrowserView({ initialUrl, reloadNonce, tabId, incognito, compact = false, viewport, interactionLocked = false, toolbarTarget }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [previewSize, setPreviewSize] = useState({width: 640, height: 360});
  useEffect(() => {
    const element = contentRef.current;
    if (!element || (!compact && !viewport)) return;
    const observer = new ResizeObserver(([entry]) => setPreviewSize({width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height)}));
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact, viewport?.width, viewport?.height]);
  const previewWidth = viewport?.width ?? 1280;
  const previewScale = Math.min(1, previewSize.width / previewWidth, viewport ? previewSize.height / viewport.height : 1);
  const webviewRef = useRef<ElectronWebview | null>(null);
  // 初始 src：Electron 31 的 <webview> 无 src 时 guest 永不 attach（loadURL 直接
  // 抛 "must be attached to the DOM..."），首导航必须经 src 属性触发。
  // 新建标签页 = 空白页（about:blank），不再内置默认站点。
  const [initialSrc] = useState(() => normalizeUrlInput(initialUrl || ''));
  const [url, setUrl] = useState(initialSrc);
  const [inputUrl, setInputUrl] = useState(initialSrc);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [title, setTitle] = useState('');
  // 当前页 favicon（page-favicon-updated 回传）：收藏按钮弹窗默认名 / 收藏图标回写用
  const [favicon, setFavicon] = useState<string | undefined>(undefined);
  // 收藏命名弹窗（工具栏星标按钮触发；只改名称，图标固定取网站 favicon）
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false);
  // 设备模拟：null = 自适应；否则 webview 固定为规格尺寸居中展示
  const [device, setDevice] = useState<DeviceSpec | null>(null);
  useEffect(() => { if (viewport) setDevice(null); }, [viewport?.width, viewport?.height]);
  // 最后访问记录（项目维度）：上限读插件配置 browser.recentVisitLimit（默认 100）
  const recordVisit = (url: string, title: string) => {
    const s = useAppStore.getState();
    const project = s.currentProject?.path;
    if (!project) return;
    const limit = Number(s.settings?.pluginSettings?.browser?.recentVisitLimit) || DEFAULT_RECENT_LIMIT;
    recordRecentVisit(project, { url, title, favicon: lookupFavicon(url) }, limit);
  };
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  // 自定义设备（localStorage 持久化）；新建走独立弹窗表单（对齐 Chrome 全字段）
  const [customDevices, setCustomDevices] = useState<DeviceSpec[]>(() => loadCustomDevices());
  const [customFormOpen, setCustomFormOpen] = useState(false);
  // 加载失败提示（did-fail-load）：展示错误码 + 重试入口，避免白屏无反馈
  const [loadError, setLoadError] = useState<string | null>(null);
  // 证书风险中止页（did-fail-load 携带证书错误码）：像其他浏览器一样告警，用户同意风险后可继续
  const [certError, setCertError] = useState<{ url: string; code: number } | null>(null);
  // 挂载看门狗：webview 超时未 attach（无任何加载事件）时的静默白屏回收口
  const [attachStale, setAttachStale] = useState(false);
  // webview 节点重建计数（key 变化强制重新挂载 guest）
  const [wvKey, setWvKey] = useState(0);
  const startedRef = useRef(false);
  const targetUrlRef = useRef(initialSrc);
  // 当前 url 的 ref 镜像：webview 事件回调（effect 不依赖 url state）读取最新值
  const urlRef = useRef(initialSrc);
  urlRef.current = url;
  const defaultUaRef = useRef<string | null>(null);
  // guest 就绪（dom-ready）标记：此前 loadURL 必抛错，导航请求排队到 dom-ready 回放
  const readyRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  // dom-ready 计数：guest 就绪后重放设备模拟（UA / client hints 依赖 webContentsId）
  const [readyTick, setReadyTick] = useState(0);
  // 页内右键菜单（webview 'context-menu' 事件）
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    px: number;
    py: number;
    linkURL?: string;
    selectionText?: string;
  } | null>(null);
  const t = useT();

  useAppStore((s) => s.currentProject);

  // Normalize URL (add https:// if missing)
  const normalizeUrl = useCallback((input: string) => normalizeUrlInput(input), []);

  const navigate = useCallback((targetUrl: string) => {
    const normalized = normalizeUrl(targetUrl);
    targetUrlRef.current = normalized;
    setLoadError(null);
    setCertError(null);
    setUrl(normalized);
    setInputUrl(normalized);
    const wv = webviewRef.current;
    // guest 尚未开始任何加载（未 attach）时 loadURL 必抛错：排队到 dom-ready 回放；
    // 但只要已开始过加载（did-start-loading 触发，含证书失败/中断的加载）guest 就已
    // attach，可直接 loadURL——否则证书中止后 dom-ready 永不触发，「接受风险继续」
    // 与地址栏重试会永远排在 pendingUrlRef 里失效。
    if (!wv || (!readyRef.current && !startedRef.current)) {
      pendingUrlRef.current = normalized;
      return;
    }
    safeWebViewCall(() => wv.loadURL(normalized));
  }, [normalizeUrl]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(inputUrl);
  };

  const handleBack = () => {
    const wv = webviewRef.current;
    if (wv && (wv as any).canGoBack()) {
      safeWebViewCall(() => wv.goBack());
    }
  };

  const handleForward = () => {
    const wv = webviewRef.current;
    if (wv && (wv as any).canGoForward()) {
      safeWebViewCall(() => wv.goForward());
    }
  };

  const handleRefresh = () => {
    const wv = webviewRef.current;
    if (wv) safeWebViewCall(() => wv.reload());
  };

  const handleHome = () => {
    // 主页 = 空白页（与新建标签页一致）
    navigate('about:blank');
  };

  // 接受证书风险：批准该 origin（主进程加入放行集）后重新导航
  const approveCertRisk = async () => {
    if (!certError) return;
    const target = certError.url;
    let origin = '';
    try { origin = new URL(target).origin; } catch { /* 忽略非法 URL */ }
    if (origin) { try { await window.api.browserCertApprove(origin); } catch { /* 忽略 */ } }
    setCertError(null);
    navigate(target);
  };

  const ignoreCertificateErrors = useAppStore(s => s.settings?.pluginSettings?.browser?.ignoreCertErrors === true);
  const ignoreLocalCertificateErrors=useAppStore(s=>s.settings?.pluginSettings?.browser?.ignoreLocalCertErrors!==false);
  useEffect(() => {
    if ((ignoreCertificateErrors || ignoreLocalCertificateErrors) && certError) navigate(certError.url);
  }, [ignoreCertificateErrors,ignoreLocalCertificateErrors]);

  const handleOpenExternal = () => {
    if (url) {
      void window.api.openExternal(url);
    }
  };

  const handleOpenContextLinkExternal = async () => {
    const target = ctxMenu?.linkURL;
    setCtxMenu(null);
    if (!target || !parseHttpLink(target)) return;
    try {
      await window.api.openExternal(target);
    } catch {
      useAppStore.getState().setBanner(translate('linkMenu.openFailed'));
    }
  };

  const handleOpenDevTools = () => {
    const wv = webviewRef.current;
    // guest 未 attach 时 openDevTools 会抛错，静默忽略
    if (wv) {
      try {
        (wv as any).openDevTools();
      } catch {
        /* 忽略 */
      }
    }
  };

  // Webview event handlers
  useEffect(() => {
    const wv = webviewRef.current as any;
    if (!wv) return;

    const handleDidStartLoading = () => {
      startedRef.current = true;
      setAttachStale(false);
      setIsLoading(true);
      setLoadError(null);
      setCertError(null);
    };

    const handleDidStopLoading = () => {
      setIsLoading(false);
      // guest 就绪后记录默认 UA（设备模拟关闭时恢复用）
      if (defaultUaRef.current == null) {
        try {
          defaultUaRef.current = (wv as any).getUserAgent?.() || null;
        } catch {
          /* 忽略 */
        }
      }
    };

    // guest 就绪：回放就绪前排队的导航（如挂载瞬间的地址栏提交），
    // 并触发设备模拟重放（UA / client hints 依赖已 attach 的 webContentsId）
    const handleDomReady = () => {
      const project=useAppStore.getState().currentProject?.path;
      if(project)void window.api.plugins('browser-register',{project,id:wv.getWebContentsId(),tabId}).catch(e=>console.warn('[browser] registration failed',e));
      startedRef.current = true;
      setAttachStale(false);
      readyRef.current = true;
      setReadyTick((n) => n + 1);
      const pending = pendingUrlRef.current;
      pendingUrlRef.current = null;
      if (!pending) return;
      let current = '';
      try {
        current = wv.getURL();
      } catch {
        /* 忽略 */
      }
      if (pending !== current) safeWebViewCall(() => wv.loadURL(pending));
    };

    const handleDidFailLoad = (e: any) => {
      // -3 ERR_ABORTED 属正常中断（被新导航取代），不算失败
      if (e?.errorCode === -3) return;
      setIsLoading(false);
      const code = e?.errorCode;
      // Chromium 证书错误码区间（-200..-213）：弹出风险告警中止页，由用户决定是否继续
      if (typeof code === 'number' && code <= -200 && code >= -213) {
        setLoadError(null);
        setCertError({ url: e?.validatedURL || urlRef.current, code });
        return;
      }
      setCertError(null);
      setLoadError(translate('browser.loadFailedWithCode', { desc: e?.errorDescription || translate('browser.loadFailed'), code: code ?? '?' }));
    };

    const handleDidNavigate = (e: any) => {
      setUrl(e.url);
      setInputUrl(e.url);
      setCanGoBack(wv.canGoBack?.() ?? false);
      setCanGoForward(wv.canGoForward?.() ?? false);
      // 本机端口访问统计（侧边栏「常用本机端口」排序依据）
      recordPortVisit(e.url);
      // 最后访问记录（项目维度）：先占位（标题事件到达后补全）
      recordVisit(e.url, '');
    };

    const handlePageTitleUpdated = (e: any) => {
      setTitle(e.title);
      // 站点标题同步到 tab 栏（替换打开时的主机名占位标题）
      if (tabId && e.title) {
        useAppStore.getState().updateBrowserTabMeta(tabId, { title: e.title });
      }
      // 最后访问记录（项目维度）：标题回传时补全标题与图标
      recordVisit(urlRef.current, e.title);
    };

    const handlePageFaviconUpdated = (e: any) => {
      const favicon = Array.isArray(e.favicons) ? e.favicons[0] : undefined;
      if (!favicon) return;
      setFavicon(favicon);
      if (tabId) {
        useAppStore.getState().updateBrowserTabMeta(tabId, { favicon });
      }
      // 域名图标缓存：侧边栏添加/编辑收藏时立即命中（打开过的域名图标同步）
      rememberFavicon(urlRef.current, favicon);
      // 重新进入站点时若网站图标已更新，同步刷新对应收藏的图标
      touchBookmarkFavicon(urlRef.current, favicon);
    };

    // 页内右键：webview 'context-menu' 事件携带坐标与链接/选区信息
    const handleContextMenu = (e: any) => {
      e.preventDefault?.();
      const rect = (wv as HTMLElement).getBoundingClientRect();
      const p = e.params ?? {};
      setCtxMenu({
        x: rect.left + (p.x ?? 0) * rect.width / (wv.offsetWidth || rect.width),
        y: rect.top + (p.y ?? 0) * rect.height / (wv.offsetHeight || rect.height),
        px: p.x ?? 0,
        py: p.y ?? 0,
        linkURL: p.linkURL || undefined,
        selectionText: p.selectionText || undefined,
      });
    };

    wv.addEventListener('did-start-loading', handleDidStartLoading);
    wv.addEventListener('did-stop-loading', handleDidStopLoading);
    wv.addEventListener('dom-ready', handleDomReady);
    wv.addEventListener('did-fail-load', handleDidFailLoad);
    wv.addEventListener('did-navigate', handleDidNavigate);
    wv.addEventListener('page-title-updated', handlePageTitleUpdated);
    wv.addEventListener('page-favicon-updated', handlePageFaviconUpdated);
    wv.addEventListener('context-menu', handleContextMenu);

    // 初始加载由 src 属性触发（Electron 31 无 src 的 webview 永不 attach，
    // loadURL 会抛 "must be attached to the DOM..."）；此处仅复位就绪态，
    // 后续导航走 navigate（未就绪时排队，dom-ready 回放）。
    readyRef.current = false;
    pendingUrlRef.current = null;
    startedRef.current = false;
    setAttachStale(false);

    return () => {
      wv.removeEventListener('did-start-loading', handleDidStartLoading);
      wv.removeEventListener('did-stop-loading', handleDidStopLoading);
      wv.removeEventListener('dom-ready', handleDomReady);
      wv.removeEventListener('did-fail-load', handleDidFailLoad);
      wv.removeEventListener('did-navigate', handleDidNavigate);
      wv.removeEventListener('page-title-updated', handlePageTitleUpdated);
      wv.removeEventListener('page-favicon-updated', handlePageFaviconUpdated);
      wv.removeEventListener('context-menu', handleContextMenu);
    };
  }, [initialUrl, tabId, wvKey]);

  // 挂载看门狗：6s 内无任何加载事件 = guest 未 attach（静默白屏），给出重建入口
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!startedRef.current && !readyRef.current) {
        console.error('[browser] webview attach 超时：6s 内无 did-start-loading / dom-ready 事件');
        setAttachStale(true);
      }
    }, 6000);
    return () => clearTimeout(timer);
  }, [wvKey, initialSrc]);

  /** 重建 webview 节点：guest 未 attach 时的恢复手段（key 变化强制重新挂载）。 */
  const rebuildWebview = () => {
    setAttachStale(false);
    setLoadError(null);
    readyRef.current = false;
    pendingUrlRef.current = null;
    startedRef.current = false;
    setWvKey((k) => k + 1);
  };

  // 外部重新加载信号（tab 右键「重新加载」）：nonce 变化时 reload webview
  useEffect(() => {
    if (reloadNonce && readyRef.current) safeWebViewCall(() => webviewRef.current?.reload());
  }, [reloadNonce]);

  // 设备模拟：同步切换 UA（移动设备用移动 UA，关闭时恢复默认）；
  // 运行时不支持 setUserAgent 则静默降级——尺寸模拟仍然生效。
  useEffect(() => {
    const wv = webviewRef.current as any;
    if (!wv || typeof wv.setUserAgent !== 'function') return;
    try {
      if (device?.ua) wv.setUserAgent(device.ua);
      else if (defaultUaRef.current) wv.setUserAgent(defaultUaRef.current);
    } catch {
      /* 忽略 */
    }
  }, [device, readyTick]);

  // Client hints（Sec-CH-UA 系列）经主进程 CDP Emulation.setUserAgentOverride
  // 应用到 webview guest；无设备时清除覆盖。失败静默降级（UA 串已由 setUserAgent 覆盖）。
  useEffect(() => {
    const wv = webviewRef.current as any;
    // guest 未 attach 时 getWebContentsId 必抛错（"must be attached to the DOM..."）：
    // 跳过本次，dom-ready 后 readyTick 变化会重放本 effect
    if (!wv || !readyRef.current || typeof wv.getWebContentsId !== 'function') return;
    let id: number | undefined;
    try {
      id = wv.getWebContentsId();
    } catch {
      return;
    }
    if (!id) return;
    if (!device) {
      void window.api.applyWebviewEmulation?.(id, null);
      return;
    }
    const h = device.hints;
    const metadata =
      h || device.mobile
        ? {
            mobile: !!device.mobile,
            platform: h?.platform?.trim() || (device.mobile ? 'Android' : undefined),
            platformVersion: h?.platformVersion?.trim() || undefined,
            architecture: h?.arch?.trim() || undefined,
            model: h?.model?.trim() || undefined,
            brands: (h?.brands || [])
              .filter((b) => b.brand.trim())
              .map((b) => ({ brand: b.brand.trim(), version: b.version.trim() || '1' })),
            fullVersionList: (h?.fullBrands || [])
              .filter((b) => b.brand.trim())
              .map((b) => ({ brand: b.brand.trim(), version: b.version.trim() || '1.0.0.0' })),
          }
        : undefined;
    void window.api.applyWebviewEmulation?.(id, { userAgent: device.ua, metadata });
  }, [device, readyTick]);

  const addCustomDevice = (spec: DeviceSpec) => {
    const next = [...customDevices, spec];
    setCustomDevices(next);
    saveCustomDevices(next);
    setDevice(spec);
    setCustomFormOpen(false);
    setDeviceMenuOpen(false);
  };

  const removeCustomDevice = (id: string) => {
    const next = customDevices.filter((d) => d.id !== id);
    setCustomDevices(next);
    saveCustomDevices(next);
    if (device?.id === id) setDevice(null);
  };

  // ── 收藏（工具栏星标按钮）──
  const bookmarks = useBookmarks();
  // 空白页/about: 页不可收藏
  const bookmarkable = !!url && !url.startsWith('about:');
  const existingBookmark = bookmarkable ? bookmarks.find((b) => b.url === url) : undefined;
  const handleSaveBookmark = ({ name }: { url: string; name: string }) => {
    if (existingBookmark) updateBookmark(existingBookmark.id, { name });
    else addBookmark({ url, name, favicon });
    setBookmarkDialogOpen(false);
  };
  const defaultBookmarkName =
    title ||
    (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();

  useEffect(() => {
    const guest=webviewRef.current;
    if(!interactionLocked||!guest)return;
    // The host shield blocks pointer input; release guest focus to block residual typing.
    const blur=()=>{guest.blur();if(document.activeElement===guest)(guest.closest('.browser-preview-content')?.querySelector('[data-agent-input-shield]') as HTMLElement|null)?.focus();};blur();guest.addEventListener('focus',blur);
    setCtxMenu(null);setDeviceMenuOpen(false);setCustomFormOpen(false);setBookmarkDialogOpen(false);
    return()=>guest.removeEventListener('focus',blur);
  },[interactionLocked,wvKey,readyTick]);

  const browserToolbar = (
      <div className="browser-toolbar">
        <PluginSlot slot="browser.toolbar"/>
        <div className="browser-nav-buttons">
          <button
            className="icon-btn"
            onClick={handleBack}
            disabled={!canGoBack}
            title={t('browser.back')}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={handleForward}
            disabled={!canGoForward}
            title={t('browser.forward')}
          >
            <ArrowRight size={16} />
          </button>
          <RefreshButton
            className="icon-btn"
            onClick={handleRefresh}
            title={t('browser.refresh')}
           loading={isLoading}/>
          <button
            className="icon-btn"
            onClick={handleHome}
            title={t('browser.home')}
          >
            <Home size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="browser-url-bar">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onFocus={() => { if (inputUrl === 'about:blank') setInputUrl(''); }}
            onBlur={() => { if (!inputUrl.trim()) setInputUrl(url || 'about:blank'); }}
            placeholder={t('browser.urlPlaceholder')}
            className="browser-url-input"
          />
          {/* 收藏按钮：URL 栏内右侧；已收藏时实心星标，点击均可改名 */}
          <button
            type="button"
            className={`browser-star-btn${existingBookmark ? ' starred' : ''}`}
            onClick={() => setBookmarkDialogOpen(true)}
            disabled={!bookmarkable}
            title={existingBookmark ? t('browser.bookmarkPage') : t('browser.bookmarkAdd')}
          >
            <Star size={15} fill={existingBookmark ? 'currentColor' : 'none'} />
          </button>
        </form>

        <div className="browser-action-buttons">
          <button
            className="icon-btn"
            onClick={handleOpenDevTools}
            title={t('browser.devTools')}
          >
            <Wrench size={16} />
          </button>
          <div className="browser-device-wrap">
            <button
              className={`icon-btn ${device ? 'active' : ''}`}
              onClick={() => setDeviceMenuOpen((v) => !v)}
              title={t('browser.deviceEmulation')}
            >
              <MonitorSmartphone size={16} />
            </button>
            {deviceMenuOpen ? (
              <>
                <div className="browser-device-backdrop" onClick={() => setDeviceMenuOpen(false)} />
                <div className="browser-device-menu">
                  <button
                    className={`ftcm-item ${!device ? 'active' : ''}`}
                    onClick={() => {
                      setDevice(null);
                      setDeviceMenuOpen(false);
                    }}
                  >
                    {t('browser.adaptive')}
                  </button>
                  <div className="bdm-section">{t('browser.builtInDevices')}</div>
                  {BUILTIN_DEVICES.map((p) => (
                    <button
                      key={p.id}
                      className={`ftcm-item ${device?.id === p.id ? 'active' : ''}`}
                      onClick={() => {
                        setDevice(p);
                        setDeviceMenuOpen(false);
                      }}
                    >
                      {p.label}
                      <span className="muted small">{p.width}×{p.height}</span>
                    </button>
                  ))}
                  <div className="bdm-section">{t('browser.customDevices')}</div>
                  {customDevices.map((p) => (
                    <div key={p.id} className="bdm-row">
                      <button
                        className={`ftcm-item ${device?.id === p.id ? 'active' : ''}`}
                        onClick={() => {
                          setDevice(p);
                          setDeviceMenuOpen(false);
                        }}
                      >
                        {p.label}
                        <span className="muted small">{p.width}×{p.height}</span>
                      </button>
                      <button
                        className="bdm-del"
                        title={t('browser.deleteDevice')}
                        onClick={() => removeCustomDevice(p.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="ftcm-item"
                    onClick={() => {
                      setDeviceMenuOpen(false);
                      setCustomFormOpen(true);
                    }}
                  >
                    {t('browser.addCustomDevice')}
                  </button>
                </div>
              </>
            ) : null}
          </div>
          <button
            className="icon-btn"
            onClick={handleOpenExternal}
            title={t('browser.openExternal')}
          >
            <ExternalLink size={16} />
          </button>
        </div>
      </div>
  );

  return (
    <div className="browser-view">
      {toolbarTarget ? createPortal(browserToolbar, toolbarTarget) : browserToolbar}

      <div className="browser-content" ref={contentRef}>
        {/*
          Electron's <webview> tag. TypeScript lib.dom.d.ts doesn't know about
          Electron-specific methods, so we cast the ref to ElectronWebview above.
          初始导航必须走 src 属性：Electron 31 中无 src 的 webview 永不 attach，
          之后任何 loadURL 都抛 "must be attached to the DOM..."（白屏根因）。
          src 只在挂载时取 initialSrc（常量），后续导航走 loadURL，不会因
          re-render 改 src 触发意外跳转。设备模拟仅改内联尺寸（同一 DOM 节点，
          重挂载会丢失页面状态）。
        */}
        <webview
          key={wvKey}
          tabIndex={interactionLocked?-1:0}
          ref={webviewRef as any}
          src={initialSrc}
          className={`browser-webview${device ? ' device-mode' : ''}`}
          style={
            device
              ? {
                  width: `${device.width}px`,
                  height: `min(${device.height}px, calc(100% - 24px))`,
                  left: '50%',
                  top: '12px',
                  transform: 'translateX(-50%)',
                }
              : compact || viewport ? {width: `${previewWidth}px`, height: `${viewport?.height ?? previewSize.height / previewScale}px`, transform: `scale(${previewScale})`, transformOrigin: 'top left', left: Math.max(0, (previewSize.width - previewWidth * previewScale) / 2)} : undefined
          }
          // @ts-ignore - Electron-specific attributes not in lib.dom.d.ts
          nodeintegration="false"
          webpreferences="contextIsolation=true,plugins=true"
          partition={incognito ? 'sage-incognito' : undefined}
        />
        {certError ? (
          <div className="browser-load-error browser-cert-warning">
            <div className="browser-cert-icon"><AlertTriangle size={30} /></div>
            <div className="browser-load-error-title">{t('browser.certRiskTitle')}</div>
            <div className="browser-load-error-desc">{t('browser.certRiskDesc')}</div>
            <div className="browser-load-error-url">{certError.url}</div>
            <div className="browser-cert-actions">
              <button className="bdm-add" onClick={() => void approveCertRisk()}>{t('browser.certProceed')}</button>
              <button className="browser-cert-back" onClick={() => { setCertError(null); navigate('about:blank'); }}>{t('browser.certBack')}</button>
            </div>
          </div>
        ) : null}
        {loadError ? (
          <div className="browser-load-error">
            <div className="browser-load-error-title">{t('browser.loadFailed')}</div>
            <div className="browser-load-error-desc">{loadError}</div>
            <div className="browser-load-error-url">{url}</div>
            <button className="bdm-add" onClick={() => navigate(url)}>{t('common.retry')}</button>
          </div>
        ) : null}
        {attachStale ? (
          <div className="browser-load-error">
            <div className="browser-load-error-title">{t('browser.attachStale')}</div>
            <div className="browser-load-error-desc">
              {t('browser.attachStaleDesc')}
            </div>
            <div className="browser-load-error-url">{url}</div>
            <button className="bdm-add" onClick={rebuildWebview}>{t('browser.rebuild')}</button>
          </div>
        ) : null}
      </div>

      {title && (
        <div className="browser-status-bar">
          <span className="browser-title">{title}</span>
        </div>
      )}

      {/* 页内右键菜单（Portal 到 body，避免被 browser-view 的 overflow 裁剪） */}
      {ctxMenu
        ? createPortal(
            <>
              <div
                className="browser-ctx-backdrop"
                onClick={() => setCtxMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu(null);
                }}
              />
              {/* 菜单本体走 CursorMenu（自带 Portal），只负责“放不下就翻向上方” */}
              <CursorMenu
                className="file-tab-context-menu"
                x={ctxMenu.x}
                y={ctxMenu.y}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  className="ftcm-item"
                  disabled={!canGoBack}
                  onClick={() => {
                    handleBack();
                    setCtxMenu(null);
                  }}
                >
                  <ArrowLeft size={14} /> {t('browser.back')}
                </button>
                <button
                  className="ftcm-item"
                  disabled={!canGoForward}
                  onClick={() => {
                    handleForward();
                    setCtxMenu(null);
                  }}
                >
                  <ArrowRight size={14} /> {t('browser.forward')}
                </button>
                <button
                  className="ftcm-item"
                  onClick={() => {
                    handleRefresh();
                    setCtxMenu(null);
                  }}
                >
                  <RefreshCw size={14} /> {t('browser.refresh')}
                </button>
                {ctxMenu.linkURL || ctxMenu.selectionText ? <div className="ftcm-sep" /> : null}
                {ctxMenu.linkURL ? (
                  <>
                    <button
                      className="ftcm-item"
                      onClick={() => {
                        useAppStore.getState().openBrowserTab(ctxMenu.linkURL);
                        setCtxMenu(null);
                      }}
                    >
                      <ExternalLink size={14} /> {t('browser.openLinkNewTab')}
                    </button>
                    <button
                      type="button"
                      className="ftcm-item"
                      disabled={!parseHttpLink(ctxMenu.linkURL)}
                      onClick={() => void handleOpenContextLinkExternal()}
                    >
                      <ExternalLink size={14} /> {t('browser.openExternal')}
                    </button>
                    <button
                      className="ftcm-item"
                      onClick={() => {
                        void copyMarkdown(ctxMenu.linkURL ?? '');
                        setCtxMenu(null);
                      }}
                    >
                      <Copy size={14} /> {t('browser.copyLink')}
                    </button>
                  </>
                ) : null}
                {ctxMenu.selectionText ? (
                  <button
                    className="ftcm-item"
                    onClick={() => {
                      void copyMarkdown(ctxMenu.selectionText ?? '');
                      setCtxMenu(null);
                    }}
                  >
                    <Copy size={14} /> {t('browser.copySelection')}
                  </button>
                ) : null}
                <div className="ftcm-sep" />
                <button
                  className="ftcm-item"
                  onClick={() => {
                    const wv = webviewRef.current;
                    if (wv) (wv as any).inspectElement(ctxMenu.px, ctxMenu.py);
                    setCtxMenu(null);
                  }}
                >
                  <Wrench size={14} /> {t('browser.inspect')}
                </button>
              </CursorMenu>
            </>,
            document.body,
          )
        : null}

      {/* 自定义设备表单弹窗（Chrome DevTools 全字段） */}
      {customFormOpen ? (
        <CustomDeviceModal onClose={() => setCustomFormOpen(false)} onAdd={addCustomDevice} />
      ) : null}

      {/* 收藏命名弹窗：名称可改，图标固定取网站 favicon（无编辑入口） */}
      {bookmarkDialogOpen ? (
        <BookmarkDialog
          initialName={existingBookmark?.name || defaultBookmarkName}
          initialUrl={url}
          onSave={handleSaveBookmark}
          onClose={() => setBookmarkDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
