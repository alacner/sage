import corpus from './topics.json';
export type HelpLanguage='zh'|'en';
export type HelpTopic={id:string;group:string;title:string;summary:string;content:string;keywords:string};
export type HelpPassage={topic:HelpTopic;index:number;heading:string;text:string;score:number;direct:boolean};
export function helpTopics(language:HelpLanguage):HelpTopic[]{return corpus.map(r=>({id:r.id,...r[language],keywords:r.keywords}));}
const synonyms=[
 ['断网','联网','下载','network','internet','offline','download','dns','npm','curl','socket'],
 ['中断','续跑','恢复执行','断点','重启','resume','restart','interrupted','checkpoint'],
 ['清理','空间','日志','保留','cleanup','retention','history','audit','decisions'],
 ['调试','debug','请求','监控','monitor','request','response'],
 ['飞书','长连接','实时','websocket','feishu','streaming'],
 ['插件','开发目录','plugin','manifest','slot'],
 ['截屏','截图','screenshot','capture'],
 ['按住','听写','麦克风','语音','dictation','microphone','voice'],
 ['定时','继承','任务授权','schedule','scheduled','inherit'],
 ['拉取','推送','分支','冲突','fetch','pull','push','conflict','upstream'],
 ['二次开发','扩展开发','sdk','scaffold','extension'],
 ['审批','批准','授权','approval','permission','sandbox','沙箱'],
];
const stop=new Set(['the','a','an','is','are','how','can','i','to','do','my','in','of','and','for','with','what']);
function tokens(text:string):string[]{
 const lower=text.toLowerCase();const english=(lower.match(/[a-z0-9][a-z0-9._-]*/g)??[]).filter(t=>!stop.has(t));
 const chinese=(lower.match(/[\u3400-\u9fff]+/g)??[]).flatMap(s=>s.length<2?[s]:Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)));
 return [...english,...chinese];
}
export function helpPassages(topics:HelpTopic[]):HelpPassage[]{return topics.flatMap(topic=>topic.content.split(/\n(?=## )/).map((text,index)=>({topic,index,heading:text.split('\n')[0].replace(/^#+\s*/,''),text,score:0,direct:false})));}
type SearchIndex={passages:HelpPassage[];docs:Array<{terms:Map<string,number>;length:number;heading:Set<string>}>;df:Map<string,number>;avg:number};
const indexes=new WeakMap<HelpTopic[],SearchIndex>();
function indexFor(topics:HelpTopic[]):SearchIndex {
 const existing=indexes.get(topics);if(existing)return existing;
 const passages=helpPassages(topics),df=new Map<string,number>();
 const docs=passages.map(p=>{
  const terms=new Map<string,number>(),words=tokens(p.text+' '+p.topic.title+' '+p.topic.keywords);
  for(const term of words)terms.set(term,(terms.get(term)??0)+1);
  for(const term of terms.keys())df.set(term,(df.get(term)??0)+1);
  return {terms,length:words.length,heading:new Set(tokens(p.heading))};
 });
 const index={passages,docs,df,avg:docs.reduce((n,d)=>n+d.length,0)/Math.max(1,docs.length)};indexes.set(topics,index);return index;
}
/** Cached local BM25; corpus statistics are built once, never sent to a model or remote service. */
export function searchHelp(topics:HelpTopic[],query:string):HelpPassage[]{
 const q=query.trim().toLowerCase().slice(0,1000);if(!q)return [];
 const original=tokens(q);const extra=synonyms.filter(group=>group.some(term=>/^[a-z]/.test(term)?original.includes(term):q.includes(term))).flatMap(group=>group.flatMap(tokens));
 const weights=new Map<string,number>();for(const term of extra)weights.set(term,.3);for(const term of original)weights.set(term,1);
 const {passages,docs,df,avg}=indexFor(topics);
 return passages.map((p,i)=>{let score=0;for(const [term,weight] of weights){const frequency=docs[i].terms.get(term)??0;if(!frequency)continue;const idf=Math.log(1+(docs.length-(df.get(term)??0)+.5)/((df.get(term)??0)+.5));score+=weight*idf*frequency*2.2/(frequency+1.2*(.25+.75*docs[i].length/avg));if(docs[i].heading.has(term))score+=weight*1.5;}
 const direct=(p.text+' '+p.topic.title).toLowerCase().includes(q);if(direct)score+=20;return {...p,score,direct};}).filter(p=>p.score>1).sort((a,b)=>b.score-a.score||a.topic.id.localeCompare(b.topic.id)||a.index-b.index).slice(0,12);
}
