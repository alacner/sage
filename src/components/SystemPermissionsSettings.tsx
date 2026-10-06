import { useCallback, useEffect, useState } from 'react';
import { Accessibility, Monitor, Camera, Mic, AudioLines, Bell, ExternalLink, RotateCcw, Send, ShieldCheck } from 'lucide-react';
import { resolveLanguage } from '../../shared/language';
import type { PrivacyStatusPayload } from '../../shared/types';
import { useAppStore } from '../stores/appStore';

type PrivacyPane = 'accessibility' | 'screen' | 'camera' | 'microphone' | 'speech' | 'notifications';

/**
 * 系统权限（macOS TCC）总览：安全与授权页底部。
 * 列出 Sage 真实用到的系统权限，状态全部来自真接口（主进程 privacy:status）：
 * 辅助功能、屏幕录制、摄像头和麦克风走 systemPreferences；语音识别/通知走带 bundle 身份的探针。
 * 另给出跳转系统设置、当场弹授权框、麦克风 TCC 失效自救（重置授权），
 * 以及本构建的签名身份说明——ad-hoc 构建的授权不跨版本，是“明明授过权却显示未请求”的根因。
 */
export function SystemPermissionsSettings() {
  const settings = useAppStore(s => s.settings);
  const english = resolveLanguage(settings?.language,settings?._systemLocale) === 'en';
  const copy = (zh: string, en: string) => (english ? en : zh);
  const [status, setStatus] = useState<PrivacyStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try { setStatus(await window.api.privacyStatus()); } catch { /* 非 Electron 环境（测试）保持未知 */ }
  }, []);
  // 打开系统设置后返回本窗口时自动刷新（focus 事件覆盖"用户去授权再回来"的回路）
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const labelOf = (st?: string) => st === 'granted' ? copy('已授权', 'Granted') : st === 'denied' ? copy('未授权', 'Denied') : st === 'restricted' ? copy('受限', 'Restricted') : st === 'provisional' ? copy('静默授权', 'Provisional') : st === 'not-determined' ? copy('未请求', 'Not requested') : copy('无法检测', 'Not detectable');
  const toneOf = (st?: string) => st === 'granted' || st === 'provisional' ? 'ok' : st === 'denied' || st === 'restricted' ? 'warn' : 'muted';
  // 通知：主进程用 UNUserNotificationCenter 直读（Electron 31 自没有 Notification.isGranted）；
  // 'unknown' = 这台机器上确实测不出（开发态无 bundle 身份/探针缺失），如实显示无法检测。
  const notifState = status?.notifications;

  const rows: Array<{ pane: PrivacyPane; icon: typeof Mic; name: string; desc: string; state?: string }> = [
    { pane: 'accessibility', icon: Accessibility, name: copy('辅助功能', 'Accessibility'), desc: copy('用于 Sage 在前台时拦截语音和截图快捷键，减少与其他应用同时触发；授权后回到 Sage 生效。', 'Allows Sage to intercept voice and screenshot shortcuts while in front, reducing conflicts with other apps. Return to Sage after granting access.'), state: status?.accessibility },
    { pane: 'screen', icon: Monitor, name: copy('屏幕录制', 'Screen Recording'), desc: copy('截图时读取屏幕内容；在系统设置中允许 Sage，若列表中没有 Sage 可用“＋”添加。修改后可能需要重启 Sage。', 'Reads screen content for screenshots. Allow Sage in System Settings; use “+” to add Sage if it is missing. A restart may be required after changing access.'), state: status?.screen },
    { pane: 'camera', icon: Camera, name: copy('摄像头', 'Camera'), desc: copy('内置浏览器进行网页身份验证和视频通话时使用；修改授权后可能需要重启 Sage。', 'Used for identity verification and video calls in the built-in browser; restart Sage if a permission change does not take effect.'), state: status?.camera },
    { pane: 'microphone', icon: Mic, name: copy('麦克风', 'Microphone'), desc: copy('语音输入采集音频；拒绝后语音按钮只能拿到静音流。', 'Audio capture for voice input; without it the mic button only gets silence.'), state: status?.microphone },
    { pane: 'speech', icon: AudioLines, name: copy('语音识别', 'Speech Recognition'), desc: copy('系统听写助手将语音转写为文字，配合麦克风完成语音输入。', 'System dictation helper transcribes speech; works with the microphone.'), state: status?.speech },
    { pane: 'notifications', icon: Bell, name: copy('通知', 'Notifications'), desc: copy('定时任务等后台执行完成后在通知中心提醒你。', 'Notify in Notification Center when background runs (e.g. scheduled tasks) finish.'), state: notifState },
  ];

  // 新版 macOS 隐私面板没有手动添加入口：未请求过的应用根本不出现在列表里，跳过去也无事可做。
  // 麦克风/语音识别改为当场弹系统授权框（与首次语音输入同一条路径）；弹框后仍未授权
  // （denied 存量场景列表里有 Sage）才回退跳系统设置。
  // 通知同理：未请求时系统设置里没有 Sage 条目，只能靠首次投递弹框（即“发送测试”）。
  const grant = async (pane: PrivacyPane) => {
    setBusy(true); setNotice('');
    try {
      if (pane === 'accessibility') {
        await window.api.requestComposerShortcutPriority();
      } else if (pane === 'screen') {
        const result = await window.api.openSystemPrivacy(pane);
        if (!result.ok) throw new Error('Screen Recording settings unavailable');
      } else if (pane === 'camera') {
        const r = await window.api.cameraGrant().catch(() => null);
        if (r?.status !== 'granted') await openPaneQuiet(pane);
      } else if (pane === 'microphone') {
        const r = await window.api.voiceEnsureMic().catch(() => null);
        if (r?.status !== 'granted') await openPaneQuiet(pane);
      } else if (pane === 'speech') {
        const r = await window.api.speechGrant().catch(() => null);
        if (r?.status !== 'authorized') await openPaneQuiet(pane);
      } else {
        await openPaneQuiet(pane);
      }
    } catch { setNotice(copy('无法打开系统设置', 'Failed to open System Settings')); }
    await refresh();
    setBusy(false);
  };
  const openPaneQuiet = async (pane: Exclude<PrivacyPane, 'accessibility'>) => { try { await window.api.openSystemPrivacy(pane); } catch { /* 弹框已解决时静默 */ } };
  const resetMic = async () => {
    setBusy(true); setNotice('');
    try {
      const r = await window.api.voiceResetMicTcc();
      if (r.ok) {
        // 重置后系统设置里已无 Sage 条目（无法手动添加），直接重新弹系统授权框一步到位
        try { await window.api.voiceEnsureMic(); } catch { /* 测试环境忽略 */ }
        setNotice(copy('已清除旧授权记录，并重新弹出系统授权框——请选择“允许”。', 'Old permission cleared and the system prompt re-opened — choose “Allow”.'));
      } else {
        setNotice(copy('重置失败', 'Reset failed'));
      }
    } catch (e: any) { setNotice(String(e?.message ?? e)); }
    await refresh(); setBusy(false);
  };
  const sendTest = async () => {
    setBusy(true); setNotice('');
    try { const r = await window.api.notifyTest(); setNotice(r.ok ? copy('测试通知已发送；没有看到请检查系统设置 → 通知中的 Sage 开关。', 'Test notification sent; if you don\'t see it, check System Settings → Notifications → Sage.') : (r.error || copy('发送失败', 'Failed to send'))); } catch (e: any) { setNotice(String(e?.message ?? e)); }
    await refresh(); setBusy(false);
  };

  // 签名身份说明：macOS 靠 Designated Requirement 判定“问权限的是不是同一个应用”。
  // ad-hoc 构建旧版本把 DR 绑在本次 cdhash 上，每次更新都被当成新应用——用户明明在系统设置里
  // 授过权，这里却只能读到“未请求”。afterSign 已钉成 identifier 绑定，面板把这层信息说清楚。
  const identity = status?.identity;
  const identityNote = !identity ? ''
    : !identity.bundleId
      ? copy('无法确认当前运行应用的权限身份；不会按已安装的 Sage 重置授权。', 'The running app identity is unknown. Permission resets will not target the installed Sage.')
    : identity.devInstance
      ? copy(`当前是开发实例，权限探测读的是 ${identity.bundleId} 名下的记录，与已安装的 Sage 互不相干。`, `This is a dev instance: permissions are probed under ${identity.bundleId}, unrelated to the installed Sage.`)
      : !identity.stable
        ? copy(`当前构建的权限身份绑定在本次安装包（${identity.bundleId}，ad-hoc 签名），更新重装后需要重新授权一次。`, `This build's permission identity is bound to the installed package (${identity.bundleId}, ad-hoc signature); grant again once after each update.`)
        : '';

  return <section className="sysperm">
    <h3>{copy('系统权限', 'System permissions')}</h3>
    <p className="security-muted">{copy('Sage 用到的 macOS 系统权限；修改授权后回到本窗口会自动刷新状态。', 'macOS permissions Sage relies on; status refreshes automatically when you return to this window.')}</p>
    <div className="sysperm-list settings-card">
      {rows.map(row => { const Icon = row.icon; return <div key={row.pane} className="sysperm-row">
        <span className="sysperm-icon"><Icon size={16} /></span>
        <div className="sysperm-text"><strong>{row.name}</strong><p>{row.desc}</p>
          {row.pane === 'notifications' && <label className="sysperm-toggle"><input type="checkbox" disabled={busy} checked={settings?.systemNotifications === true} onChange={e => { void useAppStore.getState().saveSettings({ systemNotifications: e.target.checked }).catch(() => {}); }} /><span>{copy('后台任务完成后发送系统通知', 'Send a system notification when background tasks finish')}</span></label>}
        </div>
        <span className={`sysperm-status ${toneOf(row.state)}`}>{labelOf(row.state)}</span>
        {row.pane === 'accessibility' || row.pane === 'screen'
          ? <button className="btn-secondary sysperm-action" disabled={busy} onClick={() => void grant(row.pane)}><ExternalLink size={13} />{row.pane === 'accessibility' ? copy('辅助功能设置', 'Accessibility settings') : copy('屏幕录制设置', 'Screen Recording settings')}</button>
          : row.state !== 'granted' && row.state !== 'provisional' && (row.pane === 'notifications'
          // 未请求时系统设置里根本没有 Sage 条目，跳过去是死路——那种情况只靠下面的“发送测试”（首次投递会弹框）
          ? (row.state === 'denied' || row.state === 'unknown' || !row.state) && <button className="btn-secondary sysperm-action" disabled={busy} title={copy('系统设置里 Sage 的通知被关掉了，去通知面板打开；状态测不出来时也去那里人工确认', 'Sage is off in Notification settings, or the status can\'t be read — confirm it there')} onClick={() => void grant(row.pane)}><ExternalLink size={13} />{copy('通知设置', 'Notification settings')}</button>
          : <button className="btn-secondary sysperm-action" disabled={busy} title={copy('当场弹出 macOS 系统授权框', 'Trigger the macOS permission prompt now')} onClick={() => void grant(row.pane)}><ShieldCheck size={13} />{copy('立即授权', 'Grant now')}</button>)}
        {row.pane === 'camera' && <button className="btn-ghost sysperm-action" disabled={busy} onClick={() => void openPaneQuiet('camera')}><ExternalLink size={13} />{copy('摄像头设置', 'Camera settings')}</button>}
        {row.pane === 'microphone' && (row.state === 'denied' || row.state === 'not-determined') && <button className="btn-ghost sysperm-action" disabled={busy} title={copy('清除失效的授权记录并重新弹出系统授权框（系统设置里显示已授权但这里不同步时也适用）', 'Clear the stale TCC record and re-trigger the system prompt (also helps when System Settings shows access but the app does not)')} onClick={() => void resetMic()}><RotateCcw size={13} />{copy('重置授权', 'Reset')}</button>}
        {row.pane === 'notifications' && <button className="btn-ghost sysperm-action" disabled={busy} title={copy('发一条真实通知验证链路；从未授权过时 macOS 会在这一刻弹授权框', 'Deliver a real notification to verify the pipeline; macOS prompts for authorization on first delivery')} onClick={() => void sendTest()}><Send size={13} />{copy('发送测试', 'Send test')}</button>}
      </div>; })}
    </div>
    {identityNote && <p className="security-muted sysperm-identity" role="note">{identityNote}</p>}
    {notice && <p className="security-muted" role="status">{notice}</p>}
  </section>;
}
