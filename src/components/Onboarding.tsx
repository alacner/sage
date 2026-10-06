import { WindowOverlay } from './WindowOverlay';
import { resolveLanguage } from '../../shared/language';
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { setupModelReady, useOnboardingContext } from '../lib/onboarding-context';
import './onboarding.css';

type Step = 'welcome' | 'provider-choice' | 'relay-address' | 'relay-token-choice' | 'relay-apply' | 'relay-token' | 'relay-connect' | 'relay-wait'
  | 'provider-add' | 'provider-name' | 'provider-host' | 'provider-protocol' | 'provider-key' | 'provider-test' | 'provider-models'
  | 'probe-open' | 'probe-retry' | 'default-model' | 'vision-model' | 'cli-install' | 'backend-engine' | 'chat' | 'help';
type Route = 'relay' | 'api' | 'cli';
const targetFor: Partial<Record<Step, string>> = {
  'relay-address': 'relay-address', 'relay-apply': 'relay-apply', 'relay-token': 'relay-token', 'relay-connect': 'relay-connect', 'relay-wait': 'providers',
  'provider-add': 'add-provider', 'provider-name': 'provider-name', 'provider-host': 'provider-host', 'provider-protocol': 'provider-protocol',
  'provider-key': 'provider-key', 'provider-test': 'provider-test', 'provider-models': 'provider-models', 'probe-open': 'probe-open',
  'probe-retry': 'probe-retry', 'default-model': 'default-model', 'vision-model': 'vision-model', 'backend-engine': 'backend-engine', 'help': 'help-search',
};
function tabFor(step: Step) {
  if (step.startsWith('relay-') && step !== 'relay-wait') return 'relay';
  if (step === 'cli-install') return 'plugins';
  if (step === 'backend-engine') return 'general';
  if (step === 'provider-choice' || step === 'welcome' || step === 'chat' || step === 'help') return null;
  return 'models';
}

