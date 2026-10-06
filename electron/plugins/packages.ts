import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Script} from 'node:vm';
import { hostExtensionPoints, hostEvents } from '../../shared/plugins/extensions';
import { SDK_VERSION, HOOK_PERMISSION, manifestSchema, assertJson, checkSchema, type PluginPackage, type PluginBundle } from '../../shared/plugins/contract';
import { DEFAULT_RUNTIME_CONFIG, runtimeConfig } from '../../shared/runtime-config';
let maxPackageBytes = DEFAULT_RUNTIME_CONFIG.maxPluginPackageBytes;
/** Update the package guard when the user changes unified runtime settings. */
export function setPluginPackageLimit(value: number) {
 maxPackageBytes = runtimeConfig({maxPluginPackageBytes:value}).maxPluginPackageBytes;
}
export function stable(v:any):string {return JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);}
export function digest(v:unknown){return crypto.createHash('sha256').update(stable(v)).digest('hex');}
const cmp=(a:string,b:string)=>{const aa=a.split('.').map(Number),bb=b.split('.').map(Number);return aa[0]-bb[0]||aa[1]-bb[1]||aa[2]-bb[2];};
/** Stable SemVer subset: exact, *, ^, ~, and whitespace-separated comparators. */
export function satisfies(v:string,range:string):boolean {
 if(!/^\d+\.\d+\.\d+$/.test(v))throw Error('Stable semantic version required');
 if(range==='*')return true;
 return range.trim().split(/\s+/).every(term=>{
 const m=/^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(term);if(!m)throw Error(`Unsupported version range: ${range}`);
 const op=m[1]??'=',base=m[2],n=cmp(v,base),[a,b,c]=base.split('.').map(Number);
 if(op==='^'||op==='~'){const upper=op==='~'?`${a}.${b+1}.0`:a?`${a+1}.0.0`:b?`0.${b+1}.0`:`0.0.${c+1}`;return n>=0&&cmp(v,upper)<0;}
 return op==='='?n===0:op==='>='?n>=0:op==='<='?n<=0:op==='>'?n>0:n<0;
 });
}
function parseManifest(raw:unknown){
 const result=manifestSchema.safeParse(raw);
 if(result.success)return result.data;
 const details=result.error.issues.map(issue=>{
  const field=issue.path.join('.');
  const actual=issue.path.reduce((v:any,key)=>v?.[key],raw as any);
  return `${field}: ${JSON.stringify(actual)??'未填写'} — ${issue.message}`;
 }).join('\n');
 throw Error(`sage.plugin.json 配置无效，请修改后重新加载：\n${details}`);
}
export function verifyPackage(raw:any):PluginPackage {
 assertJson(raw);const m=parseManifest(raw.manifest);
 if(!satisfies(SDK_VERSION,m.sdk))throw Error(`${m.id}: incompatible SDK ${m.sdk}`);
 for(const r of [...Object.values(m.dependencies),...Object.values(m.optionalDependencies),...Object.values(m.hostDependencies),...m.consumes.map(c=>c.version)])satisfies('1.0.0',r);
 if(!raw.files||typeof raw.files!=='object'||Array.isArray(raw.files)||Object.keys(raw.files).length>100)throw Error('Invalid files');
 for(const [file,content] of Object.entries(raw.files)){
  if(!/^(plugin\.js|engine\.js|README\.md|LICENSE|views\/[a-zA-Z0-9_-]+\.html|assets\/[a-zA-Z0-9_.-]+|skills\/[A-Za-z0-9_.-]+\.md)$/.test(file)||typeof content!=='string')throw Error(`Invalid package file: ${file}`);
 }
 if(typeof raw.files['plugin.js']!=='string')throw Error('plugin.js missing');
 new Script(raw.files['plugin.js'],{filename:m.id+'/plugin.js'});
 if(m.engine){if(!m.permissions.includes('engine.native'))throw Error('Engine plugins must declare engine.native');if(typeof raw.files['engine.js']!=='string')throw Error('engine.js missing');new Script(raw.files['engine.js'],{filename:m.id+'/engine.js'});}
 for(const f of Object.values(m.settings))if(f.default!==undefined&&typeof f.default!==f.type)throw Error('Setting default does not match type');
 const names=new Set();for(const c of m.contributes){if(names.has(c.id))throw Error('Duplicate contribution ID');names.add(c.id);if(c.view&&!Object.hasOwn(raw.files,c.view))throw Error('Missing view');if(!c.view&&!(c.service&&c.method))throw Error('Contribution needs view or command');if(c.service&&!m.services[c.service]?.methods[c.method??''])throw Error('Unknown contribution method');}
 // 钩子订阅（插件类型之一）：必须显式申请 hooks.respond，只能指向自己已声明的服务方法，
 // matcher 必须能编译（无效正则在运行时会被当成普通字符处处理，静默改变拦截范围不可接受）。
 if(m.hooks.length&&!m.permissions.includes(HOOK_PERMISSION))throw Error(`${m.id}: hooks subscriptions require the ${HOOK_PERMISSION} permission`);
 const hookIds=new Set();for(const h of m.hooks){
  if(hookIds.has(h.id))throw Error(`Duplicate hook ID: ${h.id}`);hookIds.add(h.id);
  if(!m.services[h.service]?.methods[h.method])throw Error(`Hook ${h.id}: unknown service method ${h.service}/${h.method}`);
  if(h.matcher!==undefined){try{new RegExp(h.matcher);}catch{throw Error(`Hook ${h.id}: invalid matcher`);}}
 }
 for(const s of Object.values(m.services))for(const method of Object.values(s.methods)){checkSchema(method.input);if(method.output)checkSchema(method.output);}
 const extensionIds=new Set<string>();
 for(const s of m.skills)if(typeof raw.files[s.file]!=='string')throw Error(`Missing skill: ${s.file}`);
 for(const p of m.extensionPoints??[]){if(extensionIds.has(p.id))throw Error('Duplicate extension point');extensionIds.add(p.id);checkSchema(p.input);checkSchema(p.output);}
 extensionIds.clear();
 for(const e of m.extensions??[]){
  if(extensionIds.has(e.id))throw Error('Duplicate extension handler');extensionIds.add(e.id);
  if(!m.services[e.service]?.methods[e.method])throw Error('Unknown extension handler method');
  satisfies('1.0.0',e.version);
  const owner=e.point.split('/')[0];
  if(owner==='sage'){const p=hostExtensionPoints[e.point as keyof typeof hostExtensionPoints];if(!p||!m.permissions.includes(p.permission))throw Error(`Unknown or unauthorized extension: ${e.point}`);}
  else if(owner!==m.id&&!Object.hasOwn(m.dependencies,owner))throw Error('Extension point owner must be a required dependency');
 }
 for(const e of m.events??[]){
  if(!m.permissions.includes('events.subscribe'))throw Error('Events require events.subscribe');
  if(!m.services[e.service]?.methods[e.method])throw Error('Unknown event handler method');
  const owner=e.event.split('/')[0];
  if(owner==='sage'&&!(hostEvents as readonly string[]).includes(e.event))throw Error('Unknown host event');
  if(owner!=='sage'&&owner!==m.id&&!Object.hasOwn(m.dependencies,owner))throw Error('Event owner must be a required dependency');
 }
 for(const c of m.consumes)if(c.plugin!==m.id&&!Object.hasOwn(m.dependencies,c.plugin)&&!Object.hasOwn(m.optionalDependencies,c.plugin))throw Error('Service dependency must be declared');
 const body={manifest:m,files:raw.files};const hash=digest(body);
 // The normalized manifest has evolved while the package format remains at
 // version 1.  Older packages were checksummed before newly added default
 // fields (for example `skills: []`) were materialized by Zod.  Requiring the
 // new digest would make every previously installed package look corrupted on
 // the next startup.  Accept the digest of the validated source manifest as
 // a one-way compatibility path, then return the current normalized package
 // and digest so the next registry write migrates it forward.
 const sourceHash=digest({manifest:raw.manifest,files:raw.files});
 // Packages installed before hostDependencies (and, for some users, before
 // skills) was added were hashed after the then-current schema defaults had
 // been materialized.  Recreate those two historical shapes explicitly so a
 // schema-only upgrade can be migrated without accepting a changed file.
 const legacyManifest={...m};delete (legacyManifest as any).hostDependencies;
 const legacyHash=digest({manifest:legacyManifest,files:raw.files});
 const legacyPreSkills={...legacyManifest};delete (legacyPreSkills as any).skills;
 const legacyPreSkillsHash=digest({manifest:legacyPreSkills,files:raw.files});
 // 再加一种钩子订阅字段时同样只影响新装包：已存量的 normalized manifest 不带 hooks，
 // 旧 digest 经 sourceHash / legacyHash 两条路径仍被接受，下次写入才迁移到新值。
 const acceptedHashes=new Set([hash,sourceHash,legacyHash,legacyPreSkillsHash]);
 if(raw.digest!==undefined&&!acceptedHashes.has(raw.digest))throw Error(`${m.id}: checksum mismatch`);
 if(Buffer.byteLength(JSON.stringify(body))>maxPackageBytes)throw Error(`Package exceeds ${Math.round(maxPackageBytes/1024/1024)} MB`);
 return {...body,digest:hash};
}
export function parseBundle(text:string):PluginBundle {
 if(Buffer.byteLength(text)>maxPackageBytes*4)throw Error(`Bundle exceeds ${Math.round(maxPackageBytes*4/1024/1024)} MB`);
 const b=JSON.parse(text);assertJson(b);
 if(b.format!=='sageplugin'||b.version!==1||!Array.isArray(b.packages)||!b.packages.length||b.packages.length>32||!Array.isArray(b.roots)||!b.roots.length)throw Error('Invalid bundle');
 const packages=b.packages.map((p:any)=>{if(typeof p.digest!=='string')throw Error('Missing checksum');return verifyPackage(p);});
 if(new Set(packages.map((p:PluginPackage)=>p.manifest.id)).size!==packages.length)throw Error('Duplicate package ID');
 if(b.roots.some((id:any)=>!packages.some((p:PluginPackage)=>p.manifest.id===id)))throw Error('Missing root package');
 return {format:'sageplugin',version:1,packages,roots:[...new Set(b.roots)] as string[]};
}
export async function packDirectory(dir:string):Promise<PluginPackage>{
 const files:Record<string,string>=Object.create(null);
 const root=await fs.realpath(dir);
 async function read(relative:string){const full=path.join(root,relative),stat=await fs.lstat(full);const resolved=await fs.realpath(full);if(!resolved.startsWith(root+path.sep))throw Error('Package path escapes project');if(stat.isSymbolicLink())throw Error('Symlinks are not packaged');if(!stat.isFile()||stat.size>maxPackageBytes)throw Error('Invalid file');files[relative]=await fs.readFile(full,'utf8');}
 const manifestFile=path.join(root,'sage.plugin.json');const manifestStat=await fs.lstat(manifestFile);if(manifestStat.isSymbolicLink()||manifestStat.size>256*1024)throw Error('Invalid manifest file');
 const manifest=parseManifest(JSON.parse(await fs.readFile(manifestFile,'utf8')));
 for(const file of ['plugin.js','engine.js','README.md','LICENSE']){try{await read(file);}catch(e:any){if(e.code!=='ENOENT'||file==='plugin.js')throw e;}}
 for(const folder of ['views','assets','skills']){const entries=await fs.readdir(path.join(root,folder)).catch((e:any)=>{if(e.code==='ENOENT')return [];throw e;});for(const file of entries)await read(`${folder}/${file}`);}
 return verifyPackage({manifest,files});
}
export function resolveGraph(packages:Map<string,PluginPackage>,roots:string[]):string[]{
 const order:string[]=[],active:string[]=[];const done=new Set<string>();
 function visit(id:string){if(done.has(id))return;if(active.includes(id))throw Error(`Dependency cycle: ${[...active,id].join(' → ')}`);const p=packages.get(id);if(!p)throw Error(`Missing dependency: ${[...active,id].join(' → ')}`);active.push(id);
 for(const [dep,range] of Object.entries({...p.manifest.optionalDependencies,...p.manifest.dependencies})){
 const q=packages.get(dep);if(!q&&!Object.hasOwn(p.manifest.dependencies,dep))continue;
 if(q&&!satisfies(q.manifest.version,range))throw Error(`Version conflict: ${[...active,dep].join(' → ')} needs ${range}, installed ${q.manifest.version}`);visit(dep);}
 for(const c of p.manifest.consumes){const q=packages.get(c.plugin);if(!q&&Object.hasOwn(p.manifest.optionalDependencies,c.plugin))continue;const service=q?.manifest.services[c.service];if(!service||!satisfies(service.version,c.version))throw Error(`${id}: incompatible service ${c.plugin}/${c.service}@${c.version}`);}
 for(const e of p.manifest.extensions??[]){const [owner,name]=e.point.split('/');const point=owner==='sage'?hostExtensionPoints[e.point as keyof typeof hostExtensionPoints]:packages.get(owner)?.manifest.extensionPoints?.find(p=>p.id===name);if(!point||!satisfies(point.version,e.version))throw Error(`${id}: incompatible extension point ${e.point}@${e.version}`);}
 active.pop();done.add(id);order.push(id);}
 roots.forEach(visit);return order;
}
