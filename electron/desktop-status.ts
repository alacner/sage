import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { app } from 'electron';

type Counter={idle:number;total:number;count:number;model:string};
function cpuCounter():Counter{
  const cpus=os.cpus();return {count:cpus.length,model:cpus[0]?.model??'unknown',idle:cpus.reduce((n,c)=>n+c.times.idle,0),total:cpus.reduce((n,c)=>n+Object.values(c.times).reduce((a,b)=>a+b,0),0)};
}
/** Interval counters, rather than the old average since the host booted. */
export class DesktopCpuSampler{
  private previous?:{counter:Counter;at:number};
  private pending?:Promise<{model:string;count:number;idlePercent:number|null;sampleDurationMs:number}>;
  constructor(private counter=cpuCounter,private now=()=>performance.now(),private wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){}
  sample(){
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      let before=this.previous,counter=this.counter(),at=this.now();
      if(!before||counter.count!==before.counter.count||at-before.at<100||counter.total<before.counter.total||counter.idle<before.counter.idle){
        before={counter,at};await this.wait(250);counter=this.counter();at=this.now();
      }
      this.previous={counter,at};
      const total=counter.total-before.counter.total,idle=counter.idle-before.counter.idle;
      return {model:counter.model,count:counter.count,idlePercent:counter.count===before.counter.count&&total>0&&idle>=0&&idle<=total?Math.round(idle/total*100):null,sampleDurationMs:Math.max(0,Math.round(at-before.at))};
    })().finally(()=>{this.pending=undefined;});return this.pending;
  }
}
const cpuSampler=new DesktopCpuSampler();
export async function sampleDesktopStatus(){
  const mem=process.memoryUsage(),cpu=await cpuSampler.sample(),total=os.totalmem(),free=os.freemem();
  let storage:{totalBytes:number;availableBytes:number;usedPercent:number}|null=null;
  try{
    const info=await statfs(app.getPath('userData')),totalBytes=info.bsize*info.blocks,availableBytes=info.bsize*info.bavail,usedBytes=info.bsize*(info.blocks-info.bfree);
    if([totalBytes,availableBytes,usedBytes].every(Number.isFinite)&&totalBytes>0&&availableBytes>=0&&usedBytes>=0&&availableBytes<=totalBytes&&usedBytes<=totalBytes)storage={totalBytes,availableBytes,usedPercent:Math.round(100*usedBytes/totalBytes)};
  }catch{/* Unknown capacity stays unavailable, never zero. */}
  return {sampledAt:Date.now(),uptimeSec:Math.floor(process.uptime()),systemUptimeSec:Math.floor(os.uptime()),platform:process.platform,arch:process.arch,hostname:os.hostname(),nodeVersion:process.version,
    memory:{rssMB:Math.round(mem.rss/1048576),heapUsedMB:Math.round(mem.heapUsed/1048576),heapTotalMB:Math.round(mem.heapTotal/1048576),systemFreeMB:Math.round(free/1048576),systemTotalMB:Math.round(total/1048576)},cpu,loadAverage:process.platform==='win32'?[]:os.loadavg(),storage};
}
