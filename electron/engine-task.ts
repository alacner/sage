import {runEngine,selectedEngine} from './engine-registry';
import { readSettings } from './main';
import { autoApproveProjectTool } from './project-scope';
import { decideCommand } from './sandbox/command-decision';
import type { RunClaudeOptions, RunClaudeResult } from './claude-bridge';
import type { ConversationMeta } from '../shared/types';

/** Spec planning is read-only; execution still uses Sage's command policy. */
export async function runEngineTask(opts:RunClaudeOptions):Promise<RunClaudeResult> {
  const engine=await selectedEngine();
  const result=await runEngine(engine,{cwd:opts.cwd,prompt:opts.prompt,
    readOnly:opts.permissionMode==='plan',signal:opts.signal,monitor:opts.monitor,onText:opts.onText,
    // Session IDs are scoped to their engine.
    resume:opts.resumeSessionId?.startsWith(engine+':')?opts.resumeSessionId.slice(engine.length+1):undefined,
    onSessionId:id=>opts.onSessionId?.((engine+':')+id),
    onToolUse:info=>opts.onTool?.({...info,phase:'use'}),onToolResult:info=>opts.onTool?.({id:info.id,name:'',result:info.result,phase:'result'}),
    canUseTool:async(name,input,ctx)=>{
      name=name.replace(/^mcp__sage__/, '');
      if(opts.permissionMode==='plan'&&!['Read','Glob','Grep','Skill','RecallMemory'].includes(name))return {behavior:'deny',message:'Read-only planning'};
      if(name==='Bash') {
        const decision=await decideCommand(input,{id:opts.monitor?.convId??'engine-task',projectPath:opts.cwd} as ConversationMeta,ctx.signal);
        return decision.decision==='allow'?{behavior:'allow',updatedInput:decision.input}:{behavior:'deny',message:decision.reason};
      }

      if (['Read','Glob','Grep','Skill','RecallMemory'].includes(name) || await autoApproveProjectTool(name,input,opts.cwd,readSettings)) return {behavior:'allow',updatedInput:input};
      return {behavior:'deny',message:'This task requires approval. Use the conversation to approve this operation.'};
    }});
  return {...result,sessionId:result.sessionId?(engine+':')+result.sessionId:undefined,exitCode:result.error?1:0};
}
