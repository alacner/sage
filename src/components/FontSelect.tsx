import { isTextFontFamily } from '../../shared/font-family';
import { placeCursorMenu } from '../../shared/popover-placement';
import { Fragment, useLayoutEffect, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, Pencil } from 'lucide-react';
import { useT } from '../i18n';
import './font-select.css';

type Item = { value: string; label: string; preview?: string; group?: string };
export function FontMenu({ value, items, onChange, searchable = false, loading = false, label }: {value:string;items:Item[];onChange:(value:string)=>void;searchable?:boolean;loading?:boolean;label:string}) {
  const t = useT();
  const [open,setOpen] = useState(false);
  const [search,setSearch] = useState('');
  const [custom,setCustom] = useState(false);
  const [position,setPosition] = useState({left:0,top:0,width:300,maxHeight:400});
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); anchor.current?.focus(); };
  useLayoutEffect(()=>{
    if (!open) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const width = Math.min(searchable ? 440 : r.width, window.innerWidth-24);
      const height = menu.current?.getBoundingClientRect().height ?? 0;
      const placement = placeCursorMenu(r.left, r.bottom + 4, { width, height }, { width: window.innerWidth, height: window.innerHeight }, { aboveY: r.top });
      setPosition({ left: placement.left, top: placement.top, width, maxHeight: Math.min(searchable ? 420 : 220, placement.maxHeight) });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    if (menu.current) observer?.observe(menu.current);
    const outside = (e:PointerEvent) => {if(!menu.current?.contains(e.target as Node)&&!anchor.current?.contains(e.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    window.addEventListener('resize',place);
    window.addEventListener('scroll',place,true);
    return ()=>{observer?.disconnect();document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open,searchable]);
  const choose = (next:string) => {onChange(next);close();};
  const selected = items.find(item=>item.value===value)?.label || (!searchable && Number.isFinite(Number(value)) ? `${value}px` : value);
  return <>
    <button type="button" ref={anchor} className="font-select-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{setSearch('');setCustom(false);setOpen(v=>!v);}}><span>{selected}</span><ChevronDown size={16}/></button>
    {open&&createPortal(<div ref={menu} className="font-select-menu" role="dialog" aria-label={label} style={position} onKeyDown={e=>{
      if(e.key==='Escape'){e.stopPropagation();close();}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const buttons=Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="option"]'));const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    }}>
      {searchable&&<div className="font-select-search"><Search size={16}/><input autoFocus aria-label={t('settings.font.search')} placeholder={t('settings.font.search')} value={search} onChange={e=>setSearch(e.target.value)}/></div>}
      <div className="font-select-options" role="listbox" aria-label={label}>
        {items.filter(item=>item.label.toLowerCase().includes(search.toLowerCase())).map((item,index,list)=><Fragment key={item.value}>{item.group&&list[index-1]?.group!==item.group&&<div className="font-select-empty">{item.group}</div>}<button type="button" role="option" aria-selected={item.value===value} onClick={()=>choose(item.value)}>
          {searchable&&<span className="font-select-preview" style={{fontFamily:item.preview}}>{t('settings.font.sample')}</span>}
          <span className="font-select-name">{item.label}</span><Check size={15} style={{visibility:item.value===value?'visible':'hidden'}}/>
        </button></Fragment>)}
        {loading&&<div className="font-select-empty">{t('settings.font.loading')}</div>}
        {!loading&&!items.some(item=>item.label.toLowerCase().includes(search.toLowerCase()))&&<div className="font-select-empty">{t('settings.font.empty')}</div>}
      </div>
      {searchable&&<div className="font-select-custom">{custom?<form onSubmit={e=>{e.preventDefault();const name=String(new FormData(e.currentTarget).get('font')||'').trim();if(name)choose(name);}}><input autoFocus name="font" aria-label={t('settings.font.custom')} placeholder={t('settings.font.custom')}/><button type="submit" aria-label={t('common.save')}><Check size={16}/></button></form>:<button type="button" onClick={()=>setCustom(true)}><Pencil size={15}/>{t('settings.font.custom')}</button>}</div>}
    </div>,document.body)}
  </>;
}

export function FontSelect({value,onChange,monospace=false,label}:{value:string;onChange:(value:string)=>void;monospace?:boolean;label:string}) {
  const t=useT();
  const [fonts,setFonts]=useState<Array<{family:string;monospace:boolean}>>([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{let active=true;void (window.api?.listSystemFonts?.()??Promise.resolve([])).then(list=>{if(active)setFonts(list);}).catch(()=>{}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  const available=fonts.filter(f=>isTextFontFamily(f.family)&&(!monospace||f.monospace));
  const items:Item[]=[{value:'',label:t('settings.uiFontFamily.system'),preview:monospace?'monospace':'system-ui'},...available.map(f=>({value:f.family,label:f.family,group:t('settings.font.installed'),preview:`${JSON.stringify(f.family)}, ${monospace?'monospace':'sans-serif'}`}))];
  if(isTextFontFamily(value)&&!items.some(f=>f.value===value))items.push({value,label:value,preview:JSON.stringify(value)});
  return <FontMenu value={value} items={items} onChange={onChange} searchable loading={loading} label={label}/>;
}
