import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {safeJoin} from './files';
import {changedLines,type FileChange} from '../shared/file-changes';
const exec=promisify(execFile);
const MAX_FILES=150,MAX_BYTES=512*1024;
async function git(root:string,args:string[]){return(await exec('git',['-c','core.quotepath=false',...args],{cwd:root,timeout:5000,maxBuffer:4*1024*1024})).stdout;}
type Snapshot={head?:string;files:Map<string,string|undefined>;root:string};
async function dirty(root:string){
 const [modified,untracked]=await Promise.all([git(root,['diff','--name-only','-z','HEAD']).catch(()=>git(root,['diff','--cached','--name-only','-z'])),git(root,['ls-files','--others','--exclude-standard','-z'])]);
 return [...new Set((modified+'\0'+untracked).split('\0').filter(Boolean))];
}
async function read(root:string,file:string):Promise<string|undefined>{
 try{const abs=safeJoin(root,file),stat=await fs.lstat(abs);if(!stat.isFile()||stat.size>MAX_BYTES)return;const real=await fs.realpath(abs);safeJoin(root,real);return await fs.readFile(abs,'utf8');}catch(error:any){if(error.code==='ENOENT')return '';return;}
}
/** Observe shell writes without changing the index/checkout or including pre-existing edits. */
export async function snapshotToolFiles(root:string):Promise<Snapshot|undefined>{
 try{
  // Only operate at an actual repository root; nested projects must not observe their parent.
  const real=await fs.realpath(root);if((await git(real,['rev-parse','--show-toplevel'])).trim()!==real)return;
  const paths=await dirty(real);if(paths.length>MAX_FILES)return;
  const head=await git(real,['rev-parse','--verify','HEAD']).then(s=>s.trim(),()=>undefined);
  return{root:real,head,files:new Map(await Promise.all(paths.map(async p=>[p,await read(real,p)] as const)))};
 }catch{return;}
}
export async function finishToolFiles(snapshot:Snapshot|undefined):Promise<FileChange[]|undefined>{
 if(!snapshot)return;
 try{
  const {root,head}=snapshot;const changed=head?await git(root,['diff','--name-only','-z',head,'HEAD']).catch(()=>''):'';
  const paths=[...new Set([...snapshot.files.keys(),...await dirty(root),...changed.split('\0').filter(Boolean)])];if(paths.length>MAX_FILES)return;
  const results:FileChange[]=[];
  for(const path of paths){
   let before=snapshot.files.get(path);
   if(!snapshot.files.has(path))before=head?await git(root,['show',`${head}:${path}`]).catch(async()=>{const exists=await git(root,['cat-file','-e',`${head}:${path}`]).then(()=>true,()=>false);return exists?undefined:'';}):'';
   const after=await read(root,path);if(before===undefined||after===undefined||before===after)continue;
   results.push({path,...changedLines(before,after)});
  }
  return results;
 }catch{return;}
}
