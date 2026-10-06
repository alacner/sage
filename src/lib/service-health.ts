/**
 * 反馈 / 更新服务器地址自检状态（渲染层单例）。
 * 实际探测由主进程执行（不受 CORS 限制），本模块只缓存结果并通知订阅者：
 *   - 设置页两个地址后展示绿点「服务正常」/ 红点原因（与中继连接点同风格）；
 *   - 反馈入口要求中继服务自检通过，连接或凭证变更时立即失效并按状态重新探测。
 * 触发时机：App 启动 + 每 5 分钟周期；设置页进入「更新」tab、地址输入变化（防抖）、保存成功后。
 */
import { useSyncExternalStore } from 'react';

export interface ServiceProbe {
  ok: boolean;
  /** 实际探测的地址（未配置时为空串）。 */
  url: string;
  status?: number;
  /** not-configured / timeout / HTTP xxx / 网络错误短文案。 */
  error?: string;
  ts: number;
}
export type ServiceKind = 'feedback' | 'update';

interface ServiceHealthState {
  feedback: ServiceProbe | null;
  update: ServiceProbe | null;
}

let state: ServiceHealthState = { feedback: null, update: null };
const listeners = new Set<() => void>();
const inflight: Partial<Record<ServiceKind, { url?: string; promise: Promise<void> }>> = {};
const generations: Record<ServiceKind, number> = { feedback: 0, update: 0 };

function setState(patch: Partial<ServiceHealthState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function subscribeServiceHealth(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function getServiceHealth(): ServiceHealthState {
  return state;
}
export function useServiceHealth(): ServiceHealthState {
  return useSyncExternalStore(subscribeServiceHealth, getServiceHealth);
}

function invalidateFeedbackService(): void {
  generations.feedback++;
  inflight.feedback = undefined;
  setState({ feedback: null });
}

export function watchFeedbackService(): () => void {
  invalidateFeedbackService();
  let disposed = false;
  let statusReceived = false;
  const update = (status: string) => {
    if (disposed) return;
    invalidateFeedbackService();
    if (status === 'connected') void probeService('feedback');
  };
  const unsubscribe = window.api.onRelayStatus(event => {
    statusReceived = true;
    update(event.status);
  });
  void window.api.getRelayStatus().then(event => {
    if (!statusReceived) update(event.status);
  }).catch(() => {
    if (!disposed && !statusReceived) invalidateFeedbackService();
  });
  return () => {
    disposed = true;
    unsubscribe();
    invalidateFeedbackService();
  };
}

/** Merge only probes of the same address; the newest address owns the displayed result. */
export function probeService(kind: ServiceKind, urlOverride?: string): Promise<void> {
  const pending = inflight[kind];
  if (pending && pending.url === urlOverride) return pending.promise;
  const generation = ++generations[kind];
  const run = (async () => {
    try {
      const res =
        kind === 'feedback'
          ? await window.api.probeFeedbackService(urlOverride)
          : await window.api.probeUpdateService(urlOverride);
      // A stale probe must not restore availability after disconnect or credential changes.
      if (generation !== generations[kind]) return;
      setState({ [kind]: { ...res, ts: Date.now() } } as Partial<ServiceHealthState>);
    } catch (error) {
      if (generation === generations[kind]) {
        setState({ [kind]: { ok: false, url: urlOverride ?? '', error: String(error), ts: Date.now() } });
      }
    }
  })();
  inflight[kind] = { url: urlOverride, promise: run };
  void run.finally(() => {
    if (inflight[kind]?.promise === run) inflight[kind] = undefined;
  });
  return run;
}

export function probeAllServices(): Promise<void> {
  return Promise.all([probeService('feedback'), probeService('update')]).then(() => undefined);
}
