import type {ConversationMeta} from '../../shared/types';

/** Hidden execution and archived chats remain viewable after loading their record. */
export function activeRecordExists(state: {
  activeTabId?: string;
  openTabs: {id: string; kind: string; convId?: string; specId?: string}[];
  conversations: Pick<ConversationMeta, 'id'>[];
  currentConversation?: ConversationMeta;
  currentProject?: {path: string};
  specs: {id: string}[];
}): boolean {
  const tab = state.openTabs.find(tab => tab.id === state.activeTabId);
  if (tab?.kind === 'conversation') {
    const loaded = state.currentConversation;
    return state.conversations.some(conv => conv.id === tab.convId)
      || (!!loaded && loaded.id === tab.convId && loaded.projectPath === state.currentProject?.path);
  }
  if (tab?.kind === 'spec') return state.specs.some(spec => spec.id === tab.specId);
  return true;
}
