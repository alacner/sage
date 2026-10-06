import {resolveLanguage} from '../../shared/language';
import {useAppStore} from '../stores/appStore';

export function ModelSetupNotice({error}: {error?: string}) {
  const settings = useAppStore(s => s.settings);
  const project = useAppStore(s => s.currentProject);
  const conversation = useAppStore(s => s.currentConversation);
  const en = resolveLanguage(settings?.language,settings?._systemLocale) === 'en';
  const backend = settings?.backendEngine ?? 'api';
  const selected = [conversation?.selectedModel, project?.selectedModel, settings?.selectedModel];
  const available = selected.some(model => model && settings?.modelProviders?.some(provider =>
    provider.id === model.providerId && provider.enabled !== false && provider.models.includes(model.modelId)));
  const configurationError = error && /尚未配置可用的 API 模型|No.*(?:model|engine).*configured|Engine plugin (?:missing|disabled|not enabled|not installed|is not installed)|CLI.*(?:not found|未找到)|ENOENT/i.test(error);
  if (error ? !configurationError : !settings || backend !== 'api' || available || settings.anthropicApiKey || settings.defaultModelProfileId || project?.modelProfileId || conversation?.modelProfileId) return null;
  return <section className="model-setup-notice" role="alert">
    <strong>{en ? 'Configure an execution engine to start chatting' : '请先配置执行引擎，再开始对话'}</strong>
    <p>{en ? 'Add a model provider and select a global default model, or install and enable a CLI engine plugin, then select it in General.' : '添加模型提供商并选择全局默认模型，或安装并启用 CLI 引擎插件，再到「通用」中选择该引擎。'}</p>
    <div><button className="btn-primary" onClick={async () => {try {if(backend!=='api')await useAppStore.getState().saveSettings({backendEngine:'api'});window.dispatchEvent(new CustomEvent('sage:onboarding:open', {detail:{step:1}}));}catch(e){useAppStore.getState().setBanner(String(e));}}}>{en ? 'Set up a model' : '配置模型'}</button>
      <button onClick={() => useAppStore.getState().openSettingsTab({initialTab:'plugins'})}>{en ? 'Install a CLI engine' : '安装 CLI 引擎'}</button>
      {backend !== 'api' && <button onClick={() => useAppStore.getState().openSettingsTab({initialTab:'general'})}>{en ? 'Choose an engine' : '选择执行引擎'}</button>}
    </div>
  </section>;
}
