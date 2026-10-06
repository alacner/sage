import {createHash} from 'node:crypto';
import type {ChatMessage} from '../shared/types';
/** Include tool outcomes: edits/retries invalidate stale CLI context. Pending is a UI flag. */
export function engineHistoryFingerprint(messages:ChatMessage[]){
 return createHash('sha256').update(JSON.stringify(messages.filter(m=>!m.queued&&!m.contextCompaction).map(m=>({id:m.id,content:m.content,visionContent:m.visionContent,images:m.images,toolCalls:m.toolCalls})))).digest('hex');
}
export function engineHistoryContext(messages:ChatMessage[]){
 return messages.map(m=>`${m.role}: ${m.visionContent ?? m.content}${m.images?.length?'\nImage attachments: '+m.images.map(i=>i.name).join(', '):''}${m.toolCalls?.length?'\nTool activity (reference only; an interrupted action may already have taken effect, inspect before retrying): '+JSON.stringify(m.toolCalls):''}`).join('\n\n');
}
