import {runChat} from './agent';
import {detectClaude,setBinaryOverride} from './cli';
export const apiVersion=1;
export async function detect(settings:any){setBinaryOverride(settings.binaryPath);return detectClaude();}
export async function run(options:any,settings:any){
 const status=await detect(settings);if(!status.available)return {text:'',error:status.error||'Claude CLI unavailable'};
 const prompt=[options.resume?undefined:options.history,options.prompt].filter(Boolean).join('\n\n');
 let input:any=prompt;
 if(options.images?.length){input=(async function*(){yield {type:'user',message:{role:'user',content:[...options.images.map((i:any)=>({type:'image',source:{type:'base64',media_type:i.mimeType,data:i.dataBase64}})),{type:'text',text:prompt}]},parent_tool_use_id:null,session_id:''};})();}
 return runChat({...options,prompt:input,pathToClaudeCodeExecutable:status.path});
}
