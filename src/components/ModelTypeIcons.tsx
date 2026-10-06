import {EffortIcon} from './EffortIcon';
import { Eye, Globe, Lightbulb, Wrench, ListOrdered, createLucideIcon } from 'lucide-react';
import { MODEL_TYPES, THINKING_EFFORTS, type ModelType, type ModelTypeCaps } from '../../shared/model-types';
import { translate } from '../i18n';

const EmbeddingIcon = createLucideIcon('Embedding', [
  ['rect', { x: '5', y: '5', width: '14', height: '14', rx: '2', key: 'chip' }],
  ['path', { d: 'M8 2v3m4-3v3m4-3v3M8 19v3m4-3v3m4-3v3M2 8h3m-3 4h3m-3 4h3m14-8h3m-3 4h3m-3 4h3', key: 'pins' }],
  ['path', { d: 'm9.5 9.5-2 2.5 2 2.5m5-5 2 2.5-2 2.5m-2-6-1 7', key: 'code' }],
]);

export const modelTypeIcons = { vision: Eye, webSearch: Globe, reasoning: Lightbulb, tool: Wrench, reranker: ListOrdered, embedding: EmbeddingIcon };
export const modelTypeLabel = (type: ModelType) => translate(`modelType.${type}`);

export function ModelTypeIcons({ caps }: { caps: ModelTypeCaps }) {
  return <span className="model-type-icons">{MODEL_TYPES.filter(type => caps[type] === true).map(type => {
    const Icon = modelTypeIcons[type];
    return <span key={type} className={`model-type-icon ${type}`} title={modelTypeLabel(type)} aria-label={modelTypeLabel(type)} data-model-type={type}><Icon size={13} aria-hidden="true" /></span>;
  })}{THINKING_EFFORTS.filter(e=>caps[`thinking:${e}`]===true).map(e=><span key={e} className="model-type-icon thinking-effort" data-thinking-effort={e} title={`${translate('chat.thinkingEffort.label')}: ${e}`} aria-label={`${translate('chat.thinkingEffort.label')}: ${e}`}><EffortIcon effort={e}/></span>)}</span>;
}