export function Onboarding() {
  const settings = useAppStore(s => s.settings);
  const loadError = useAppStore(s => s.settingsLoadError);
  const project = useAppStore(s => s.currentProject);
  const {snapshot, selectedProviderId, probe} = useOnboardingContext();
  const [step, setStep] = useState<Step | null>(null);
  const [route, setRoute] = useState<Route>('relay');
  const [history, setHistory] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [locateRevision, setLocateRevision] = useState(0);
  const claim = useRef<Promise<{show: boolean}> | null>(null);
  const manual = useRef(false);
  const probeBaseline = useRef(0);
  const actionEpoch = useRef(0);
  const en = resolveLanguage(settings?.language,settings?._systemLocale) === 'en';
  const text = (zh: string, english: string) => en ? english : zh;
  const close = () => { actionEpoch.current++; manual.current = true; setStep(null); setHistory([]); setError(''); setBusy(false); };
  const reveal = (next: Step) => {
    const tab = tabFor(next);
    if (tab) useAppStore.getState().openSettingsTab({initialTab: tab});
    if (next === 'help') useAppStore.getState().openSingletonTab('help');
  };
  const navigate = (next: Step) => {
    if (step) setHistory(h => [...h, step]);
    if (next === 'probe-open') probeBaseline.current = probe?.attempts ?? 0;
    setError(''); setStep(next); reveal(next);
  };
  const back = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory(h => h.slice(0, -1)); setError(''); setStep(previous); reveal(previous);
  };
  const chooseApi = async (next: Step, nextRoute: Route) => {
    const epoch = ++actionEpoch.current;
    setBusy(true); setError('');
    try {
      if (useAppStore.getState().settings?.backendEngine && useAppStore.getState().settings?.backendEngine !== 'api') {
        await useAppStore.getState().saveSettings({backendEngine: 'api'});
      }
      if (epoch === actionEpoch.current) { setRoute(nextRoute); navigate(next); }
    } catch (e) { if (epoch === actionEpoch.current) setError(String(e)); }
    finally { if (epoch === actionEpoch.current) setBusy(false); }
  };
  useEffect(() => {
    if (!settings || loadError) return;
    let alive = true;
    claim.current ??= window.api.claimOnboarding();
    claim.current.then(result => { if (alive && result.show && !manual.current) setStep('welcome'); })
      .catch(e => { if (alive) useAppStore.getState().setBanner(String(e)); });
    return () => { alive = false; };
  }, [!!settings, loadError]);
  useEffect(() => {
    const open = (event: Event) => {
      actionEpoch.current++; manual.current = true; setHistory([]); setError(''); setBusy(false);
      const requested = (event as CustomEvent).detail?.step;
      const next: Step = requested === 0 ? 'relay-address' : requested === 1 ? 'provider-add' : requested === 2 ? 'default-model' : 'welcome';
      setRoute(requested === 0 ? 'relay' : 'api'); setStep(next); reveal(next);
    };
    window.addEventListener('sage:onboarding:open', open);
    return () => { actionEpoch.current++; window.removeEventListener('sage:onboarding:open', open); };
  }, []);
  useEffect(() => {
    if (!step) return;
    document.body.dataset.setupStep = step;
    const anchor = targetFor[step];
    if (!anchor) return () => { delete document.body.dataset.setupStep; };
    let target: HTMLElement | null = null;
    const locate = () => {
      target = document.querySelector<HTMLElement>(`[data-setup="${anchor}"]`);
      if (target) { target.classList.add('onboarding-target'); target.scrollIntoView?.({block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); observer.disconnect(); }
    };
    const observer = new MutationObserver(locate);
    observer.observe(document.body, {childList: true, subtree: true});
    locate();
    const timeout = setTimeout(() => observer.disconnect(), 15000);
    return () => { observer.disconnect(); clearTimeout(timeout); target?.classList.remove('onboarding-target'); delete document.body.dataset.setupStep; };
  }, [step, locateRevision, selectedProviderId, snapshot?.tab]);

  const provider = snapshot?.providers.find(p => p.id === selectedProviderId && p.kind !== 'relay' && p.kind !== 'composite' && !p.customRouting);
  const test = provider && snapshot?.test.id === provider.id ? snapshot.test.result : undefined;
  const connected = snapshot?.relay.status === 'connected';
  const relayModels = snapshot?.providers.find(p => p.kind === 'relay' && p.enabled && p.models.length > 0);
  const saved = !!snapshot && !snapshot.saving && !snapshot.error;
  const defaultReady = !!snapshot && setupModelReady(snapshot.providers, snapshot.defaultModel);
  const visionReady = !!snapshot && setupModelReady(snapshot.providers, snapshot.visionModel);
  const probeReady = !!probe?.loaded && !probe.running && !probe.error && (probe.pending === 0 || probe.attempts > probeBaseline.current);
  const action = (label: string, onClick: () => void, disabled = false, primary = true) => <button type="button" className={primary ? 'btn-primary' : undefined} disabled={disabled || busy && onClick !== close} onClick={onClick}>{label}</button>;
  const next = (to: Step, disabled = false, label = text('下一步', 'Next')) => action(label, () => navigate(to), disabled);
  if (!step) return null;
  if (step === 'welcome' || step === 'provider-choice') return <WindowOverlay className="onboarding-overlay" onEscape={close}><section className="onboarding-welcome" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
    <span className="onboarding-badge">{text('新引导', 'New guide')}</span>
    <h2 id="onboarding-title">{step === 'welcome' ? text('选择适合你的连接方式', 'Choose how to connect') : text('要配置自己的模型提供商吗？', 'Set up your own model provider?')}</h2>
    <p>{step === 'welcome'
      ? text('Sage 需要一个执行引擎：API 直连，或安装并配置 CLI 引擎插件。中继可以统一提供 API 模型，省去逐个填写提供商密钥。', 'Sage needs an execution engine: a direct API connection, or an installed and configured CLI engine plugin. A relay supplies API models without separate provider keys.')
      : text('如果你有模型厂商的 API Host 和 API Key，可以直接配置提供商。没有这些信息，也可以选择 CLI 引擎插件，或先自己探索。', 'If you have a provider’s API Host and API Key, configure it directly. Otherwise, use a CLI engine plugin or explore on your own.')}</p>
    {step === 'welcome' && <p><strong>{text('你要使用中继连接吗？', 'Would you like to use a relay?')}</strong><br/>{text('适合已有 Sage 中继地址，或可以向中继站点申请 Token 的用户。', 'Choose this if you have a Sage relay address or can apply for a token on its website.')}</p>}
    <p className="onboarding-note">{text('已有配置会保留。可随时结束，并从「设置 → 通用」重新打开。新版引导只自动展示一次。', 'Existing settings are preserved. Close at any time and reopen in Settings → General. This new guide appears automatically once.')}</p>
    {error && <p role="alert">{error}</p>}
    <div className="onboarding-actions">
      {action(text('自己探索', 'Explore on my own'), close, false, false)}
      {action(text('使用 CLI 插件', 'Use a CLI plugin'), () => { setRoute('cli'); navigate('cli-install'); }, false, false)}
      {step === 'welcome'
        ? <>{action(text('否，选择其他方式', 'No, choose another option'), () => navigate('provider-choice'), false, false)}{action(text('是，使用中继', 'Yes, use a relay'), () => void chooseApi('relay-address', 'relay'))}</>
        : <>{action(text('上一步', 'Back'), back, false, false)}{action(text('是，配置提供商', 'Yes, configure a provider'), () => void chooseApi('provider-add', 'api'))}</>}
    </div>
  </section></WindowOverlay>;

  let title = '', description = '', status = '', controls: React.ReactNode = null;
  switch (step) {
    case 'relay-address':
      title = text('填写中继连接地址', 'Enter the relay address');
      description = text('在高亮的「连接地址」中填写中继服务商提供的完整地址。连接地址用于访问中继，不是模型厂商的 API Host。', 'Enter the full address supplied by your Sage relay operator in the highlighted field. This is the relay address, not a model provider’s API Host.');
      controls = next('relay-token-choice', !snapshot?.relay.hasAddress); break;
    case 'relay-token-choice':
      title = text('你有中继 Token 吗？', 'Do you have a relay token?');
      description = text('Token 是中继站点给你的连接凭据。有就直接填写；没有就先去申请。', 'A token is the connection credential from your relay website. Enter an existing token or apply for one first.');
      controls = <>{next('relay-apply', false, text('没有，去申请', 'No, apply for one'))}{next('relay-token', false, text('有，填写 Token', 'Yes, enter my token'))}</>; break;
    case 'relay-apply':
      title = text('点击「申请」获取 Token', 'Apply for a token');
      description = text('点击 Token 旁的「申请」，在中继站点完成申请，复制 Token 后回到 Sage。', 'Click Apply beside the Token field, complete the application on the relay website, then copy your token and return to Sage.');
      status = snapshot?.relay.hasToken ? text('已填写 Token，可以继续。', 'A token has been entered; you can continue.') : snapshot?.relay.apply === 'available' ? text('申请入口已就绪。', 'The application link is ready.') : snapshot?.relay.apply === 'unavailable' ? text('该地址未提供可访问的申请页。请检查地址，或向中继服务商索取 Token。', 'No accessible application page was found. Check the address or request a token from the relay operator.') : text('正在检查中继站点的申请入口…', 'Checking the relay application page…');
      controls = next('relay-token', false, text('已拿到 Token，继续填写', 'I have a token; continue')); break;
    case 'relay-token':
      title = text('填写 Token', 'Enter your token');
      description = text('把 Token 粘贴到高亮输入框。不要把 API Key 或登录密码填在这里。', 'Paste the relay token into the highlighted field. This field is for the token, not a provider API Key or account password.');
      controls = next('relay-connect', !snapshot?.relay.hasAddress || !snapshot?.relay.hasToken); break;
    case 'relay-connect':
      title = text('点击「连接」', 'Connect to the relay');
      description = text('点击下方高亮的「连接」，等待状态变成「已连接」。如果填完后已自动连接，可以直接继续。', 'Click the highlighted Connect button and wait for Connected. If the completed fields connected automatically, continue.');
      status = connected ? text('中继已连接。下一步等待模型同步。', 'Relay connected. Next, wait for model synchronization.') : snapshot?.relay.error || (snapshot?.relay.status === 'connecting' ? text('连接中，请稍候…', 'Connecting; please wait…') : text('尚未连接，请检查地址和 Token 后点击连接。', 'Not connected yet. Check the address and token, then click Connect.'));
      controls = next('relay-wait', !connected, text('查看中继模型', 'View relay models')); break;
    case 'relay-wait':
      title = text('等待中继提供商和模型出现', 'Wait for the relay provider and models');
      description = text('连接成功后，提供商与授权模型会自动出现在这里，首次同步可能需要一会儿。中继会复用已有的模型能力数据，通常无需在本机逐项重新验证。', 'The relay provider and authorized models appear here automatically. Initial synchronization may take a little while. Existing capability data is reused, so local verification is usually unnecessary.');
      status = !connected ? text('中继连接已断开，请返回连接页重连。', 'The relay disconnected. Return to the connection page to reconnect.') : relayModels ? text(`已同步 ${relayModels.models.length} 个模型，可以设置全局模型了。`, `${relayModels.models.length} models synchronized. Choose your global models next.`) : text('仍在等待同步。若长时间没有模型，请确认 Token 获得了模型权限；不需要手动添加中继提供商。', 'Waiting for synchronization. If no models arrive, check the token’s model permissions. You do not need to add a relay provider manually.');
      controls = <>{!connected && action(text('返回中继连接', 'Return to relay connection'), () => navigate('relay-connect'), false, false)}{next('default-model', !connected || !relayModels)}</>; break;
    case 'provider-add':
      title = text('添加模型提供商', 'Add a model provider');
      description = text('点击「添加提供商」，创建一个普通 API 提供商；也可以选中已有的普通提供商继续配置。接下来会依次填写名称、API Host、协议和 API Key。', 'Click Add provider to create a regular API provider, or select an existing regular provider. We will walk through its name, API Host, protocol and API Key.');
      controls = next('provider-name', !provider); break;
    case 'provider-name':
      title = text('填写提供商名称', 'Name your provider');
      description = text('名称方便你在模型列表中认出这家提供商，例如厂商名称或自己的备注。', 'Use a name you can recognize in the model list, such as the vendor’s name or your own label.');
      controls = next('provider-host', !provider?.name.trim()); break;
    case 'provider-host':
      title = text('填写 API Host', 'Enter the API Host');
      description = text('填写厂商提供的完整 API 基础地址，通常以 https:// 开头。请使用 API 文档中的地址，不是官网首页；需要 /v1 的服务请保留该路径。', 'Enter the full API base URL from the provider’s documentation, usually starting with https://. Use its API endpoint, not its website homepage, and keep /v1 if required.');
      controls = next('provider-protocol', !provider?.hasHost); break;
    case 'provider-protocol':
      title = text('确认 API 协议', 'Confirm the API protocol');
      description = text('按厂商文档选择 OpenAI（Chat Completions）或 Anthropic（Messages）。地址可能自动识别协议，请确认与实际接口一致。', 'Choose OpenAI (Chat Completions) or Anthropic (Messages) according to the provider’s documentation. The address may suggest a protocol; verify it matches the actual API.');
      controls = next('provider-key', !provider?.protocol, text('已确认协议', 'Protocol confirmed')); break;
    case 'provider-key':
      title = text('填写 API Key', 'Enter the API Key');
      description = text('在 API Key 区域填写厂商给你的密钥。没有输入行时点击右侧「+」添加一行，填完后继续测试连接。', 'Enter the key supplied by the provider. If no input row is shown, click + to add one, then continue to test the connection.');
      controls = next('provider-test', !provider?.hasKey); break;
    case 'provider-test': {
      title = text('点击「测试连接」', 'Test the connection');
      description = text('点击高亮按钮，等待接口响应。返回的模型列表会自动保存；名称出现在列表中，并不代表所有能力都已经验证。', 'Click the highlighted button and wait for the response. Returned model IDs are saved automatically; appearing in the list does not mean every capability has been verified.');
      const manualModels = test?.listSupported === false || !!test?.ok && test.count === 0;
      status = snapshot?.test.busy ? text('正在测试连接，请稍候…', 'Testing the connection…') : test?.listSupported === false ? text('模型提供商不支持获取模型列表，需要手工填写模型 ID。', 'This provider does not support fetching a model list. Enter model IDs manually.') : test?.ok && test.count > 0 ? text(`提供商配置完成，已获取 ${test.count} 个模型。接下来验证模型能力。`, `Provider configured; ${test.count} models received. Verify their capabilities next.`) : test?.ok ? text('接口返回了空模型列表。请检查账号权限，或手工填写厂商提供的模型 ID。', 'The API returned an empty model list. Check account permissions or enter model IDs manually.') : test?.error || text('尚未取得成功的测试结果。', 'No successful test result yet.');
      controls = next(manualModels ? 'provider-models' : 'probe-open', !!snapshot?.test.busy || !test || (!manualModels && !test.ok), manualModels ? text('手工填写模型', 'Enter models manually') : text('验证模型能力', 'Verify model capabilities')); break;
    }
    case 'provider-models':
      title = text('手工填写模型 ID', 'Enter model IDs manually');
      description = text('在模型列表中点击「编辑」，填写厂商文档给出的准确模型 ID，按 Enter 添加，再点击「完成」。不要填写展示名称；至少添加一个模型后继续验证能力。', 'Click Edit in the model list, enter an exact model ID from the provider’s documentation, press Enter to add it, then click Done. Use IDs, not display names. Add at least one model before verifying capabilities.');
      controls = next('probe-open', !provider?.models.length); break;
    case 'probe-open':
      title = text('展开模型能力验证', 'Open model capability verification');
      description = text('点击高亮的「查看模型能力验证」。自定义提供商需要核对工具调用、视觉等能力，才能更有把握地选择全局模型。', 'Click View model capability verification. For a custom provider, check tool use, vision and other capabilities before choosing global models.');
      controls = next('probe-retry', !probe); break;
    case 'probe-retry':
      title = text('点击「重试所有未验证项」', 'Retry all unverified capabilities');
      description = text('点击高亮按钮，等待本轮验证完成。验证会实际请求提供商。已确认的能力会保留；如果未验证项为 0，可以直接继续。', 'Click the highlighted button and wait for this verification run to finish. Verification sends real requests to the provider. Confirmed results are retained; if no unverified items remain, continue directly.');
      status = probe?.error || (probe?.running ? text('模型能力验证中，请稍候…', 'Verifying model capabilities…') : !probe?.loaded ? text('正在读取验证结果…', 'Loading verification results…') : probe.pending === 0 ? text('当前没有待验证项，可以继续。', 'No unverified items remain; you can continue.') : probeReady ? text('本轮验证已结束，仍有未确认项。可查看原因并重试，或先选择已确认能力的模型。', 'This run finished with some capabilities still unknown. Review and retry them, or choose models with confirmed capabilities.') : text(`还有 ${probe.pending} 个未验证项，请点击重试。`, `${probe.pending} unverified capabilities remain. Click Retry.`));
      controls = <>{!probe && action(text('返回能力验证入口', 'Open verification'), () => navigate('probe-open'), false, false)}{next('default-model', !probeReady)}</>; break;
    case 'default-model':
      title = text('设置全局默认模型', 'Choose the global default model');
      description = text('这是日常对话、推理和执行工具的主模型。项目或对话没有单独指定模型时会继承它。请选择支持对话和工具调用的模型；能力图标可帮助判断，未知不等于支持。', 'This is the main model for conversations, reasoning and tool use. Projects and chats inherit it unless they specify another model. Choose a model that supports chat and tools; capability icons help you judge, and unknown does not mean supported.');
      controls = next('vision-model', !defaultReady || !saved); break;
    case 'vision-model':
      title = text('设置全局视觉模型', 'Choose the global vision model');
      description = text('视觉模型负责看图片、截图并提取其中的信息，主模型不能直接看图时可用于视觉处理。这里只列出已确认支持视觉的模型；同一个模型也可以同时担任默认模型和视觉模型。', 'The vision model reads images and screenshots, including when the main model cannot process images directly. Only models with confirmed vision support appear here. The same model may serve as both the default and vision model.');
      status = text('没有可选视觉模型时，可返回能力验证检查视觉项，或暂时跳过，以后再配置。', 'If no vision models are available, check vision capability verification or skip for now and configure one later.');
      controls = <>{action(text('暂不配置视觉模型', 'Skip vision for now'), () => navigate('chat'), !saved, false)}{next('chat', !visionReady || !saved, text('继续使用 Sage', 'Continue to Sage'))}</>; break;
    case 'cli-install':
      title = text('安装并配置 CLI 引擎插件', 'Install and configure a CLI engine plugin');
      description = text('在插件市场安装所需的 CLI 引擎插件并全局启用。按插件说明安装对应 CLI、完成登录或 API 配置，并确认插件能识别该 CLI；随后到「通用」选择引擎。CLI 的模型和认证由对应插件管理。', 'Install your CLI engine plugin from the plugin marketplace and enable it globally. Follow its instructions to install the CLI, sign in or configure its API, and confirm detection. Then select the engine in General. The plugin manages its CLI models and authentication.');
      controls = next('backend-engine', false, text('选择后端引擎', 'Choose the backend engine')); break;
    case 'backend-engine':
      title = text('选择 CLI 后端引擎', 'Select the CLI backend engine');
      description = text('在高亮列表中选择已安装、全局启用且配置好的 CLI 引擎。这里出现插件仅表示已安装启用，请同时确认插件配置中的 CLI 检测与登录状态。', 'Choose your installed, globally enabled and configured CLI engine. Being listed means the plugin is enabled; also confirm CLI detection and authentication in its settings.');
      controls = next('chat', !snapshot?.cliReady || !saved, text('已配置好，继续', 'Configured; continue')); break;
    case 'chat':
      title = text('新建你的第一个对话', 'Start a conversation');
      description = text('先选择一个项目文件夹，然后点击侧栏「对话」旁的「+」新建对话，输入需求并发送。项目和对话可单独选择模型；没有覆盖时使用刚设置的全局默认模型或 CLI 引擎。', 'Choose a project folder, then click + beside Conversations in the sidebar. Describe your task and send it. Projects and chats can override model choices; otherwise they use the global default or CLI engine you configured.');
      controls = <>{action(project ? text('新建对话', 'New conversation') : text('选择项目文件夹', 'Choose a project folder'), () => {
        setBusy(true); setError('');
        void (project ? useAppStore.getState().createConversation() : useAppStore.getState().pickProject()).catch(e => setError(String(e))).finally(() => setBusy(false));
      }, false, false)}{next('help', false, text('了解如何问帮助', 'Learn how to use Help'))}</>; break;
    case 'help':
      title = text('遇到问题，直接问帮助', 'Ask Help when you get stuck');
      description = text('点击左下角「?」打开帮助，在搜索框直接输入问题，例如「如何添加模型」「中继连不上怎么办」。帮助会检索本地操作文档，不需要先调用模型。以后也能从「设置 → 通用」重新打开这份引导。', 'Open Help with the ? button at the bottom-left. Type a question such as “How do I add a model?” or “Why will my relay not connect?” Help searches local documentation without a model call. Reopen this guide in Settings → General whenever needed.');
      controls = action(text('完成引导', 'Finish guide'), close); break;
  }
  return <section className="onboarding-bar" aria-label={text('新手引导', 'Setup guide')}>
    <div className="onboarding-copy"><span className="onboarding-eyebrow">{text('新引导', 'New guide')} · {route === 'relay' ? text('中继连接', 'Relay') : route === 'cli' ? text('CLI 引擎', 'CLI engine') : text('API 直连', 'Direct API')}</span><strong>{title}</strong><p>{description}</p>
      {status && <p className="onboarding-status" role="status">{status}</p>}
      {snapshot?.saving && <p role="status">{text('正在保存设置…', 'Saving settings…')}</p>}
      {(error || snapshot?.error) && <p className="onboarding-error" role="alert">{error || snapshot?.error}</p>}
    </div>
    <div className="onboarding-actions">
      {action(text('结束引导', 'Close guide'), close, false, false)}
      {history.length > 0 && action(text('上一步', 'Back'), back, false, false)}
      {(tabFor(step) || step === 'help') && action(text('定位当前操作', 'Show this step'), () => { reveal(step); setLocateRevision(n => n + 1); }, false, false)}
      {controls}
    </div>
  </section>;
}
