import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Square, Circle, MoveUpRight, Pencil, createLucideIcon, Type, Smile, Crop, Undo2, Redo2, Download, X, Check, RotateCcw, ExternalLink, Trash2 } from 'lucide-react';
import type { ScreenshotEditorApi, ScreenshotState } from '../../shared/screenshot';
import { SCREENSHOT_MAX_EDGE, SCREENSHOT_MAX_PIXELS } from '../../shared/screenshot';
import { SELECTION_HANDLES, clampPoint, insideSelection, moveSelection, resizeSelection, selectionRect, toolbarPosition, type SelectionHandle } from '../../shared/screenshot-selection';
import { MAX_EDITS, MAX_POINTS, renderScreenshot, exportScreenshot, resolveMarks, markBounds, hitTestMarks, moveMark, resizeMark, type IdentifiedMark, type Edit, type Mark, type Point, type Rect, type Tool } from './drawing';
import './style.css';

declare global { interface Window { screenshotEditor: ScreenshotEditorApi } }
const api = window.screenshotEditor;
const MosaicIcon=createLucideIcon('ScreenshotMosaic',[
  ['rect',{x:'3',y:'3',width:'18',height:'18',rx:'.5',key:'frame'}],
  ...Array.from({length:25},(_,index)=>({row:Math.floor(index/5),column:index%5}))
    .filter(({row,column})=>(row+column)%2===0)
    .map(({row,column}):['rect',Record<string,string>]=>['rect',{x:String(6+column*2.5),y:String(6+row*2.5),width:'2',height:'2',fill:'currentColor',stroke:'none',key:`cell-${row}-${column}`}]),
]);
const tools: Array<[Tool, typeof Square, string, string]> = [
  ['crop',Crop,'调整选区','Adjust selection'], ['rectangle',Square,'矩形','Rectangle'], ['ellipse',Circle,'圆形','Ellipse'],
  ['arrow',MoveUpRight,'箭头','Arrow'], ['pen',Pencil,'画笔','Pen'], ['mosaic',MosaicIcon,'马赛克','Mosaic'],
  ['text',Type,'文字','Text'], ['emoji',Smile,'表情','Emoji'],
];
const palette = [
  ['#168bf2','蓝色','Blue'], ['#65b82a','绿色','Green'], ['#f7c928','黄色','Yellow'],
  ['#262626','黑色','Black'], ['#ffffff','白色','White'], ['#ef4444','红色','Red'],
] as const;
const strokeSizes = [2,4,6], textSizes = [16,24,32], emojiSizes = [24,32,44], mosaicSizes = [8,14,22];
const emojiChoices = [
  '😊','😀','😃','😄','😁','😆','😂','🤣','😉','😍','🥰','😎','🤔','😮','😢','👀',
  '👍','👎','👌','✌️','🤞','🤟','🤝','👋','👏','🙌','🙏','💪',
  '❤️','💔','⭐','🌟','✨','🔥','🎉','🎊','💡','📌','📍','🔍','🎯','✅','❌','⚠️','❗','❓','➡️','🔴',
];
function chooseByKey(e:React.KeyboardEvent<HTMLDivElement>,columns=1) {
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
  const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;
  e.preventDefault();
  const step=e.key==='ArrowUp'||e.key==='ArrowDown'?columns:1;
  const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(['ArrowLeft','ArrowUp'].includes(e.key)?-step:step)+buttons.length)%buttons.length;
  buttons[next]?.focus();buttons[next]?.click();
}
type ObjectDrag = ({kind:'object-move'}|{kind:'object-resize'}) & {start:Point; original:IdentifiedMark; mark:Mark; handle?:SelectionHandle};
type Drag = {kind:'mark'; mark:IdentifiedMark} | ObjectDrag | {kind:'new'|'move'|'resize'; start:Point; initial:Rect|null; handle?:SelectionHandle};
type TextDraft = {mark:IdentifiedMark; original?:IdentifiedMark};
function selectedRect(edits: Edit[]): Rect | null {
  for (let i=edits.length-1;i>=0;i--) if ('crop' in edits[i]) return (edits[i] as {crop:Rect}).crop;
  return null;
}
function Editor() {
  const [state,setState] = useState<ScreenshotState>(), [error,setError] = useState(''), [busy,setBusy] = useState(false), [ready,setReady] = useState(false);
  const [tool,setTool] = useState<Tool>('crop'), [color,setColor] = useState('#ef4444'), [width,setWidth] = useState(4), [fontSize,setFontSize] = useState(24), [emojiSize,setEmojiSize] = useState(32), [mosaicSize,setMosaicSize] = useState(14), [emoji,setEmoji] = useState('😊');
  const [edits,setEdits] = useState<Edit[]>([]), [undone,setUndone] = useState<Edit[]>([]), [preview,setPreview] = useState<Mark>(), [selection,setSelection] = useState<Rect|null>(null), [dragging,setDragging] = useState(false);
  const [selectedId,setSelectedId] = useState<string>(), [textDraft,setTextDraft] = useState<TextDraft>();
  const history = useRef<Edit[]>([]), future = useRef<Edit[]>([]), selectedIdRef = useRef<string>(), draftRef = useRef<TextDraft>(), nextMarkId = useRef(0), inlineText = useRef<HTMLTextAreaElement>(null), outputPending = useRef(false), retryPending = useRef(false);
  const [viewport,setViewport] = useState({width:window.innerWidth,height:window.innerHeight}), [toolbarSize,setToolbarSize] = useState({width:594,height:52});
  const [optionsOpen,setOptionsOpen] = useState(false), [panelSize,setPanelSize] = useState({width:360,height:54}), [anchor,setAnchor] = useState({x:0,y:0,width:34,height:36});
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  const toolButtons = useRef<Partial<Record<Tool,HTMLButtonElement|null>>>({});
  const image = useRef<HTMLImageElement>(), renderedImageRevision = useRef<number>(), decodeErrorRevision = useRef<number>(), sentReadyRevision = useRef<number>(), drag = useRef<Drag>(), frame = useRef(0), space = useRef(false);
  const english = state?.language === 'en', t = (zh:string,en:string) => english ? en : zh;
  const bounds = {width:image.current?.naturalWidth ?? 1,height:image.current?.naturalHeight ?? 1};
  const marks=resolveMarks(edits), selectedMark=(preview?.id===selectedId?preview:textDraft&&textDraft.mark.id===selectedId?textDraft.mark:marks.find(mark=>mark.id===selectedId)) as IdentifiedMark|undefined;
  const context=canvas.current?.getContext('2d');
  const objectRect=selectedMark&&context?markBounds(selectedMark,context):null;
  const committed = selectedRect(edits), crop = selection ?? committed;
  const sx = viewport.width/bounds.width, sy = viewport.height/bounds.height;
  const screenRect = crop ? {x:crop.x*sx,y:crop.y*sy,width:crop.width*sx,height:crop.height*sy} : null;
  const toolbarAt = screenRect ? toolbarPosition(screenRect,toolbarSize,viewport) : {x:8,y:8};
  const belowSpace=Math.max(0,viewport.height-toolbarAt.y-toolbarSize.height-23),aboveSpace=Math.max(0,toolbarAt.y-23);
  const panelBelow=tool==='emoji' ? panelSize.height<=belowSpace||(panelSize.height>aboveSpace&&belowSpace>=aboveSpace)
    : toolbarAt.y+toolbarSize.height+panelSize.height+16<=viewport.height-8;
  const panelMaxHeight=tool==='emoji'?Math.max(49,panelBelow?belowSpace:aboveSpace):undefined;
  const panelHeight=panelMaxHeight===undefined?panelSize.height:Math.min(panelSize.height,panelMaxHeight);
  const panelAt={x:Math.max(8,Math.min(anchor.x-10,viewport.width-panelSize.width-8)),y:Math.max(8,panelBelow?toolbarAt.y+toolbarSize.height+15:toolbarAt.y-panelHeight-15)};
  const optionLabel=t('工具设置','Tool settings');
  const setSelected=(id?:string)=>{selectedIdRef.current=id;setSelectedId(id);};
  const setDraft=(value?:TextDraft)=>{draftRef.current=value;setTextDraft(value);};
  const pickMark=(mark:IdentifiedMark)=>{
    setSelected(mark.id);setTool(mark.tool);setColor(mark.color);setWidth(mark.width/pixelScale);
    if(mark.tool==='text')setFontSize((mark.fontSize??Math.max(18,mark.width*6))/pixelScale);
    if(mark.tool==='emoji'){setEmojiSize((mark.fontSize??Math.max(32,mark.width*10))/pixelScale);setEmoji(mark.text??'😊');}
    if(mark.tool==='mosaic')setMosaicSize((mark.blockSize??Math.max(12,mark.width*5))/pixelScale);
    setOptionsOpen(true);
  };
  const getSelected=()=>draftRef.current&&draftRef.current.mark.id===selectedIdRef.current?draftRef.current.mark:resolveMarks(history.current).find(mark=>mark.id===selectedIdRef.current);
  const finishText=()=>{
    const draft=draftRef.current;if(!draft)return true;
    const empty=!draft.mark.text?.trim();
    const edit:Edit|undefined=empty?(draft.original?{change:{id:draft.mark.id,mark:null}}:undefined)
      :!draft.original?{mark:draft.mark}:JSON.stringify(draft.mark)!==JSON.stringify(draft.original)?{change:{id:draft.mark.id,mark:draft.mark}}:undefined;
    if(edit&&!append(edit))return false;
    setDraft();if(empty)setSelected();return true;
  };
  const editText=(mark:IdentifiedMark,created=false)=>{
    if(history.current.length>=MAX_EDITS){setError(t('最多保留 200 步编辑，请撤销后继续。','The 200-edit limit has been reached. Undo to continue.'));return;}
    if(draftRef.current?.mark.id===mark.id){inlineText.current?.focus();return;}
    if(!finishText())return;pickMark(mark);setDraft({mark:{...mark,points:mark.points.map(p=>({...p}))},original:created?undefined:mark});
  };
  const closeOptions=()=>{setOptionsOpen(false);toolButtons.current[tool]?.focus();};
  const selectTool=(id:Tool)=>{if(!finishText())return;if(id!==tool||id==='crop')setSelected();setTool(id);setOptionsOpen(id!=='crop'&&(id!==tool||!optionsOpen));};
  const changeSelected=(patch:Partial<Mark>)=>{
    const mark=getSelected();if(!mark||mark.tool!==tool)return true;
    const changed={...mark,...patch};
    if(draftRef.current?.mark.id===mark.id)setDraft({...draftRef.current,mark:changed});
    else if(JSON.stringify(changed)!==JSON.stringify(mark))return append({change:{id:mark.id,mark:changed}});
    return true;
  };
  const changeColor=(value:string)=>{if(changeSelected({color:value}))setColor(value);};
  const changeSize=(size:number)=>{
    if(tool==='text'){if(changeSelected({fontSize:size*pixelScale}))setFontSize(size);}
    else if(tool==='emoji'){if(changeSelected({fontSize:size*pixelScale}))setEmojiSize(size);}
    else if(tool==='mosaic'){if(changeSelected({blockSize:size*pixelScale}))setMosaicSize(size);}
    else{if(changeSelected({width:size*pixelScale}))setWidth(size);}
  };
  const changeEmoji=(value:string)=>{if(changeSelected({text:value}))setEmoji(value);};
  const deleteSelected=()=>{
    const id=selectedIdRef.current;if(!id||busy||drag.current)return;
    const draft=draftRef.current;
    if((draft?.mark.id!==id||draft.original)&&!append({change:{id,mark:null}}))return;
    setDraft();setSelected();
  };
  const focusOptions=(e:React.KeyboardEvent<HTMLButtonElement>,id:Tool)=>{
    if(e.key!=='ArrowDown'||id==='crop')return;e.preventDefault();if(id!==tool){if(!finishText())return;setSelected();}setTool(id);setOptionsOpen(true);
    requestAnimationFrame(()=>panel.current?.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')?.focus());
  };
  const navigateToolbar=(e:React.KeyboardEvent<HTMLDivElement>)=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;e.preventDefault();
    const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  };
  // Marks use output pixels; controls express visible screen sizes on Retina and scaled captures.
  const pixelScale=Math.max(bounds.width/viewport.width,bounds.height/viewport.height);
  const sizes=tool==='text'?textSizes:tool==='emoji'?emojiSizes:tool==='mosaic'?mosaicSizes:strokeSizes;
  const currentSize=tool==='text'?fontSize:tool==='emoji'?emojiSize:tool==='mosaic'?mosaicSize:width;
  const focusSize=sizes.reduce((nearest,n,i)=>Math.abs(n-currentSize)<Math.abs(sizes[nearest]-currentSize)?i:nearest,0);

  useEffect(() => {
    let active=true;
    void api.state().then(value=>{if(active)setState(value);}).catch(e=>{if(active)setError(String(e.message??e));});
    return()=>{active=false;};
  },[]);
  useEffect(() => {
    const resize=()=>setViewport({width:window.innerWidth,height:window.innerHeight});
    window.addEventListener('resize',resize);
    return()=>window.removeEventListener('resize',resize);
  },[]);
  useEffect(() => {
    if(!toolbar.current)return;
    const observer=new ResizeObserver(([entry])=>setToolbarSize({width:entry.target.getBoundingClientRect().width,height:entry.target.getBoundingClientRect().height}));
    observer.observe(toolbar.current);return()=>observer.disconnect();
  },[!!committed,ready]);
  useLayoutEffect(() => {
    if(!optionsOpen)return;
    const update=()=>{
      const button=toolButtons.current[tool], options=panel.current;if(!button||!options)return;
      const rect=button.getBoundingClientRect(),size=options.getBoundingClientRect();
      let height=size.height;
      if(tool==='emoji'){
        const list=options.querySelector<HTMLElement>('.shot-emoji-options'),row=options.querySelector<HTMLElement>('.shot-setting-row');
        if(list&&row&&list.scrollHeight>0){
          const style=window.getComputedStyle(options),limit=parseFloat(window.getComputedStyle(list).maxHeight);
          height=row.getBoundingClientRect().height+Math.min(list.scrollHeight,Number.isFinite(limit)?limit:list.scrollHeight)
            +[style.paddingTop,style.paddingBottom,style.borderTopWidth,style.borderBottomWidth].reduce((sum,value)=>sum+(parseFloat(value)||0),0);
        }
      }
      setAnchor({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
      setPanelSize(old=>old.width===size.width&&old.height===height?old:{width:size.width,height});
    };
    update();const observer=new ResizeObserver(update);if(toolbar.current)observer.observe(toolbar.current);if(panel.current)observer.observe(panel.current);
    return()=>observer.disconnect();
  },[tool,optionsOpen,toolbarAt.x,toolbarAt.y,viewport.width,viewport.height]);
  useEffect(() => {
    renderedImageRevision.current=undefined;decodeErrorRevision.current=undefined;setError('');setOptionsOpen(false);setReady(false);history.current=[];future.current=[];setEdits([]);setUndone([]);setSelected();setDraft();setPreview(undefined);setSelection(null);setTool('crop');setDragging(false);drag.current=undefined;
    const source=state?.image;if(!source)return;
    let active=true;const loaded=new Image();
    loaded.onload=()=>{
      if(!active||!canvas.current)return;
      if(loaded.naturalWidth>SCREENSHOT_MAX_EDGE||loaded.naturalHeight>SCREENSHOT_MAX_EDGE||loaded.naturalWidth*loaded.naturalHeight>SCREENSHOT_MAX_PIXELS){decodeErrorRevision.current=state?.imageRevision??state?.revision;setError(t('截图过大，请降低屏幕分辨率后重试。','Image is too large. Lower the display resolution and retry.'));return;}
      image.current=loaded;canvas.current.width=loaded.naturalWidth;canvas.current.height=loaded.naturalHeight;
      renderScreenshot(canvas.current,loaded,[]);renderedImageRevision.current=state?.imageRevision??state?.revision;setReady(true);
    };
    loaded.onerror=()=>{if(active){decodeErrorRevision.current=state?.imageRevision??state?.revision;setError(t('图片无法打开，请重新截屏。','Cannot decode the image. Capture again.'));}};
    loaded.src=`data:image/png;base64,${source.dataBase64}`;
    return()=>{active=false;loaded.onload=loaded.onerror=null;loaded.src='';image.current=undefined;cancelAnimationFrame(frame.current);};
  },[state?.imageRevision ?? state?.revision]);
  useEffect(() => {
    if(ready&&canvas.current&&image.current)renderScreenshot(canvas.current,image.current,edits,preview??(textDraft?{...textDraft.mark,text:''}:undefined));
  },[edits,preview,textDraft,ready]);
  useLayoutEffect(()=>{if(textDraft&&inlineText.current){inlineText.current.focus();inlineText.current.setSelectionRange(textDraft.mark.text?.length??0,textDraft.mark.text?.length??0);}},[textDraft?.mark.id]);

  useEffect(() => {
    const revision=state?.revision;
    if(!state||typeof revision!=='number'||revision<=0||sentReadyRevision.current===revision)return;
    const imageRevision=state.imageRevision??revision;
    if(!(ready&&renderedImageRevision.current===imageRevision)&&!(error&&decodeErrorRevision.current===imageRevision)&&!state.error)return;
    let second=0;
    const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{sentReadyRevision.current=revision;void api.ready(revision).catch(e=>setError(String(e.message??e)));});});
    return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);};
  },[state?.revision,ready,error,state?.error]);

  const append=(edit:Edit)=>{
    if(history.current.length>=MAX_EDITS){setError(t('最多保留 200 步编辑，请撤销后继续。','The 200-edit limit has been reached. Undo to continue.'));return false;}
    history.current=[...history.current,edit];future.current=[];setEdits(history.current);setUndone([]);return true;
  };
  const historySelection=(edit:Edit|undefined)=>{
    const id=edit&&('mark'in edit?edit.mark.id:'change'in edit?edit.change.id:selectedIdRef.current);
    const mark=resolveMarks(history.current).find(mark=>mark.id===id);
    if(mark)pickMark(mark);else setSelected();
  };
  const undo=()=>{
    if(drag.current||busy||!finishText())return;const last=history.current.at(-1);if(!last)return;
    future.current=[...future.current,last];history.current=history.current.slice(0,-1);setUndone(future.current);setEdits(history.current);historySelection(last);
  };
  const redo=()=>{
    if(drag.current||busy||!finishText())return;const last=future.current.at(-1);if(!last)return;
    history.current=[...history.current,last];future.current=future.current.slice(0,-1);setUndone(future.current);setEdits(history.current);historySelection(last);
  };
  const cancelDrag=()=>{drag.current=undefined;cancelAnimationFrame(frame.current);setPreview(undefined);setSelection(null);setDragging(false);};
  const close=()=>{if(busy||outputPending.current||retryPending.current)return;setBusy(true);void api.close().catch(e=>{setError(String(e.message??e));setBusy(false);});};
  const output=async(kind:'copy'|'save')=>{
    if(busy||outputPending.current||retryPending.current||!ready||drag.current||!canvas.current||!crop)return;
    if(!finishText())return;renderScreenshot(canvas.current,image.current!,history.current);setPreview(undefined);
    outputPending.current=true;setBusy(true);setError('');
    let closing=false;
    try { const result=await api.export(kind,exportScreenshot(canvas.current,crop));if(!result.canceled)closing=true; }
    catch(e){setError(String((e as Error).message??e));}finally{if(!closing){outputPending.current=false;setBusy(false);}}
  };
  const retry=async(displayId?:number)=>{
    if(busy||outputPending.current||retryPending.current||drag.current)return;
    // React's busy state takes effect on the next render; native capture must
    // also be locked synchronously across repeated clicks and shortcuts.
    retryPending.current=true;setBusy(true);setError('');
    try{setState(await api.retry(displayId));}catch(e){setError(String((e as Error).message??e));}finally{retryPending.current=false;setBusy(false);}
  };
  useEffect(() => {
    const key=(e:KeyboardEvent)=>{
      if(busy)return;
      if(e.key==='Escape'){e.preventDefault();if(draftRef.current){const value=draftRef.current;setDraft();if(!value.original)setSelected();else pickMark(value.original);}else if(drag.current)cancelDrag();else if(selectedIdRef.current){setSelected();setOptionsOpen(false);}else if(optionsOpen)closeOptions();else close();return;}
      if((e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.target instanceof HTMLSelectElement)&&!(e.key==='Tab'&&e.ctrlKey))return;
      // Enter, Space and Tab keep their native behavior while navigating controls.
      if((e.target as HTMLElement)?.closest?.('[data-shot-ui]')&&(['Enter',' '].includes(e.key)||(e.key==='Tab'&&!e.ctrlKey)))return;
      if(selectedIdRef.current&&['Backspace','Delete'].includes(e.key)){e.preventDefault();deleteSelected();return;}
      if(selectedIdRef.current&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&!(e.target as HTMLElement)?.closest?.('[data-shot-ui]')){
        const mark=getSelected(),ctx=canvas.current?.getContext('2d');if(!mark||!ctx||!committed)return;e.preventDefault();
        const step=(e.shiftKey?10:1)*pixelScale,delta={x:e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,y:e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0};
        const handle=(e.target as HTMLElement)?.dataset?.objectHandle as SelectionHandle|undefined;
        const rect=markBounds(mark,ctx),at=handle?{x:rect.x+(handle.includes('w')?0:handle.includes('e')?rect.width:rect.width/2)+delta.x,y:rect.y+(handle.includes('n')?0:handle.includes('s')?rect.height:rect.height/2)+delta.y}:undefined;
        const changed=at?resizeMark(mark,handle!,at,ctx,committed):moveMark(mark,delta,committed,ctx);
        if(append({change:{id:mark.id,mark:changed}}))pickMark({...changed,id:mark.id});return;
      }
      if(e.code==='Space'){e.preventDefault();space.current=true;if(stage.current)stage.current.style.cursor='grab';}
      else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}
      else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'&&ready&&!busy&&!drag.current){e.preventDefault();if(!finishText())return;setSelected();append({crop:{x:0,y:0,...bounds}});}
      else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void output('save');}
      else if(e.key==='Enter'||((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='c')){e.preventDefault();void output('copy');}
      else if(e.key==='Tab'&&e.ctrlKey&&state?.displays&&state.displays.length>1){e.preventDefault();const current=state.displays.findIndex(d=>d.id===state.display?.id);void retry(state.displays[(current+(e.shiftKey?-1:1)+state.displays.length)%state.displays.length].id);}
    };
    const release=(e:KeyboardEvent)=>{if(e.code==='Space'){space.current=false;if(stage.current)stage.current.style.cursor='crosshair';}};
    const blur=()=>{space.current=false;cancelDrag();};
    window.addEventListener('keydown',key);window.addEventListener('keyup',release);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('keydown',key);window.removeEventListener('keyup',release);window.removeEventListener('blur',blur);};
  });
  const point=(e:{clientX:number;clientY:number}):Point=>{
    const rect=stage.current!.getBoundingClientRect();
    return clampPoint({x:(e.clientX-rect.left)*bounds.width/rect.width,y:(e.clientY-rect.top)*bounds.height/rect.height},bounds);
  };
  const confirmSelection=(e:React.MouseEvent)=>{
    if(e.button!==0||tool!=='crop'||!committed||busy||drag.current||(e.target as HTMLElement).closest('[data-shot-ui],[data-handle],[data-object-handle],[data-object-border]'))return;
    if(!insideSelection(point(e),committed))return;
    e.preventDefault();void output('copy');
  };
  const newMark=(mark:Omit<Mark,'id'>):IdentifiedMark=>({...mark,id:`mark-${++nextMarkId.current}`});
  const begin=(e:React.PointerEvent)=>{
    if(busy||!ready||e.button!==0||(e.target as HTMLElement).closest('[data-shot-ui]'))return;
    e.preventDefault();setError('');if(!finishText())return;const p=point(e),ctx=canvas.current!.getContext('2d')!;
    const handle=(e.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle as SelectionHandle|undefined;
    const border=(e.target as HTMLElement).hasAttribute('data-selection-border');
    const objectHandle=(e.target as HTMLElement).closest<HTMLElement>('[data-object-handle]')?.dataset.objectHandle as SelectionHandle|undefined;
    const objectBorder=(e.target as HTMLElement).hasAttribute('data-object-border');
    // Cropping always takes precedence over annotations.
    if(handle&&committed){setSelected();drag.current={kind:'resize',initial:committed,start:p,handle};}
    else if(!committed||!insideSelection(p,committed)){setSelected();drag.current={kind:'new',initial:null,start:p};}
    else if(tool==='crop'||space.current||border){setSelected();drag.current={kind:'move',initial:committed,start:p};}
    else{
      const selected=resolveMarks(history.current).find(mark=>mark.id===selectedIdRef.current);
      const pointed=hitTestMarks(resolveMarks(history.current),p,ctx,6*pixelScale);
      const hit=objectHandle||objectBorder?selected:pointed??(selected&&insideSelection(p,markBounds(selected,ctx))?selected:undefined);
      if(hit){pickMark(hit);drag.current={kind:objectHandle?'object-resize':'object-move',start:p,original:hit,mark:hit,handle:objectHandle};}
      else{
        setSelected();setOptionsOpen(false);
        if(tool==='text'){
          if(history.current.length>=MAX_EDITS){setError(t('最多保留 200 步编辑，请撤销后继续。','The 200-edit limit has been reached. Undo to continue.'));return;}
          editText(newMark({tool,points:[p],color,width:width*pixelScale,fontSize:fontSize*pixelScale,text:''}),true);return;
        }
        if(tool==='emoji'){
          const mark=newMark({tool,points:[p],color,width:width*pixelScale,fontSize:emojiSize*pixelScale,text:emoji});if(append({mark}))pickMark(mark);return;
        }
        drag.current={kind:'mark',mark:newMark({tool,points:[p],color,width:width*pixelScale,blockSize:mosaicSize*pixelScale})};
      }
    }
    stage.current!.setPointerCapture(e.pointerId);setDragging(true);
  };
  const nextRect=(value:Extract<Drag,{kind:'new'|'move'|'resize'}>,p:Point) => value.kind==='new' ? selectionRect(value.start,p)
    : value.kind==='resize' ? resizeSelection(value.initial!,value.handle!,p,bounds)
    : moveSelection(value.initial!,{x:p.x-value.start.x,y:p.y-value.start.y},bounds);
  const nextObject=(value:ObjectDrag,p:Point)=>value.kind==='object-resize'
    ?resizeMark(value.original,value.handle!,p,canvas.current!.getContext('2d')!,committed??undefined)
    :moveMark(value.original,{x:p.x-value.start.x,y:p.y-value.start.y},committed??undefined,canvas.current!.getContext('2d')!);
  const move=(e:React.PointerEvent)=>{
    if(busy)return;
    const value=drag.current,p=point(e);
    if(!value){
      if(stage.current){const ctx=canvas.current?.getContext('2d');stage.current.style.cursor=committed&&insideSelection(p,committed)&&(tool==='crop'||space.current)?'move':ctx&&tool!=='crop'&&hitTestMarks(marks,p,ctx,6*pixelScale)?'move':tool==='text'?'text':'crosshair';}return;
    }
    if(value.kind==='mark'){
      const mark=value.mark;
      const at=committed?{x:Math.max(committed.x,Math.min(committed.x+committed.width,p.x)),y:Math.max(committed.y,Math.min(committed.y+committed.height,p.y))}:p;
      if(mark.tool==='pen'){if(mark.points.length<MAX_POINTS)mark.points.push(at);else mark.points[mark.points.length-1]=at;}else mark.points=[mark.points[0],at];
    }else if(value.kind==='object-move'||value.kind==='object-resize')value.mark=nextObject(value,p);
    cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{frame.current=0;if(!drag.current)return;
      if(value.kind==='mark')setPreview({...value.mark,points:[...value.mark.points]});
      else if(value.kind==='object-move'||value.kind==='object-resize')setPreview(value.mark);
      else setSelection(nextRect(value,p));
    });
  };
  const end=(e:React.PointerEvent)=>{
    if(busy)return;
    const value=drag.current;if(!value)return;
    move(e);cancelAnimationFrame(frame.current);drag.current=undefined;setPreview(undefined);setSelection(null);setDragging(false);
    if(value.kind==='mark'){
      if(value.mark.tool==='pen'||Math.hypot(value.mark.points[0].x-point(e).x,value.mark.points[0].y-point(e).y)>2){if(append({mark:value.mark}))pickMark(value.mark);}
    }else if(value.kind==='object-move'||value.kind==='object-resize'){
      const changed={...nextObject(value,point(e)),id:value.original.id};
      if(JSON.stringify(changed)!==JSON.stringify(value.original)){if(append({change:{id:value.original.id,mark:changed}}))pickMark(changed);}
      else if(value.original.tool==='text')editText(value.original);
    }else{
      const rect=nextRect(value,point(e));
      if(rect.width>=4&&rect.height>=4&&JSON.stringify(rect)!==JSON.stringify(value.initial)){append({crop:rect});if(value.kind==='new')setTool('crop');}
    }
    if(stage.current?.hasPointerCapture(e.pointerId))stage.current.releasePointerCapture(e.pointerId);
  };
  const failure=error||state?.error;
  const screenControl=state?.displays&&state.displays.length>1&&<select aria-label={t('截屏显示器','Capture display')} title={t('切换显示器 Control+Tab','Switch display Control+Tab')} value={state.display?.id} disabled={busy} onChange={e=>void retry(Number(e.target.value))}>{state.displays.map((d,i)=><option key={d.id} value={d.id}>{d.label||`${t('显示器','Display')} ${i+1}`}</option>)}</select>;
  return <main className="screenshot-editor" aria-label={t('截屏编辑器','Screenshot editor')}>
    <div className="shot-stage" ref={stage} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={cancelDrag} onDoubleClick={confirmSelection}>
      {state?.image&&<canvas ref={canvas} className="shot-desktop" aria-label={t('截图画布','Screenshot canvas')}/>}
      {ready&&<div className="shot-shade" aria-hidden="true">
        {screenRect?<><i style={{left:0,top:0,right:0,height:screenRect.y}}/><i style={{left:0,top:screenRect.y,width:screenRect.x,height:screenRect.height}}/><i style={{left:screenRect.x+screenRect.width,top:screenRect.y,right:0,height:screenRect.height}}/><i style={{left:0,top:screenRect.y+screenRect.height,right:0,bottom:0}}/></>:<i style={{inset:0}}/>}
      </div>}
      {ready&&screenRect&&crop&&<>
        <div className="shot-selection" style={{left:screenRect.x,top:screenRect.y,width:screenRect.width,height:screenRect.height}}>
          {['n','e','s','w'].map(edge=><span key={edge} className={`shot-border shot-border-${edge}`} data-selection-border/>)}
          {SELECTION_HANDLES.map(handle=><span key={handle} className={`shot-handle shot-handle-${handle}`} data-handle={handle} aria-label={`${t('调整选区','Resize selection')} ${handle}`}/>)}
        </div>
        <output className="shot-dimensions" aria-live="off" style={{left:Math.max(8,Math.min(screenRect.x,viewport.width-170)),top:screenRect.y>=32?screenRect.y-30:Math.max(8,screenRect.y+8)}}>{crop.width} × {crop.height}<small>px</small></output>
      </>}
      {ready&&committed&&selectedMark&&objectRect&&<div className="shot-object-selection" data-selected-object={selectedMark.id} style={{left:objectRect.x*sx,top:objectRect.y*sy,width:Math.max(1,objectRect.width*sx),height:Math.max(1,objectRect.height*sy)}}>
        {['n','e','s','w'].map(edge=><span key={edge} className={`shot-border shot-border-${edge}`} data-object-border/>)}
        {SELECTION_HANDLES.map(handle=><span key={handle} className={`shot-object-handle shot-handle-${handle}`} data-object-handle={handle} role="button" aria-disabled={busy} tabIndex={busy?-1:0} aria-label={`${t('调整标注','Resize annotation')} ${handle}`}/>)}
      </div>}
      {ready&&textDraft&&objectRect&&<textarea ref={inlineText} className="shot-inline-text" data-shot-ui maxLength={1500} disabled={busy} aria-label={t('标注文字','Annotation text')} value={textDraft.mark.text??''} spellCheck={false} style={{left:objectRect.x*sx,top:objectRect.y*sy,width:Math.min(Math.max(100,objectRect.width*sx+4),Math.max(24,(committed!.x+committed!.width-objectRect.x)*sx)),height:Math.max((textDraft.mark.fontSize??48)*sy*1.3,objectRect.height*sy+4),fontSize:(textDraft.mark.fontSize??48)*sy,color:textDraft.mark.color}} onChange={e=>setDraft({...textDraft,mark:{...textDraft.mark,text:e.target.value}})} onBlur={e=>{if(e.relatedTarget&&!(e.relatedTarget as HTMLElement).closest?.('[data-shot-ui]'))finishText();}}/>}
    </div>
    {(!committed||!ready)&&<div className="shot-start" data-shot-ui>
      <strong>{ready?t('拖动选择截屏区域','Drag to select an area'):failure&&!busy?t('截屏失败','Screenshot failed'):t('截屏','Screenshot')}</strong>
      <span>{ready?t('选区内拖动可移动 · 边角可调整 · Esc 取消','Drag inside to move · Resize from edges · Esc to cancel'):busy?t('正在重新截屏','Retaking the screenshot'):failure?t('未取得屏幕画面，请重试或取消。','No screen image is available. Retake or cancel.'):t('正在准备屏幕画面','Preparing the screen image')}</span>
      <div>{screenControl}<button aria-label={t('重新截屏','Retake')} disabled={busy} onClick={()=>void retry()}><RotateCcw size={17}/>{t('重新截屏','Retake')}</button><button aria-label={t('取消','Cancel')} disabled={busy} onClick={close}><X size={19}/></button></div>
    </div>}
    {failure&&<div role="alert" className="shot-error" data-shot-ui>
      <span>{failure.includes('SAGE_SCREEN_PERMISSION_REQUIRED')?t('请在系统设置 → 隐私与安全性 → 屏幕与系统录音中允许 Sage，再重新截屏；若系统提示，请重启 Sage。','Allow Sage in System Settings → Privacy & Security → Screen & System Audio Recording, then retake. Restart if macOS asks.'):failure}</span>
      {failure.includes('SAGE_SCREEN_PERMISSION_REQUIRED')&&<button disabled={busy} onClick={()=>void api.privacy().catch(e=>setError(String(e.message??e)))}><ExternalLink size={15}/>{t('打开系统设置','Open System Settings')}</button>}
      {error&&ready&&<button aria-label={t('关闭提示','Dismiss message')} disabled={busy} onClick={()=>setError('')}><X size={16}/></button>}
    </div>}
    {ready&&committed&&<div className="shot-controls" ref={toolbar} data-shot-ui style={{left:toolbarAt.x,top:toolbarAt.y,visibility:dragging?'hidden':'visible'}}>
      <div className="shot-toolbar" role="toolbar" aria-label={t('截图工具','Screenshot tools')} onKeyDown={navigateToolbar}>
        {tools.map(([id,Icon,zh,en])=><button key={id} ref={node=>{toolButtons.current[id]=node;}} disabled={busy} title={t(zh,en)} aria-label={t(zh,en)} aria-pressed={tool===id} aria-expanded={id==='crop'?undefined:tool===id&&optionsOpen} aria-controls={id==='crop'?undefined:'shot-tool-options'} onClick={()=>selectTool(id)} onKeyDown={e=>focusOptions(e,id)}><Icon size={21} strokeWidth={1.65}/></button>)}
        <span className="shot-divider"/>
        <button title={t('撤销 ⌘Z','Undo ⌘Z')} aria-label={t('撤销','Undo')} disabled={busy||!edits.length} onClick={undo}><Undo2 size={21}/></button>
        <button title={t('重做 ⇧⌘Z','Redo ⇧⌘Z')} aria-label={t('重做','Redo')} disabled={busy||!undone.length} onClick={redo}><Redo2 size={21}/></button>
        <button title={t('重新截屏','Retake')} aria-label={t('重新截屏','Retake')} disabled={busy} onClick={()=>void retry()}><RotateCcw size={19}/></button>
        <span className="shot-divider"/>
        <button title={t('保存 PNG… ⌘S','Save PNG… ⌘S')} aria-label={t('保存截图','Save screenshot')} disabled={busy} onClick={()=>void output('save')}><Download size={21}/></button>
        <button className="shot-cancel" title={t('取消 Esc','Cancel Esc')} aria-label={t('取消','Cancel')} disabled={busy} onClick={close}><X size={22}/></button>
        <button className="shot-confirm" title={t('复制到剪贴板 Enter / ⌘C','Copy to clipboard Enter / ⌘C')} aria-label={t('复制到剪贴板','Copy to clipboard')} disabled={busy} onClick={()=>void output('copy')}><Check size={23}/></button>
      </div>
      {screenControl&&<div className="shot-screen">{screenControl}</div>}
      {optionsOpen&&tool!=='crop'&&<div id="shot-tool-options" ref={panel} className={`shot-settings ${panelBelow?'below':'above'}`} role="region" aria-label={optionLabel} style={{left:panelAt.x,top:panelAt.y,maxHeight:panelMaxHeight,'--pointer-left':`${Math.max(14,Math.min(panelSize.width-14,anchor.x+anchor.width/2-panelAt.x))}px`} as React.CSSProperties}>
        <div className="shot-setting-row">
          <div className="shot-size-options" role="radiogroup" aria-label={tool==='mosaic'?t('马赛克粒度','Mosaic size'):tool==='text'||tool==='emoji'?t('字号','Font size'):t('线条粗细','Line width')} onKeyDown={chooseByKey}>
            {sizes.map((size,index)=>{
              const isText=tool==='text'||tool==='emoji', selected=currentSize===size;
              const names=tool==='mosaic'?[t('细马赛克','Fine mosaic'),t('中等马赛克','Medium mosaic'),t('粗马赛克','Coarse mosaic')]:isText?[t('小字号','Small text'),t('中字号','Medium text'),t('大字号','Large text')]:[t('细线','Thin line'),t('中等线','Medium line'),t('粗线','Thick line')];
              return <button key={size} role="radio" aria-checked={selected} tabIndex={index===focusSize?0:-1} aria-label={names[index]} title={names[index]} disabled={busy} onClick={()=>changeSize(size)}>
                {isText?<span className="shot-letter" style={{fontSize:[15,20,25][index]}}>A</span>:<span className="shot-dot" style={{width:[5,9,14][index],height:[5,9,14][index]}}/>}
              </button>;
            })}
          </div>
          {tool!=='mosaic'&&tool!=='emoji'&&<><span className="shot-divider"/><div className="shot-color-options" role="radiogroup" aria-label={t('标注颜色','Annotation color')} onKeyDown={chooseByKey}>
            {palette.map(([value,zh,en])=><button key={value} role="radio" aria-checked={color===value} tabIndex={color===value?0:-1} aria-label={t(zh,en)} title={t(zh,en)} disabled={busy} onClick={()=>changeColor(value)}><span className="shot-swatch" style={{background:value}}/></button>)}
          </div></>}
          {selectedMark&&<><span className="shot-divider"/><button className="shot-delete" title={t('删除标注','Delete annotation')} aria-label={t('删除标注','Delete annotation')} disabled={busy} onClick={deleteSelected}><Trash2 size={17}/></button></>}
        </div>
        {tool==='emoji'&&<div className="shot-emoji-options" role="radiogroup" aria-label={t('选择表情','Choose emoji')} onKeyDown={e=>chooseByKey(e,6)}>{emojiChoices.map(value=><button key={value} role="radio" aria-checked={emoji===value} tabIndex={emoji===value?0:-1} aria-label={value} disabled={busy} onClick={()=>changeEmoji(value)}>{value}</button>)}</div>}
      </div>}
    </div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Editor/>);
