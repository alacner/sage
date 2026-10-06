export interface SidebarLayout {collapsed:Record<string,boolean>;sizes:Record<string,number>;width:number;hidden:boolean;pinnedConversations?:string[];order?:string[];scrolls?:Record<string,number>;}
export function readSidebarLayout(projectPath?:string):SidebarLayout{
 const fallback:SidebarLayout={collapsed:{},sizes:{},width:240,hidden:false};
 if(!projectPath)return fallback;
 try{
  const saved=JSON.parse(localStorage.getItem('sidebarLayout:'+projectPath)??'{}');
  const collapsed=Object.fromEntries(Object.entries(saved.collapsed??{}).filter(([,value])=>typeof value==='boolean')) as Record<string,boolean>;
  const sizes=Object.fromEntries(Object.entries(saved.sizes??{}).filter(([,value])=>typeof value==='number'&&Number.isFinite(value)&&value>0)) as Record<string,number>;
  const pins=Array.isArray(saved.pinnedConversations)?saved.pinnedConversations.filter((id:unknown)=>typeof id==='string'):undefined;
  const order=Array.isArray(saved.order)?[...new Set<string>(saved.order.filter((id:unknown)=>typeof id==='string'))]:undefined;
  const scrolls=Object.fromEntries(Object.entries(saved.scrolls??{}).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)&&v>=0)) as Record<string,number>;
  return{...(order?{order}:{}),...(Object.keys(scrolls).length?{scrolls}:{}),...(pins?{pinnedConversations:[...new Set<string>(pins)]}:{}),collapsed,sizes,width:typeof saved.width==='number'&&Number.isFinite(saved.width)&&saved.width>0?saved.width:240,hidden:saved.hidden===true};
 }catch{return fallback;}
}
export function writeSidebarLayout(projectPath:string|undefined,patch:Partial<SidebarLayout>):SidebarLayout{
 const next={...readSidebarLayout(projectPath),...patch};
 if(projectPath)try{localStorage.setItem('sidebarLayout:'+projectPath,JSON.stringify(next));}catch{/* Layout remains usable when persistence is unavailable. */}
 return next;
}

export function sidebarOrder(saved:string[]|undefined,available:string[]):string[]{return [...new Set([...(saved??[]),...available])];}
export function moveSidebarSection(order:string[],source:string,target:string,after=false):string[]{
 if(source===target||!order.includes(source)||!order.includes(target))return order;
 const next=order.filter(id=>id!==source);next.splice(next.indexOf(target)+(after?1:0),0,source);return next;
}
