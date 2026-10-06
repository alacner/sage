import {GAME_DIFFICULTIES,GAME_DIFFICULTY,type GameDifficulty} from '../../shared/activity-difficulty';
import {pickActivityEgg} from '../../shared/activity-egg';
import {newMines,newTents} from '../../shared/activity-puzzles';
import {ActivityPuzzle} from './ActivityPuzzle';
import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {ArrowLeft,Pause,Play,RotateCcw,Volume2,VolumeX} from 'lucide-react';
import {activityGrid,activityGridSize,ACTIVITY_COLS,ACTIVITY_ROWS} from '../../shared/activity-grid';
import {newBlocks,newSnake,moveBlocks,rotateBlocks,stepBlocks,stepSnake,turnSnake,type ActivityGame,type GameKind,type Direction} from '../../shared/activity-games';
import {useT} from '../i18n';
import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import './ActivityHeatmap.css';
const colors=['','var(--game-cyan)','#e8be50','#ba9bea','#90b9a0','#e591b1','#7fa6dc','#ddaa78'];
const icons:Record<GameKind,string>={blocks:'🍑',snake:'🐥',mines:'💣',tents:'⛺️'};
const bestKey=(kind:GameKind,difficulty:GameDifficulty)=>`sage.activity-game.best.${kind}.${difficulty}`;
function readBest(kind:GameKind,difficulty:GameDifficulty){try{const n=Number(localStorage.getItem(bestKey(kind,difficulty)) ?? (difficulty==='normal'?localStorage.getItem(`sage.activity-game.best.${kind}`):null));return Number.isFinite(n)&&n>0?n:0;}catch{return 0;}}
export function ActivityHeatmap({metrics}:{metrics:{ts:number;total:number}[]}) {
  useDateTimeSettings();const t=useT();
  const root=useRef<HTMLDivElement>(null),audio=useRef<AudioContext>();
  const [width,setWidth]=useState(640),[hover,setHover]=useState(false);
  const [egg,setEgg]=useState<{kind:GameKind;x:number;y:number}|null>(null);
  const [game,setGame]=useState<ActivityGame|null>(null),[best,setBest]=useState(0),[sound,setSound]=useState(false);
  const [difficulty,setDifficulty]=useState<GameDifficulty>('normal');
  const lastScore=useRef(0),hoverPosition=useRef<number|null>(null);
  const trackPointer=(element:HTMLDivElement,clientX:number)=>{const rect=element.getBoundingClientRect();hoverPosition.current=rect.width>0?Math.max(0,Math.min(1,(clientX-rect.left)/rect.width)):null;};
  useEffect(()=>{const el=root.current;if(!el)return;const update=()=>setWidth(Math.max(1,el.getBoundingClientRect().width));update();const observer=new ResizeObserver(update);observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>{const panel=root.current?.querySelector<HTMLElement>('.activity-game-controls');if(!panel)return;const update=()=>root.current?.style.setProperty('--game-controls-height',`${panel.getBoundingClientRect().height}px`);update();const observer=new ResizeObserver(update);observer.observe(panel);return()=>observer.disconnect();},[game?.kind]);
  // Only reveal while the pointer (or keyboard focus) remains over the grid.
  useEffect(()=>{
    if(!hover||game){setEgg(null);return;}
    const reveal=()=>setEgg({kind:pickActivityEgg(hoverPosition.current),x:2+Math.floor(Math.random()*13),y:1+Math.floor(Math.random()*5)});
    let interval:ReturnType<typeof setInterval>|undefined;
    const timer=setTimeout(()=>{reveal();interval=setInterval(reveal,12000);},3000);
    return()=>{clearTimeout(timer);clearInterval(interval);};
  },[hover,!!game]);
  useEffect(()=>{
    if(game?.phase!=='playing'||(game.kind!=='snake'&&game.kind!=='blocks'))return;
    const timer=setInterval(()=>setGame(s=>s?.kind==='snake'?stepSnake(s):s?.kind==='blocks'?stepBlocks(s):s),game.kind==='snake'?GAME_DIFFICULTY[difficulty].snakeMs:GAME_DIFFICULTY[difficulty].blocksMs);
    return()=>clearInterval(timer);
  },[game?.kind,game?.phase,difficulty]);
  const pause=()=>setGame(s=>s?.phase==='playing'?{...s,phase:'paused'}:s);
  useEffect(()=>{const hidden=()=>{if(document.hidden)pause();};window.addEventListener('blur',pause);document.addEventListener('visibilitychange',hidden);return()=>{window.removeEventListener('blur',pause);document.removeEventListener('visibilitychange',hidden);};},[]);
  useEffect(()=>()=>{void audio.current?.close();},[]);
  useEffect(()=>{
    if(!game)return;
    if(game.score>best){setBest(game.score);try{localStorage.setItem(bestKey(game.kind,difficulty),String(game.score));}catch{/* Optional local record. */}}
    if(sound&&game.score>lastScore.current&&audio.current){
      const context=audio.current,osc=context.createOscillator(),gain=context.createGain();
      osc.type='sine';osc.frequency.value=game.kind==='snake'?660:880;gain.gain.setValueAtTime(.035,context.currentTime);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.12);osc.connect(gain);gain.connect(context.destination);osc.start();osc.stop(context.currentTime+.13);osc.onended=()=>{osc.disconnect();gain.disconnect();};
    }
    lastScore.current=game.score;
  },[game?.score,game?.kind,best,sound,difficulty]);
  const size=activityGridSize(width),cols=activityGrid(metrics),max=Math.max(1,...cols.flat().filter(c=>!c.future).map(c=>c.total));
  const level=(n:number)=>n<=0?0:n<max*.1?1:n<max*.35?2:n<max*.7?3:4;
  const months:{x:number;label:string}[]=[];let previous=-1;
  cols.forEach((col,x)=>{if(col[0].month!==previous){previous=col[0].month;const label=t(`ua.month.${previous}`);const left=Math.min(x*size.stride,size.width-32);if(months.length===1&&months[0].x===0&&left>0&&left<36)months[0]={x:left,label};else if(!months.length||left-months.at(-1)!.x>=36)months.push({x:left,label});}});
  const start=(kind:GameKind,level:GameDifficulty=difficulty)=>{lastScore.current=0;setDifficulty(level);setBest(readBest(kind,level));setGame(kind==='mines'?newMines(ACTIVITY_COLS,ACTIVITY_ROWS,level):kind==='tents'?newTents(ACTIVITY_COLS,ACTIVITY_ROWS,Math.random,level):kind==='snake'?newSnake(ACTIVITY_COLS,ACTIVITY_ROWS):newBlocks(ACTIVITY_COLS,ACTIVITY_ROWS));setEgg(null);root.current?.focus();};
  const back=()=>{hoverPosition.current=null;setGame(null);setHover(false);setEgg(null);};
  const togglePause=()=>{setGame(s=>s&&(s.phase==='playing'||s.phase==='paused')?{...s,phase:s.phase==='paused'?'playing':'paused'}:s);root.current?.focus();};
  const control=(key:string)=>{
    if(key==='Escape'){back();return;}
    if(key===' '){togglePause();return;}
    setGame(s=>{
      if(!s||s.phase!=='playing'||s.kind==='mines'||s.kind==='tents')return s;
      if(s.kind==='snake'){const directions:Record<string,Direction>={ArrowUp:'up',w:'up',ArrowDown:'down',s:'down',ArrowLeft:'left',a:'left',ArrowRight:'right',d:'right'};return directions[key]?turnSnake(s,directions[key]):s;}
      return key==='ArrowUp'||key==='w'?moveBlocks(s,-1):key==='ArrowDown'||key==='s'?moveBlocks(s,1):key==='ArrowLeft'||key==='a'?rotateBlocks(s):key==='ArrowRight'||key==='d'?stepBlocks(s):s;
    });
  };
  const gridStyle={width:size.width,height:size.height,gridTemplateColumns:`repeat(${ACTIVITY_COLS},${size.cell}px)`,gridTemplateRows:`repeat(${ACTIVITY_ROWS},${size.cell}px)`,gap:size.gap,'--game-emoji-size':`${Math.max(8,size.cell*1.3)}px`} as CSSProperties;
  return <div className={`ua-heat-wrap activity-heatmap${game?' is-playing':''}`} ref={root} style={{height:size.height+40,boxSizing:'border-box'}} tabIndex={game?0:-1}
    onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node)){pause();hoverPosition.current=null;setHover(false);}}}
    onKeyDown={e=>{if(!game||e.target instanceof HTMLSelectElement)return;const key=e.key.length===1?e.key.toLowerCase():e.key;if(e.target instanceof HTMLButtonElement&&(key===' '||key==='Enter'))return;if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d',' ','Escape'].includes(key)){e.preventDefault();e.stopPropagation();control(key);}}}>

    {game&&(game.kind==='mines'||game.kind==='tents')?<ActivityPuzzle key={game.kind} size={size} game={game} onChange={update=>setGame(s=>s&&(s.kind==='mines'||s.kind==='tents')?update(s):s)}/>:<div className="activity-grid-area" style={{width:size.width,margin:'0 auto'}}>
      <div className="activity-grid" style={gridStyle} tabIndex={game?-1:0} aria-label={t(game?'activityGame.board':'analytics.tokenActivity')}
        onMouseEnter={e=>{if(!game){trackPointer(e.currentTarget,e.clientX);setHover(true);}}} onMouseMove={e=>{if(!game)trackPointer(e.currentTarget,e.clientX);}} onMouseLeave={()=>{hoverPosition.current=null;setHover(false);}} onFocus={()=>{if(!game)setHover(true);}}>
        {cols.flatMap((col,x)=>col.map((c,y)=>{
          let color='',glyph='';
          if(game?.kind==='blocks'){const active=game.piece.some(p=>p.x+game.x===x&&p.y+game.y===y);color=colors[active?game.color:game.board[y][x]];}
          if(game?.kind==='snake'){const index=game.body.findIndex(p=>p.x===x&&p.y===y);glyph=index===0?'🐥':index>0?'🐣':game.food?.x===x&&game.food.y===y?'🐛':'';}
          return <span key={`${x}-${y}`} className={`ua-heat-cell ${game?'game-cell':c.future?'future':`lv${level(c.total)}`}`} style={{gridColumn:x+1,gridRow:y+1,width:size.cell,height:size.cell,background:color||undefined}} title={game||c.future?undefined:`${c.total.toLocaleString()} ${t('unit.tokens')} · ${formatDateTime(c.ts,'YYYY-MM-DD')}`}>{glyph}</span>;
        }))}
        {!game&&egg&&<button type="button" className="activity-egg" aria-label={t(`activityGame.${egg.kind}`)} title={t('activityGame.invite')} style={{left:egg.x*size.stride,top:egg.y*size.stride,width:Math.max(18,size.cell),height:Math.max(18,size.cell)}} onClick={()=>start(egg.kind)}>{icons[egg.kind]}</button>}
      </div>
      {game&&(game.phase==='over'||game.phase==='won')&&<div className="activity-game-result" role="status">{t(game.phase==='won'?'activityGame.won':'activityGame.over')}</div>}
    </div>}
    {game&&(game.kind==='mines'||game.kind==='tents')&&(game.phase==='won'||game.phase==='over')&&<div className="activity-puzzle-outcome" role="status">{t(game.phase==='won'?'activityGame.won':'activityGame.over')}</div>}
    {!game?<div className="ua-heat-months" style={{width:size.width,margin:'4px auto 0'}}>{months.map(m=><span key={m.x} style={{left:m.x}}>{m.label}</span>)}</div>:<div className="activity-game-controls">
      {game&&<div className="activity-game-header"><button type="button" onClick={back}><ArrowLeft size={14}/>{t('activityGame.back')}</button><span>{t(`activityGame.${game.kind}`)}</span><button type="button" aria-label={t(sound?'activityGame.mute':'activityGame.sound')} aria-pressed={sound} onClick={()=>{if(!sound){try{audio.current??=new AudioContext();void audio.current.resume();}catch{return;}}setSound(!sound);}}>{sound?<Volume2 size={16}/>:<VolumeX size={16}/>}</button></div>}
      <div className="activity-game-difficulty"><label>{t('activityGame.difficulty')} <select value={difficulty} onChange={e=>start(game.kind,e.target.value as GameDifficulty)}>{GAME_DIFFICULTIES.map(level=><option key={level} value={level}>{t(`activityGame.difficulty.${level}`)}</option>)}</select></label><span>{t(`activityGame.difficultyHint.${game.kind}`)}</span><small>{t('activityGame.difficultyRestart')}</small></div>
      <div className="activity-game-footer"><span aria-live="polite">{game.phase==='paused'?t('activityGame.paused'):t('activityGame.score',{score:game.score,best})}</span>
        <div className="activity-game-buttons">
          {(game.phase==='over'||game.phase==='won')?<button type="button" onClick={()=>start(game.kind)}><RotateCcw size={13}/>{t('activityGame.again')}</button>:<>
            {(game.kind==='blocks'||game.kind==='snake')&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].map((key,i)=><button key={key} type="button" aria-label={t(`activityGame.${game.kind==='blocks'?['moveUp','moveDown','rotate','faster'][i]:['moveUp','moveDown','moveLeft','moveRight'][i]}`)} disabled={game.phase!=='playing'} onClick={()=>{control(key);root.current?.focus();}}>{['↑','↓',game.kind==='blocks'?'↶':'←','→'][i]}</button>)}
            <button type="button" onClick={togglePause}>{game.phase==='paused'?<Play size={13}/>:<Pause size={13}/>} {t(game.phase==='paused'?'activityGame.resume':'activityGame.pause')}</button>
          </>}
        </div>
      </div><div className="activity-game-help">{t(`activityGame.${game.kind}Help`)}</div>
    </div>}
  </div>;
}
