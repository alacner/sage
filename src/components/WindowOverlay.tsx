import {useLayoutEffect,useRef,type HTMLAttributes,type CSSProperties} from 'react';
import {createPortal} from 'react-dom';

const overlays: HTMLElement[] = [];
const controls = 'button,a[href],input,textarea,select,summary,[tabindex]';
function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(controls)].filter(el => el.tabIndex >= 0
    && !el.matches(':disabled') && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden');
}

/** Modal masks belong to the window, never to a transformed/clipped pane. */
export function WindowOverlay({style,onEscape,onKeyDown,...props}:HTMLAttributes<HTMLDivElement>&{onEscape?:()=>void}) {
  const ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const element=ref.current!;
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    overlays.push(element);
    if(!element.querySelector('[role="dialog"],[role="alertdialog"]')&&!element.hasAttribute('role')) {
      element.setAttribute('role','dialog');element.setAttribute('aria-modal','true');
    }
    if(!element.contains(document.activeElement)) {
      const items=focusable(element);
      (items.find(el=>el.hasAttribute('data-autofocus'))??items[0]??element).focus({preventScroll:true});
    }
    const key=(event:KeyboardEvent)=>{
      if(event.key!=='Tab'||overlays.at(-1)!==element||event.defaultPrevented)return;
      const items=focusable(element),first=items[0],last=items.at(-1),active=document.activeElement;
      if(!first){event.preventDefault();element.focus();return;}
      if(!element.contains(active)||(event.shiftKey?active===first||active===element:active===last)){
        event.preventDefault();(event.shiftKey?last:first)?.focus();
      }
    };
    document.addEventListener('keydown',key);
    return()=>{
      const wasTop=overlays.at(-1)===element;
      overlays.splice(overlays.indexOf(element),1);
      document.removeEventListener('keydown',key);
      if(wasTop&&previous?.isConnected&&(!overlays.length||overlays.at(-1)?.contains(previous)))previous.focus({preventScroll:true});
    };
  },[]);
  return createPortal(<div {...props} ref={ref} tabIndex={-1} data-window-overlay="true" onKeyDown={event=>{
    onKeyDown?.(event);
    if(event.key==='Escape'&&!event.nativeEvent.isComposing&&!event.defaultPrevented&&onEscape&&overlays.at(-1)===ref.current){event.preventDefault();event.stopPropagation();onEscape();}
  }} style={{...style,position:'fixed',inset:0,zIndex:12000,WebkitAppRegion:'no-drag'} as CSSProperties}/>,document.body);
}
