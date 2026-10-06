import type { ImageAttachment } from '../../shared/types';

interface DraftSnapshot {
  text: string;
  images: ImageAttachment[];
  pastedTexts?: Array<{ id: string; text: string }>;
  /** File decoding/selection has begun, even if its async preview has not completed. */
  attachmentIntent?: boolean;
}
const readers = new Map<string, () => DraftSnapshot>();

/** Read the mounted composer's current ref without rerendering the store on each keypress. */
export function registerConversationDraftReader(id: string, reader: () => DraftSnapshot): () => void {
  readers.set(id, reader);
  return () => { if (readers.get(id) === reader) readers.delete(id); };
}
export function mountedConversationDraft(id: string): DraftSnapshot | undefined {
  return readers.get(id)?.();
}
export function hasConversationDraft(draft: DraftSnapshot | undefined): boolean {
  return !!draft && (draft.text.length > 0 || draft.images.length > 0 || !!draft.pastedTexts?.length || draft.attachmentIntent === true);
}
