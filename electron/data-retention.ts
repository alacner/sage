import fs from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {dataRetention,validateDataRetention,type DataRetention} from '../shared/data-retention';
const cache=new Map<string,{mtime:number;size:number;value:DataRetention}>();
export function readDataRetention(userData:string):DataRetention {
  try {const file=join(userData,'settings.json'),stat=statSync(file),previous=cache.get(file);if(previous?.mtime===stat.mtimeMs&&previous.size===stat.size)return previous.value;const raw=JSON.parse(readFileSync(file,'utf8')).dataRetention??{};validateDataRetention(raw);const value=dataRetention(raw);cache.set(file,{mtime:stat.mtimeMs,size:stat.size,value});return value;}catch{return dataRetention();}
}
/** Delete only valid snapshots older than the cutoff AND beyond the newest minimum count. */
export async function cleanupHistory(directory:string,days:number,minCount:number,valid:(value:unknown)=>boolean,now=Date.now()):Promise<number> {
  let files;try{files=await fs.readdir(directory,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return 0;throw e;}
  const names=files.filter(f=>f.isFile()&&/^\d+-[a-f0-9-]+\.json$/.test(f.name)).map(f=>f.name).sort((a,b)=>Number(b.split('-')[0])-Number(a.split('-')[0]));
  let kept=0,deleted=0;
  for(const name of names){
    const file=join(directory,name);let value;try{value=JSON.parse(await fs.readFile(file,'utf8'));if(!valid(value))continue;}catch{continue;}
    if(kept++<minCount||Number(name.split('-')[0])>=now-days*86400000)continue;
    await fs.unlink(file);deleted++;
  }
  return deleted;
}
