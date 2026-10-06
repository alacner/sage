/** Desktop companion: the avatar stays visible above a small hover launcher.
 * Only clicking expands the chat input. Appearance Off keeps the launcher visible. Draft and voice state
 * survive hiding the bar; edge peeking is available only with an avatar. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SquarePen, AudioLines, Plus, ArrowUp, X, ExternalLink } from 'lucide-react';
import { resolveLanguage } from '../../shared/language';
import {
  RESULT_AUTO_DISMISS_MS,
  canSubmit,
  clipBubbleText,
  projectsPanelNeeded,
  projectsPanelPlacement,
  petEdgeAxes,
  shouldAutoSendAfterVoice,
  type PetEdge,
} from '../../shared/pet';
import type { PetNotice } from '../../shared/pet-notifications';
import type { AppSettings, ProjectEntry } from '../../shared/types';
import { applyAppearance, resolveActiveTheme } from '../theme';
import { startVoiceCapture } from '../lib/voice-capture';
import { detectPotentialSecrets } from '../lib/secret-detection';
import { PetAvatar } from './avatar';
import { VoiceSession } from '../lib/voice-session';

type PetMode = 'idle' | 'hover' | 'compose';

interface Bubble {
  title?: string;
  text: string;
  done: boolean;
  kind: 'result' | 'push' | 'error';
  noticeId?: string;
}

export default function PetApp() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [mode, setMode] = useState<PetMode>('idle');
  const hasAvatar = settings?.petStyle !== 'none';
  const hasAvatarRef = useRef(hasAvatar); hasAvatarRef.current = hasAvatar;
  const avatarStyle = settings?.petStyle === 'none' ? 'pixel' : (settings?.petStyle ?? 'pixel');
  const nearRef = useRef(false);
  const draggingRef = useRef(false);
  const showPill = !!settings && !draggingRef.current && (!hasAvatar || mode !== 'idle');
  const draggedHeadRef = useRef(false);
  const [landing, setLanding] = useState(false);
  const landingTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const collapseRef = useRef<() => void>(() => {});
  const [tuckingEdge, setTuckingEdge] = useState<PetEdge | null>(null);
  const [dockEdge, setDockEdge] = useState<PetEdge | null>(null);
  const [emergeFrom, setEmergeFrom] = useState<PetEdge | null>(null);
  const dockRef = useRef(dockEdge); dockRef.current = dockEdge;
  const emergeRef = useRef(emergeFrom); emergeRef.current = emergeFrom;
  const [text, setText] = useState('');
  const [project, setProject] = useState<ProjectEntry | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  // 项目面板开在哪一侧：屏幕上方放不下才开在下方（0.6.506）。
  const [panelBelow, setPanelBelow] = useState(false);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [voiceRequested, setVoiceRequested] = useState(false);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [notices, setNotices] = useState<PetNotice[]>([]);
  const seenNotices = useRef(new Set<string>());
  const currentNotice = notices[0];
  const shownBubble: Bubble | null = bubble ?? (!draggingRef.current && currentNotice ? {title:currentNotice.title,text:currentNotice.body,kind:'push',done:true,noticeId:currentNotice.id} : null);
  const dismissBubble = () => { if (bubble) setBubble(null); else setNotices(list=>list.slice(1)); };
  const revealBubble = () => {void window.api.petOpenMain(shownBubble?.noticeId);dismissBubble();};

  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (bubble || !currentNotice || dragging) return;
    const timer = setTimeout(()=>setNotices(list=>list.slice(1)),8000);
    return () => clearTimeout(timer);
  }, [bubble,currentNotice,dockEdge,dragging]);
  const english = resolveLanguage(settings?.language,settings?._systemLocale) === 'en';
  const copy = useCallback((zh: string, en: string) => (english ? en : zh), [english]);

  const stackRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const interactiveRef = useRef(false);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const convRef = useRef<string | null>(null);
  // 持续模式（petConversationMode='continuous'，默认）：宠物专属对话跨轮次复用；
  // convRef 仍只跟踪"正在流式"的对话用于事件过滤。
  const petConvRef = useRef<string | null>(null);
  const petConvProjectRef = useRef<string | undefined>(undefined);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceBaseRef = useRef('');
  const voiceSegsRef = useRef<string[]>([]);
  const sendingRef = useRef(false);
  sendingRef.current = sending;

  useEffect(() => { if (mode === 'compose') inputRef.current?.focus(); }, [mode]);

  // ── 设置加载 + 主题套用（提交按钮配色跟随外观配置） ──
  useEffect(() => {
    document.documentElement.classList.add('sage-pet');
    let live = true, revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try { const value = await window.api.getSettings(); if (live && current === revision) setSettings(value as AppSettings); } catch { /* retry on settings change */ }
    };
    void refresh();
    const off = window.api.onSettingsChanged(refresh);
    return () => { live = false; off(); };
  }, []);
  useEffect(() => {
    if (!settings) return;
    const active = resolveActiveTheme(settings.theme, settings.themes, settings.builtinThemeOverrides);
    document.documentElement.dataset.theme = active.mode;
    applyAppearance(settings.appearance, active.custom);
  }, [settings]);

  const setInteractive = useCallback((v: boolean) => {
    if (interactiveRef.current === v) return;
    interactiveRef.current = v;
    try { window.api.petSetInteractive(v); } catch { /* 非宠物窗口（测试环境）忽略 */ }
  }, []);

  // Dock state lives in the main process so reopening restores the same edge.
  useEffect(() => {
    let live = true, received = false;
    let timer: ReturnType<typeof setTimeout>;
    const apply = ({ edge, emergeFrom: from, dragging: held }: { edge: PetEdge | null; emergeFrom?: PetEdge; dragging?: boolean }, animate = true) => {
      if (!live) return;
      if (!hasAvatarRef.current) { edge = null; from = undefined; }
      dockRef.current = edge;
      if (edge && animate && !held) { setTuckingEdge(edge); }
      else { setDockEdge(edge); setTuckingEdge(null); }
      setEmergeFrom(from ?? null); emergeRef.current = from ?? null;
      setMode('idle'); setProjectsOpen(false); setMenu(false);
      setInteractive(true);
      clearTimeout(timer);
      if (edge && animate && !held) timer = setTimeout(() => { setDockEdge(edge); setTuckingEdge(null); }, 280);
      if (from) timer = setTimeout(() => { setEmergeFrom(null); emergeRef.current = null; }, 900);
    };
    const off = window.api.onPetDock(value => { received = true; apply(value); });
    void window.api.petDockState().then(edge => { if (!received && edge) apply({edge}, false); }).catch(() => {});
    return () => { live = false; clearTimeout(timer); off(); };
  }, [setInteractive]);
  useEffect(() => {
    window.api.petIdle(hasAvatar && mode === 'idle' && !recording && !voiceRequested && !sending && !bubble && !currentNotice && !menu && !dragging);
    // Docked pets keep their head in place; bubbles expand inward beside it.
  }, [hasAvatar, mode, recording, voiceRequested, sending, bubble, currentNotice, menu, dragging, dockEdge]);

  useEffect(() => {
    if (hasAvatar) { if (!nearRef.current) setMode('idle'); return; }
    dockRef.current = null; emergeRef.current = null;
    setDockEdge(null); setTuckingEdge(null); setEmergeFrom(null);
    setMode('hover'); setInteractive(true);
  }, [hasAvatar, setInteractive]);

  // ── 悬停检测：窗口已紧贴内容，鼠标进入窗口即唤起胶囊（forward 仍投递 mousemove） ──
  useEffect(() => {
    const onMove = () => {
      nearRef.current = true;
      if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
      setInteractive(true);
      if (!draggingRef.current && !emergeRef.current) setMode(current => current === 'idle' ? 'hover' : current);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [setInteractive]);

  // ── 窗口尺寸贴合内容：实测 .pet-stack 包围盒上报，主进程保持右下角锚点缩放 ──
  // 项目面板开在下方时改报 pin='top'：窗口顶边锚定、向下长，胶囊才不会整块往上跳。
  // ResizeObserver 回调只建一次，所以钉哪一边读 ref，不读闭包里的 state。
  const pinTopRef = useRef(false);
  const unpinArmedRef = useRef(false);
  useEffect(() => {
    const el = stackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // Layout dimensions exclude pop/slide transforms, which would shrink the native
      // window to an animation frame and permanently clip the expanded toolbar.
      const r = {width: el.offsetWidth, height: el.offsetHeight};
      try { window.api.petResize?.(Math.ceil(r.width) + (dockRef.current ? 0 : 20), Math.ceil(r.height) + (dockRef.current ? 0 : 16), pinTopRef.current ? 'top' : 'bottom'); } catch { /* 测试环境忽略 */ }
      // 面板刚收起的那一次缩小仍按顶边锚，上报完才放开锚定（见下面的 effect）
      if (unpinArmedRef.current) {
        unpinArmedRef.current = false;
        setPanelBelow(false);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 项目面板开/关：开之前先问主进程上下各还剩多少空间 ──
  // 拿不到（非宠物窗/测试环境）就按默认向上开，不拦住面板。
  const toggleProjects = useCallback(() => {
    if (projectsOpen) { setProjectsOpen(false); return; }
    const open = (room?: { above: number; below: number } | null) => {
      setPanelBelow(!dockRef.current && !!room
        && projectsPanelPlacement({ ...room, needed: projectsPanelNeeded(projects.length) }) === 'below');
      setProjectsOpen(true);
    };
    try {
      void Promise.resolve(window.api.petRoom?.()).then(open, () => open(undefined));
    } catch {
      open(undefined);
    }
  }, [projectsOpen, projects.length]);
  // 锚定跟着 panelBelow 而不是 projectsOpen：面板收起时窗口还得“向上缩一次”，
  // 先解锚会把 stack 粘回尚未缩小的窗口底边，胶囊就跟着面板“掉”到原来的下缘。
  // 正常由下一次实测上报解锚；万一尺寸没变化（某些系统缩放下 RO 不回调），16ms 后兜底。
  pinTopRef.current = panelBelow && !dockEdge;
  useEffect(() => {
    if (projectsOpen || !panelBelow) return;
    unpinArmedRef.current = true;
    const t = setTimeout(() => {
      unpinArmedRef.current = false;
      setPanelBelow(false);
    }, 16);
    return () => { clearTimeout(t); unpinArmedRef.current = false; };
  }, [projectsOpen, panelBelow]);

  // Nearby pointer reveals only the launcher; a short delay bridges the gap between
  // pet, bar and panels. Hiding only changes presentation, never the draft/session.
  useEffect(() => {
    const cancelCollapse = () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    };
    const collapse = () => {
      if (draggingRef.current) return;
      setMenu(false); setProjectsOpen(false);
      if (!hasAvatarRef.current) return;
      setMode('idle');
      setInteractive(false);
    };
    collapseRef.current = collapse;
    const onLeave = () => {
      nearRef.current = false;
      cancelCollapse();
      leaveTimerRef.current = setTimeout(() => { leaveTimerRef.current = null; collapse(); }, 300);
    };
    const onEnter = () => {
      nearRef.current = true;
      cancelCollapse();
      setInteractive(true);
      if (!draggingRef.current && !emergeRef.current) setMode(current => current === 'idle' ? 'hover' : current);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (stackRef.current?.contains(target ?? null)) return;
      collapse();
    };
    const el = document.documentElement;
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('mouseenter', onEnter);
    window.addEventListener('blur', onLeave);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('mouseenter', onEnter);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('mousedown', onDown, true);
      cancelCollapse();
    };
  }, [setInteractive]);

  // ── 按住左键拖拽：非按钮/输入区按下即发起，主进程轮询光标平移窗口 ──
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanupRef.current?.(); clearTimeout(landingTimerRef.current); }, []);
  const startDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    const head = !!t?.closest?.('.pet-peek');
    if (!head && t?.closest?.('button,input,.pet-project-chip,.pet-menu')) return;
    e.preventDefault();
    dragCleanupRef.current?.();
    draggedHeadRef.current = false;
    clearTimeout(landingTimerRef.current); setLanding(false);
    const origin = {x:e.screenX,y:e.screenY};
    const begin = () => {
      if (draggingRef.current) return;
      setInteractive(true);
      draggingRef.current = true; setDragging(true);
      draggedHeadRef.current = head;
      setMode('idle'); setProjectsOpen(false); setMenu(false);
      try { window.api.petDragStart(); } catch { /* test environment */ }
    };
    const move = (event: PointerEvent) => {
      if (Math.hypot(event.screenX-origin.x,event.screenY-origin.y) >= 4) begin();
    };
    try { stackRef.current?.setPointerCapture(e.pointerId); } catch { /* synthetic test event */ }
    if (!head) begin(); // A head still supports a simple click to come out.
    const up = () => {
      const wasDragging = draggingRef.current;
      draggingRef.current = false; setDragging(false);
      if (wasDragging) {
        if (hasAvatarRef.current && !dockRef.current) {
          setLanding(true);
          landingTimerRef.current = setTimeout(()=>setLanding(false),520);
        }
        if (!nearRef.current) collapseRef.current();
        try { window.api.petDragEnd(); } catch { /* ignore */ }
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  }, [setInteractive]);

  // ── 右键菜单：即时切换风格、退出；展示在胶囊上方 ──
  const openMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setInteractive(true);
    setMode(current => current === 'idle' ? 'hover' : current);
    setMenu(true);
  }, [setInteractive]);

  // ── 气泡自动收起（流式更新时重新计时，长回答不会被中途关掉） ──
  const showBubble = useCallback((b: Bubble) => {
    setBubble(b);
  }, []);
  useEffect(() => {
    if (!bubble) return;
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => setBubble(null), RESULT_AUTO_DISMISS_MS);
    return () => { if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current); };
  }, [bubble]);

  // Preload projects once; opening refreshes stale data without refetching on close.
  const projectCache = useRef({loadedAt: 0, pending: false});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const cache = projectCache.current;
    if (cache.pending || (cache.loadedAt && (!projectsOpen || Date.now() - cache.loadedAt < 15000))) return;
    cache.pending = true;
    void window.api.listProjects().then(list => {
      if (mounted.current) { setProjects(list as ProjectEntry[]); cache.loadedAt = Date.now(); }
    }).catch(() => {
      if (mounted.current && projectsOpen) showBubble({text: copy('最近项目加载失败，请重新打开重试。', 'Could not load projects. Reopen to retry.'), done: true, kind: 'error'});
    }).finally(() => { cache.pending = false; });
  }, [projectsOpen, copy, showBubble]);

  // ── 对话事件流：文本增量 / 回合结束 / 错误 / 需要授权 ──
  useEffect(() => {
    const off = window.api.onChat((e: any) => {
      if (!convRef.current || e.convId !== convRef.current) return;
      if (e.type === 'text' && e.payload?.chunk) {
        setBubble((b) => (b && b.kind === 'result'
          ? { ...b, text: b.text + e.payload.chunk, done: false }
          : { text: e.payload.chunk, done: false, kind: 'result' }));
      } else if (e.type === 'turn_state' && !e.payload?.running) {
        convRef.current = null;
        setSending(false);
        setBubble((b) => (b && b.kind === 'result' ? { ...b, done: true } : b));
      } else if (e.type === 'error') {
        convRef.current = null;
        setSending(false);
        showBubble({ text: String(e.payload?.error ?? 'error'), done: true, kind: 'error' });
      } else if (e.type === 'permission_request' || e.type === 'clarify_request') {
        showBubble({ text: copy('需要你的授权/补充信息，请回 Sage 主窗口处理。', 'Approval or more info needed — continue in the Sage window.'), done: false, kind: 'push' });
        void window.api.petOpenMain();
      }
    });
    return () => { off(); };
  }, [copy, showBubble]);

  // ── 主进程推送（定时任务完成等） ──
  useEffect(() => {
    const off = window.api.onPetPush((p) => {
      if (seenNotices.current.has(p.id)) return;
      seenNotices.current.add(p.id);
      if (seenNotices.current.size>100) seenNotices.current.delete(seenNotices.current.values().next().value!);
      setNotices(list=>[...list,p].slice(-5));
    });
    return () => { off(); };
  }, [showBubble]);

  // ── 语音识别事件 ──
  useEffect(() => {
    const off = window.api.onVoiceEvent((ev) => {
      const join = (segs: string[], partial: string) =>
        [...segs, partial].filter(Boolean).join(resolveLanguage(settings?.language,settings?._systemLocale) === 'en' ? ' ' : '');
      if (ev.t === 'partial') {
        textRef.current = voiceBaseRef.current + join(voiceSegsRef.current, ev.text ?? '');
        setText(textRef.current);
      } else if (ev.t === 'segment') {
        if (ev.text) voiceSegsRef.current = [...voiceSegsRef.current, ev.text];
        textRef.current = voiceBaseRef.current + join(voiceSegsRef.current, '');
        setText(textRef.current);
      } else if (ev.t === 'error') {
        stopRecordingRef.current?.(false);
      } else if (ev.t === 'end') {
        // 助手自行收口（如静音超时）：按正常停止处理，转写完成后自动发送
        stopRecordingRef.current?.(true);
      } else if (ev.t === 'status' && ev.auth && ev.auth !== 'authorized') {
        stopRecordingRef.current?.(false);
        showBubble({ text: copy('麦克风/语音识别未授权，请在系统设置中允许 Sage。', 'Mic/speech not authorized; allow Sage in System Settings.'), done: true, kind: 'error' });
      }
    });
    return () => { off(); };
  }, [copy, settings?.language, showBubble]);

  const send = useCallback(async (raw: string) => {
    const t = raw.trim();
    if (!t || !project || sendingRef.current) return;
    if (detectPotentialSecrets(t).length && !window.confirm(copy(
      '检测到内容可能包含密钥或密码。继续发送会把原文发送给所选模型；建议先返回编辑或撤销密钥。仍要发送吗？',
      'This message may contain a secret. Continuing sends the original text to the selected model. Review it or revoke the credential first. Send anyway?',
    ))) return;
    sendingRef.current = true;
    setSending(true);
    setText('');
    setProjectsOpen(false);
    showBubble({ text: '', done: false, kind: 'result' });
    try {
      // 激活对应项目（刷新 lastOpenedAt，主窗口侧栏/最近项目置顶）+ 提交；模式在 设置→通用 配置
      try { void window.api.touchProject?.(project.path); } catch { /* 测试环境忽略 */ }
      const clientMessageId = `pet-${Date.now()}`;
      const petMode = settings?.petConversationMode ?? 'continuous';
      if (petMode === 'continuous' && petConvRef.current && petConvProjectRef.current === project.path) {
        try {
          convRef.current = petConvRef.current;
          await window.api.sendConv(petConvRef.current, t, undefined, 'agent', clientMessageId);
          return;
        } catch (err) {
          // 对话被外部删除 → 退回新建；其它错误照旧冒泡
          if (!/chat not found/i.test(String((err as Error)?.message ?? err))) throw err;
          petConvRef.current = null;
        }
      }
      const meta = await window.api.createConv(project.path, `Pet · ${t.slice(0, 24)}`) as { id: string };
      convRef.current = meta.id;
      petConvRef.current = meta.id;
      petConvProjectRef.current = project.path;
      await window.api.sendConv(meta.id, t, undefined, 'agent', clientMessageId);
    } catch (err) {
      convRef.current = null;
      setSending(false);
      showBubble({ text: String((err as Error)?.message ?? err), done: true, kind: 'error' });
    }
  }, [project, showBubble, settings?.petConversationMode, copy]);

  const sendRef = useRef(send);
  sendRef.current = send;

  const textRef = useRef(text); textRef.current = text;
  const projectRef = useRef(project); projectRef.current = project;
  const voiceHooks = {
    prepare: async () => {
      voiceBaseRef.current = textRef.current && !/\s$/.test(textRef.current) ? `${textRef.current} ` : textRef.current;
      voiceSegsRef.current = [];
      const ensure = await window.api.voiceEnsureMic();
      if (!ensure?.ok) throw new Error(copy('麦克风未授权，请在系统设置→隐私与安全性→麦克风允许 Sage。', 'Allow Sage under System Settings → Privacy → Microphone.'));
      return true;
    },
    capture: () => startVoiceCapture(b64 => window.api.voiceAudio(b64), settings?.voiceInputDeviceId, setLevel),
    start: async () => {
      const res = await window.api.voiceStart(english ? 'en-US' : 'zh-CN');
      if (!res?.ok) throw new Error(res?.error ?? copy('语音识别启动失败', 'Voice start failed'));
      return true;
    },
    stop: () => window.api.voiceStop(),
    active: (value: boolean) => { if (mounted.current) { setRecording(value); if (!value) setLevel(0); } },
    requested: (value: boolean) => { if (mounted.current) setVoiceRequested(value); },
    error: (error: unknown) => { if (mounted.current) showBubble({text: String((error as Error)?.message ?? error), done: true, kind: 'error'}); },
  };
  const hooksRef = useRef(voiceHooks); hooksRef.current = voiceHooks;
  const sessionRef = useRef<VoiceSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new VoiceSession({
    prepare: () => hooksRef.current.prepare(), capture: () => hooksRef.current.capture(),
    start: () => hooksRef.current.start(), stop: () => hooksRef.current.stop(),
    active: value => hooksRef.current.active(value), requested: value => hooksRef.current.requested(value),
    error: error => hooksRef.current.error(error),
  });
  const stopRecording = useCallback(async (autoSend: boolean) => {
    if (!sessionRef.current?.wanted) return;
    await sessionRef.current.stop();
    const finalText = textRef.current.trim();
    if (!mounted.current) return;
    if (autoSend && finalText && shouldAutoSendAfterVoice({ text: finalText, projectPath: projectRef.current?.path })) {
      void sendRef.current(finalText);
    } else if (finalText) {
      setMode('compose');
      if (!projectRef.current) showBubble({ text: copy('选择一个最近项目后即可发送', 'Pick a recent project to send'), done: true, kind: 'push' });
    }
  }, [copy, showBubble]);
  const stopRecordingRef = useRef(stopRecording); stopRecordingRef.current = stopRecording;
  const toggleVoice = useCallback(() => {
    if (sessionRef.current!.wanted) { void stopRecording(true); return; }
    sessionRef.current!.start();
  }, [stopRecording]);
  useEffect(() => () => { void sessionRef.current?.stop(); }, []);

  const changeStyle = async (style: NonNullable<AppSettings['petStyle']>) => {
    try { await window.api.petSetStyle(style); setSettings(current => ({...current, petStyle: style} as AppSettings)); setMenu(false); setMode(style === 'none' || nearRef.current ? 'hover' : 'idle'); }
    catch (error) { showBubble({text: String((error as Error)?.message ?? error), done: true, kind: 'error'}); }
  };
  const submitEnabled = useMemo(() => canSubmit({ text, projectPath: project?.path, sending }), [text, project, sending]);
  const activeEdge = dockEdge ?? tuckingEdge;
  const dockAxes = activeEdge ? petEdgeAxes(activeEdge) : null;
  const atCorner = !!dockAxes?.horizontal && !!dockAxes.vertical;

  return (
    <div data-dock-x={dockAxes?.horizontal ?? undefined} data-dock-y={dockAxes?.vertical ?? undefined} className={`pet-root${atCorner ? ' dock-corner' : ''}${dragging ? ' dragging' : ''}${!hasAvatar ? ' no-avatar' : ''}${dockEdge ? ` docked edge-${dockEdge}${showPill || shownBubble || menu || projectsOpen ? ' dock-open' : ''}` : tuckingEdge ? ` tucking edge-${tuckingEdge}` : ''}`}>
      <div className={`pet-stack${panelBelow && !dockEdge ? ' pin-top' : ''}`} ref={stackRef}>
        {dockEdge && <button className="pet-peek" type="button" aria-label={copy('叫宠物出来', 'Bring pet out')} onContextMenu={openMenu} onPointerDown={startDrag} onClick={() => { if (!draggedHeadRef.current) window.api.petUndock(); draggedHeadRef.current = false; }}>
          <PetAvatar style={avatarStyle} peek paused={dragging} />
        </button>}
        <div className="pet-content" hidden={!!dockEdge && !showPill && !shownBubble && !projectsOpen && !menu}>
        {shownBubble && (
          <div className={`pet-bubble pet-bubble-${shownBubble.kind}`} onMouseDown={e=>e.stopPropagation()}
            role={shownBubble.noticeId ? 'button' : 'status'} tabIndex={shownBubble.noticeId ? 0 : undefined}
            aria-label={shownBubble.noticeId ? copy('查看消息', 'View notification') : undefined}
            onClick={shownBubble.noticeId ? revealBubble : undefined}
            onKeyDown={e=>{if(shownBubble.noticeId && e.target===e.currentTarget && (e.key==='Enter'||e.key===' ')){e.preventDefault();revealBubble();}}}>
            {shownBubble.title && <strong>{shownBubble.title}</strong>}
            <p>{clipBubbleText(shownBubble.text) || (shownBubble.kind === 'result' ? (sending ? '…' : '') : '')}</p>
            <div className="pet-bubble-actions">
              <button type="button" title={copy('在主窗口打开', 'Open in Sage')} onClick={e=>{e.stopPropagation();revealBubble();}}>
                <ExternalLink size={12} />
              </button>
              <button type="button" title={copy('关闭', 'Dismiss')} onClick={e=>{e.stopPropagation();dismissBubble();}}><X size={12} /></button>
            </div>
          </div>
        )}
        {projectsOpen && (
          <div className="pet-projects" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pet-projects-title">{copy('最近项目', 'Recent projects')}</div>
            {projects.slice(0, 8).map((p) => (
              <button
                type="button"
                key={p.path}
                className={`pet-project-row${project?.path === p.path ? ' selected' : ''}`}
                onClick={() => {
                  // Keep the selected project and focus the draft before the panel closes.
                  setProject(p);
                  setProjectsOpen(false);
                  inputRef.current?.focus();
                }}
              >
                <span className="pet-project-name">{p.name}</span>
                <span className="pet-project-path">{p.path}</span>
              </button>
            ))}
            {!projects.length && <p className="pet-projects-empty">{copy('暂无项目', 'No projects yet')}</p>}
          </div>
        )}
        {menu && (
          <div className="pet-menu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
            {(['pixel', 'comic', 'dog-pixel', 'dog-comic', 'none'] as const).map(style => <button key={style} type="button" role="menuitemradio" aria-checked={(settings?.petStyle ?? 'pixel') === style} onClick={() => void changeStyle(style)}>
              {copy({pixel:'像素猫咪',comic:'漫画猫咪','dog-pixel':'像素狗狗','dog-comic':'漫画狗狗',none:'关闭形象'}[style], {pixel:'Pixel cat',comic:'Comic cat','dog-pixel':'Pixel dog','dog-comic':'Comic dog',none:'Appearance off'}[style])}
            </button>)}
            <button type="button" className="pet-exit" role="menuitem" onClick={() => { setMenu(false); try { window.api.petExit(); } catch { /* 测试环境忽略 */ } }}>
              {copy('退出', 'Quit')}
            </button>
          </div>
        )}
        <div className="pet-anchor" onPointerDown={startDrag} onContextMenu={openMenu}>
          {settings && hasAvatar && !dockEdge && <PetAvatar style={avatarStyle} emergeFrom={emergeFrom} held={dragging} landing={landing} />}
          <div className="pet-compose-slot">
          {showPill && (mode !== 'compose' ? (
            <div className="pet-pill pet-launcher" role="group" aria-label={copy('宠物快捷输入', 'Pet quick input')}>
              <button type="button" className="pet-tool pet-compose-toggle"
                title={copy('文字输入', 'Text input')} aria-expanded={false}
                onClick={() => { setMode('compose'); setInteractive(true); }}>
                <SquarePen size={18} />
              </button>
              <span className="pet-divider" aria-hidden="true" />
              <VoiceDot recording={recording || voiceRequested} level={level} onClick={() => void toggleVoice()} copy={copy} />
            </div>
          ) : (
            <div className="pet-pill expanded">
                  {project ? (
                    // 选中项目后：[项目名 +] 合并胶囊，向左延伸展示，点加号重选项目
                    <span className="pet-project-pill" title={project.path}>
                      <span className="pet-project-chip">{project.name}</span>
                      <button
                        type="button"
                        className={`pet-plus${projectsOpen ? ' open' : ''}`}
                        title={copy('更换项目', 'Change project')}
                        onClick={toggleProjects}
                      >
                        <Plus size={24} strokeWidth={2.2} />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`pet-plus${projectsOpen ? ' open' : ''}`}
                      title={copy('选择项目', 'Choose project')}
                      onClick={toggleProjects}
                    >
                      <Plus size={24} strokeWidth={2.2} />
                    </button>
                  )}
                  <input
                    ref={inputRef}
                    className="pet-input"
                    value={text}
                    placeholder={copy('开始新对话', 'Start a new chat')}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing && submitEnabled) void send(text);
                      if (e.key === 'Escape') { setProjectsOpen(false); setMode('hover'); }
                    }}
                  />
                  <button
                    type="button"
                    className={`pet-submit${submitEnabled ? ' ready' : ''}`}
                    disabled={!submitEnabled}
                    title={project ? copy('发送', 'Send') : copy('先选择项目', 'Pick a project first')}
                    onClick={() => void send(text)}
                  >
                    <ArrowUp size={24} strokeWidth={2.2} />
                  </button>
                  <span className="pet-divider" />
                  <VoiceDot recording={recording || voiceRequested} level={level} onClick={() => void toggleVoice()} copy={copy} />
            </div>
          ))}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

/** 语音按钮：待机=声波图标；录音中=黑色圆点，随音量脉动；点击停止。
    脉动系数 0.3 是按「峰值不得超过旁边图标墨迹」定的：12 × 1.3 = 15.6px ≤ 铅笔 15.83px，
    见 pet.css .pet-rec-dot 注释。 */
function VoiceDot({ recording, level, onClick, copy }: {
  recording: boolean;
  level: number;
  onClick: () => void;
  copy: (zh: string, en: string) => string;
}) {
  if (!recording) {
    return (
      <button type="button" className="pet-tool" title={copy('语音输入', 'Voice input')} onClick={onClick}>
        <AudioLines size={18} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="pet-rec-dot"
      style={{ transform: `scale(${1 + Math.min(level, 1) * 0.3})` }}
      title={copy('停止语音（转文字后自动发送）', 'Stop voice (sends after transcription)')}
      onClick={onClick}
    />
  );
}
