import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore, useOpenTerminals } from '../stores/appStore';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../shared/appearance';

/**
 * Read CSS custom properties so xterm's theme matches the app theme.
 */
function getXtermTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  return {
    background: s.getPropertyValue('--bg-0').trim() || '#0f1115',
    foreground: s.getPropertyValue('--text').trim() || '#e6e8ee',
    cursor: s.getPropertyValue('--accent').trim() || '#8b8cf7',
    cursorAccent: s.getPropertyValue('--bg-0').trim() || '#0f1115',
    selectionBackground: s.getPropertyValue('--accent').trim() + '44',
  };
}

interface XtermEntry {
  term: Terminal;
  fit: FitAddon;
  disposed: boolean;
}

/**
 * Multi-terminal view: mounts all open terminals' xterm instances simultaneously.
 * Only the active terminal is visible (display:flex); the rest are hidden (display:none)
 * to preserve scrollback. Always rendered when there are terminal tabs,
 * but uses `.terminal-view-hidden` class when no terminal is active.
 *
 * PR 5: 数据源从 openTerminals + activeTerminalIdx 改为 openTabs + activeTabId。
 * 通过 useOpenTerminals() 派生终端列表，activeTabId 判断激活状态。
 */
export function TerminalView() {
  const openTerminals = useOpenTerminals();
  const activeTabId = useAppStore((s) => s.activeTabId);
  const theme = useAppStore((s) => s.settings?.theme);
  /** 代码字号（设置 → 外观）：未设置时终端维持既有 13px 观感。 */
  const codeFontSize = useAppStore((s) => s.settings?.appearance?.codeFontSize) ?? DEFAULT_TERMINAL_FONT_SIZE;

  // Map of PTY id → xterm instance
  const instancesRef = useRef<Map<string, XtermEntry>>(new Map());
  // Container refs keyed by PTY id
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 判断当前是否激活某个 terminal tab
  const activeTermData = activeTabId?.startsWith('terminal:')
    ? openTerminals.find((t) => activeTabId === `terminal:${t.id}`)
    : undefined;
  const isActive = !!activeTermData;

  // Create / destroy xterm instances as terminals are added / removed
  useEffect(() => {
    const instances = instancesRef.current;
    const currentIds = new Set(openTerminals.map((t) => t.id));

    // Create instances for new terminals
    for (const t of openTerminals) {
      if (instances.has(t.id)) continue;
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        fontSize: codeFontSize,
        lineHeight: 1.3,
        theme: getXtermTheme(),
        cursorBlink: true,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      instances.set(t.id, { term, fit, disposed: false });

      // Wire keyboard input → PTY
      term.onData((data) => {
        window.api.terminalWrite(t.id, data);
      });

      // Mount to container if it exists
      const container = containerRefs.current.get(t.id);
      if (container && container.childElementCount === 0) {
        term.open(container);
        requestAnimationFrame(() => {
          try {
            fit.fit();
            window.api.terminalResize(t.id, term.cols, term.rows);
          } catch { /* not ready */ }
          if (instancesRef.current.get(t.id)?.term === term) window.api.terminalAcknowledge(t.id, 0, true);
        });
      }
    }

    // Destroy instances for removed terminals
    for (const [id, entry] of instances) {
      if (!currentIds.has(id)) {
        entry.disposed = true;
        entry.term.dispose();
        instances.delete(id);
      }
    }
  }, [openTerminals]);

  // Mount xterm to container ref callback
  const setContainerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      containerRefs.current.set(id, el);
      const entry = instancesRef.current.get(id);
      if (entry && el.childElementCount === 0) {
        entry.term.open(el);
        requestAnimationFrame(() => {
          try {
            entry.fit.fit();
            window.api.terminalResize(id, entry.term.cols, entry.term.rows);
          } catch { /* not ready */ }
          if (instancesRef.current.get(id) === entry) window.api.terminalAcknowledge(id, 0, true);
        });
      }
    } else {
      containerRefs.current.delete(id);
    }
  }, []);

  // Global IPC listeners — route output to correct xterm by id
  useEffect(() => {
    const offOutput = window.api.onTerminalOutput((e) => {
      const entry = instancesRef.current.get(e.id);
      if (entry) entry.term.write(e.data, () => { if (!entry.disposed) window.api.terminalAcknowledge(e.id, e.data.length); });
      else window.api.terminalAcknowledge(e.id, e.data.length);
    });
    const offExit = window.api.onTerminalExit((e) => {
      const entry = instancesRef.current.get(e.id);
      if (entry) {
        entry.term.writeln(`\r\n[Process exited with code ${e.code}]`);
      }
      // Mark terminal as exited in store — 更新 openTabs 中对应的 terminal tab
      const state = useAppStore.getState();
      const tabId = `terminal:${e.id}`;
      const tabIndex = state.openTabs.findIndex((t) => t.id === tabId);
      if (tabIndex >= 0) {
        const tab = state.openTabs[tabIndex];
        if (tab.kind === 'terminal') {
          const updated: typeof state.openTabs = [...state.openTabs];
          updated[tabIndex] = {
            ...tab,
            data: { ...tab.data, exited: true, exitCode: e.code },
          };
          useAppStore.setState({ openTabs: updated });
        }
      }
    });
    return () => { offOutput(); offExit(); };
  }, []);

  useEffect(() => () => {
    for (const entry of instancesRef.current.values()) { entry.disposed = true; entry.term.dispose(); }
    instancesRef.current.clear();
    // Ref callbacks remove containers on a real unmount. StrictMode replays
    // effects with the same DOM refs, so keep them available for the next setup.
  }, []);

  // Re-fit active terminal when it becomes visible
  useEffect(() => {
    if (!isActive || !activeTermData) return;
    const entry = instancesRef.current.get(activeTermData.id);
    if (!entry) return;
    // Delay to let CSS display transition complete
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          entry.term.refresh(0, entry.term.rows - 1);
          entry.fit.fit();
          window.api.terminalResize(activeTermData.id, entry.term.cols, entry.term.rows);
          entry.term.focus();
        } catch { /* ignore */ }
      });
    });
  }, [activeTermData, isActive]);

  // ResizeObserver for the active terminal's container
  useEffect(() => {
    if (!isActive || !activeTermData) return;
    const container = containerRefs.current.get(activeTermData.id);
    const entry = instancesRef.current.get(activeTermData.id);
    if (!container || !entry) return;
    const ro = new ResizeObserver(() => {
      try {
        entry.fit.fit();
        window.api.terminalResize(activeTermData.id, entry.term.cols, entry.term.rows);
      } catch { /* ignore */ }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [activeTermData, isActive]);

  // Theme sync
  useEffect(() => {
    requestAnimationFrame(() => {
      const xtermTheme = getXtermTheme();
      for (const [, entry] of instancesRef.current) {
        entry.term.options.theme = xtermTheme;
      }
    });
  }, [theme]);

  // 代码字号同步（设置 → 外观）：只改激活终端（隐藏终端 char 度量无效，
  // 切回激活时本 effect 会重跑补上），改完重新 fit 并向 PTY 报告新行列数。
  useEffect(() => {
    if (!isActive || !activeTermData) return;
    const entry = instancesRef.current.get(activeTermData.id);
    if (!entry) return;
    if (entry.term.options.fontSize !== codeFontSize) entry.term.options.fontSize = codeFontSize;
    requestAnimationFrame(() => {
      try {
        entry.fit.fit();
        window.api.terminalResize(activeTermData.id, entry.term.cols, entry.term.rows);
      } catch { /* ignore */ }
    });
  }, [codeFontSize, isActive, activeTermData]);

  return (
    <div className={`terminal-view ${isActive ? '' : 'terminal-view-hidden'}`}>
      {openTerminals.map((t) => {
        const shown = isActive && activeTermData?.id === t.id;
        return (
          <div
            key={t.id}
            className="terminal-view-container"
            style={{ display: shown ? 'flex' : 'none' }}
            ref={(el) => setContainerRef(t.id, el)}
          />
        );
      })}
    </div>
  );
}
