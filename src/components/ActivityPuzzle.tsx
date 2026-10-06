import {useState,type CSSProperties} from 'react';
import type {activityGridSize} from '../../shared/activity-grid';
import {mineNumber,playMines,playTents,tentStatus,type PuzzleGame} from '../../shared/activity-puzzles';
import {useT} from '../i18n';
export function ActivityPuzzle({game,onChange,size}:{size:ReturnType<typeof activityGridSize>;game:PuzzleGame;onChange:(update:(s:PuzzleGame)=>PuzzleGame)=>void}){
 const t=useT(),[mark,setMark]=useState(false),status=game.kind==='tents'?tentStatus(game):null;
 const act=(i:number,alternate=false)=>onChange(s=>s.kind==='mines'?playMines(s,i,alternate||mark):playTents(s,i,alternate||mark));
 return <>

  <div className="activity-puzzle-scroll" style={{width:size.width,margin:'0 auto','--puzzle-cell':`${size.cell}px`,'--puzzle-font':`${Math.max(5,size.cell*.8)}px`} as CSSProperties}>
    {game.kind==='tents'&&<div className="puzzle-column-clues" style={{gridTemplateColumns:`repeat(${game.cols},${size.cell}px)`,gap:size.gap}}>{game.colTargets.map((n,x)=><span key={`col-${x}`} className={`puzzle-clue ${status!.colCounts[x]===n?'is-met':status!.colCounts[x]>n?'is-error':''}`} title={t('activityGame.colClue',{index:x+1,count:n})}>{n}</span>)}</div>}
   <div className="activity-puzzle-board" style={{gridTemplateColumns:`repeat(${game.cols},${size.cell}px)`,gridAutoRows:size.cell,gap:size.gap}} aria-label={t('activityGame.board')}>

    {Array.from({length:game.rows},(_,y)=><div className="puzzle-row" key={y}>

     {Array.from({length:game.cols},(_,x)=>{const i=y*game.cols+x;let text='',state='',number=0;
      if(game.kind==='mines'){number=mineNumber(game,i);text=game.flags[i]?'🚩':game.revealed[i]||game.phase==='over'&&game.mines[i]?game.mines[i]?'💣':String(number):'';state=game.revealed[i]?'is-revealed':'';}
      else{text=game.trees[i]?'🌳':game.marks[i]===1?'⛺️':game.marks[i]===2?'0':'';state=status!.errors.has(i)?'is-error':game.marks[i]===2?'is-revealed':'';}
      return <button key={i} type="button" className={`puzzle-cell ${state}`} data-number={number} data-cell={i} disabled={game.phase!=='playing'} aria-label={t('activityGame.cell',{row:y+1,col:x+1,value:text||t('activityGame.covered')})} onClick={()=>act(i)} onContextMenu={e=>{e.preventDefault();act(i,true);}} onKeyDown={e=>{const delta:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-game.cols,ArrowDown:game.cols};if(e.key in delta){e.preventDefault();e.stopPropagation();const next=i+delta[e.key];if(next>=0&&next<game.cols*game.rows&&(Math.abs(delta[e.key])!==1||Math.floor(next/game.cols)===y))e.currentTarget.closest('.activity-puzzle-board')?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus();}}}>{text}</button>;
     })}
    </div>)}
   </div>
  </div>
  <div className="activity-puzzle-extras">
  <div className="activity-puzzle-tools"><button type="button" aria-pressed={mark} onClick={()=>setMark(!mark)}>{t(game.kind==='mines'?(mark?'activityGame.flagMode':'activityGame.revealMode'):(mark?'activityGame.safeMode':'activityGame.tentMode'))}</button><span role="status">{game.kind==='mines'?t('activityGame.mineCount',{count:game.mineCount,flags:game.flags.filter(Boolean).length}):t(status?.errors.size||!status?.paired?'activityGame.tentConflict':'activityGame.tentClues')}</span></div>
  {game.kind==='tents'&&<div className="puzzle-row-clues">{game.rowTargets.map((n,y)=><span key={y} className={`puzzle-clue ${status!.rowCounts[y]===n?'is-met':status!.rowCounts[y]>n?'is-error':''}`}>{t('activityGame.rowClue',{index:y+1,count:n})}</span>)}</div>}
  </div>
 </>;
}
