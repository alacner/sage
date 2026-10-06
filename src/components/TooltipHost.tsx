import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

type Tip={label:string;shortcut:string|null;anchor:DOMRect};
/** One tooltip layer for native title hints and explicit shortcut labels. */
export function TooltipHost(){
 const id=useId(),[tip,setTip]=useState<Tip|null>(null),[position,setPosition]=useState({left:0,top:0});
 const bubble=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  if(!tip||!bubble.current)return;
  const {width,height}=bubble.current.getBoundingClientRect(),{anchor}=tip;
  const left=Math.max(8,Math.min(window.innerWidth-width-8,anchor.left+(anchor.width-width)/2));
  const below=anchor.bottom+8;
  const top=below+height<=window.innerHeight-8?below:Math.max(8,anchor.top-height-8);
  setPosition({left,top});
 },[tip]);
 useEffect(()=>{
  let lastShown=0;
  let active:HTMLElement|null=null,original:string|null=null,description:Element|null=null,timer:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{
   observer.disconnect();
   clearTimeout(timer);
   if(description){const tokens=(description.getAttribute('aria-describedby')??'').split(/\s+/).filter(token=>token&&token!==id);if(tokens.length)description.setAttribute('aria-describedby',tokens.join(' '));else description.removeAttribute('aria-describedby');}
   if(active&&original!==null&&!active.hasAttribute('title'))active.setAttribute('title',original);
   active=null;original=null;description=null;setTip(null);
  };
  const show=(target:EventTarget|null,keyboard=false)=>{
   if(!(target instanceof Element))return;
   if(active?.contains(target))return;
   const element=target.closest<HTMLElement>('[data-tooltip-label],[title]');
   clear();
   if(!element)return;
   const label=element.dataset.tooltipLabel??element.getAttribute('title');
   if(!label?.trim())return;
   active=element;original=element.getAttribute('title');element.removeAttribute('title');
   observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['title']});
   timer=setTimeout(()=>{
    if(active!==element||!element.isConnected)return;
    description=keyboard?target:element;
    const existing=description.getAttribute('aria-describedby');
    description.setAttribute('aria-describedby',[existing,id].filter(Boolean).join(' '));
    lastShown=Date.now();
    setTip({label:element.dataset.tooltipLabel??original??label,shortcut:element.dataset.tooltipShortcut??null,anchor:element.getBoundingClientRect()});
   },keyboard?0:Date.now()-lastShown<1000?60:180);
  };
  const over=(event:PointerEvent)=>{if(event.pointerType!=='touch')show(event.target);};
  const out=(event:PointerEvent)=>{if(active&&(!(event.relatedTarget instanceof Node)||!active.contains(event.relatedTarget)))clear();};
  const focus=(event:FocusEvent)=>show(event.target,true);
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')clear();};
  const observer=new MutationObserver(()=>{
   if(active&&!active.isConnected){clear();return;}
   if(active?.hasAttribute('title')){original=active.getAttribute('title');active.removeAttribute('title');setTip(previous=>previous?{...previous,label:original??''}:null);}
  });
  document.addEventListener('pointerover',over,true);document.addEventListener('pointerout',out,true);
  document.addEventListener('focusin',focus,true);document.addEventListener('focusout',clear,true);
  document.addEventListener('pointerdown',clear,true);document.addEventListener('keydown',key,true);
  document.addEventListener('scroll',clear,true);window.addEventListener('resize',clear);window.addEventListener('blur',clear);
  return()=>{observer.disconnect();document.removeEventListener('pointerover',over,true);document.removeEventListener('pointerout',out,true);document.removeEventListener('focusin',focus,true);document.removeEventListener('focusout',clear,true);document.removeEventListener('pointerdown',clear,true);document.removeEventListener('keydown',key,true);document.removeEventListener('scroll',clear,true);window.removeEventListener('resize',clear);window.removeEventListener('blur',clear);clear();};
 },[id]);
 return tip?createPortal(<div ref={bubble} id={id} role="tooltip" className="app-tooltip" style={position}><span>{tip.label}</span>{tip.shortcut&&<kbd>{tip.shortcut}</kbd>}</div>,document.body):null;
}
