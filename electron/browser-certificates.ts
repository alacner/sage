import type {WebContents} from 'electron';
const managed=new Set<number>();
const approved=new Set<string>();
export function registerCertificateBrowser(contents:WebContents){managed.add(contents.id);contents.once('destroyed',()=>managed.delete(contents.id));}
export function isPrivateCertificateTarget(value:string){
 try{
  const url=new URL(value);if(url.protocol!=='https:')return false;
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')||host==='::1')return true;
  if(/^(fc|fd)[0-9a-f]{2}:/.test(host)||/^fe[89ab][0-9a-f]:/.test(host))return true;
  const parts=host.split('.').map(Number);
  if(parts.length!==4||!parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255))return false;
  return parts[0]===127||parts[0]===10||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]>=16&&parts[1]<=31||parts[0]===169&&parts[1]===254;
 }catch{return false;}
}
export function approveBrowserCertificate(origin:string){try{const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)return false;approved.add(origin);return true;}catch{return false;}}
/** preventDefault must run before any async settings read; otherwise Chromium rejects immediately. */
export function handleBrowserCertificate(event:{preventDefault:()=>void},contents:Pick<WebContents,'id'|'getType'>,url:string,callback:(allowed:boolean)=>void,ignoreErrors:()=>Promise<boolean|{ignoreAll:boolean;ignoreLocal:boolean}>){
 if(contents.getType()!=='webview'&&!managed.has(contents.id)){callback(false);return;}
 event.preventDefault();
 let origin:string;try{origin=new URL(url).origin;}catch{callback(false);return;}
 if(approved.has(origin)){callback(true);return;}
 void ignoreErrors().then(policy=>{const flags=typeof policy==='boolean'?{ignoreAll:policy,ignoreLocal:true}:policy;callback(flags.ignoreAll||flags.ignoreLocal&&isPrivateCertificateTarget(url));},()=>callback(false));
}
