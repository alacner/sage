import { memo, useEffect, useState, useId, useRef } from 'react';
import { CAT_ANIMATIONS, type CatAnimation, type PetEdge } from '../../shared/pet';
import { PeekDetails } from './PeekDetails';
import frames from './assets/pet-frames.json';
import pixelCat from './assets/grey-cat-pixel.png';
import comicCat from './assets/grey-cat-comic.png';
import pixelDog from './assets/apricot-dog-pixel.png';
import comicDog from './assets/apricot-dog-comic.png';
import actionFrames from './assets/pet-action-frames.json';
import pixelCatActions from './assets/grey-cat-pixel-actions.png';
import comicCatActions from './assets/grey-cat-comic-actions.png';
import pixelDogActions from './assets/apricot-dog-pixel-actions.png';
import comicDogActions from './assets/apricot-dog-comic-actions.png';
import heldFrames from './assets/pet-held-frames.json';
import pixelCatHeld from './assets/grey-cat-pixel-held.png';
import comicCatHeld from './assets/grey-cat-comic-held.png';
import pixelDogHeld from './assets/apricot-dog-pixel-held.png';
import comicDogHeld from './assets/apricot-dog-comic-held.png';
const heldSheets = {pixel:pixelCatHeld, comic:comicCatHeld, 'dog-pixel':pixelDogHeld, 'dog-comic':comicDogHeld};
const actionSheets = {pixel:pixelCatActions, comic:comicCatActions, 'dog-pixel':pixelDogActions, 'dog-comic':comicDogActions};
const sheets = {pixel: pixelCat, comic: comicCat, 'dog-pixel': pixelDog, 'dog-comic': comicDog};

export type PetStyle = 'pixel' | 'comic' | 'dog-pixel' | 'dog-comic';
const actionAnimations = {
  idle: {frames:[0], step:1800, duration:3500},
  blink: {frames:[0,1,0,1,0,0], step:160, duration:960},
  'prone-tail': {frames:[2,3], step:480, duration:2880},
  drool: {frames:[4,5], step:1800, duration:7200},
  reach: {frames:[6,7,6,7,0], step:180, duration:900},
};
const peekAnimations = {
  'peek-idle': {frames:[0],step:3800,duration:3800},
  'peek-blink': {frames:[1,0,1,0],step:140,duration:560},
  'peek-greet': {frames:[1,0,0,0,0,1,0],step:170,duration:1190},
};
type Animation = CatAnimation | keyof typeof actionAnimations | keyof typeof peekAnimations;
const animations = {...CAT_ANIMATIONS, ...actionAnimations, ...peekAnimations};
const activities: Animation[] = ['blink', 'prone-tail', 'turn', 'drool', 'sleep', 'doze', 'tail', 'stretch'];

/** Sprite changes use low-frequency timers; no animation loop runs when hidden. */
export const PetAvatar = memo(function PetAvatar({ style = 'pixel', peek = false, emergeFrom, held = false, landing = false, paused = false }: {
  style?: PetStyle; peek?: boolean; emergeFrom?: PetEdge | null; held?: boolean; landing?: boolean; paused?: boolean;
}) {
  const clipId = useId().replace(/:/g, '');
  const [pose, setPose] = useState<{animation: Animation; frame: number; right?: boolean}>({animation: 'idle', frame: 0});
  const avatarRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let step = 0, activity = -1;
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let started = 0;
    let right = false;
    let pointer: {x: number; y: number} | null = null;
    let animation: Animation = peek ? 'peek-idle' : 'idle';
    let greeted = false;
    const reachDirection = (): boolean | null => {
      const r = avatarRef.current?.getBoundingClientRect();
      if (!pointer || !r?.width || pointer.x < r.left-18 || pointer.x > r.right+18
        || pointer.y < r.top-18 || pointer.y >= r.bottom) return null;
      return pointer.x > r.left+r.width/2;
    };
    const tick = () => {
      if (paused || held || emergeFrom || document.hidden || motion?.matches) return;
      if (peek) {
        if (Date.now()-started >= animations[animation].duration) {
          animation=animation==='peek-idle'?'peek-blink':'peek-idle';step=0;started=Date.now();
        }
        const current=animations[animation];
        setPose({animation,frame:current.frames[step++ % current.frames.length]});
        timer=setTimeout(tick,current.step);return;
      }
      // Keep reaching at a stationary nearby pointer; use current layout bounds
      // so opening the bar does not leave a stale interaction running elsewhere.
      const direction = reachDirection();
      if (direction !== null) {
        if (animation !== 'reach' || right !== direction) { step = 0; started = Date.now(); }
        animation = 'reach'; right = direction;
      } else if (animation === 'reach') {
        animation = 'idle'; step = 0; started = Date.now();
      }
      const spec = animations[animation];
      if (animation !== 'reach' && Date.now() - started >= spec.duration) {
        animation = animation === 'idle' ? activities[(++activity) % activities.length] : 'idle';
        step = 0; started = Date.now();
      }
      const current = animations[animation];
      setPose({animation, frame: current.frames[step++ % current.frames.length], right});
      timer = setTimeout(tick, current.step);
    };
    const reset = () => {
      clearTimeout(timer); pointer = null; greeted=false; animation = peek?'peek-idle':'idle'; step = 0; started = Date.now();
      setPose({animation, frame: 0});
      if (!paused && !held && !emergeFrom && !document.hidden && !motion?.matches) timer = setTimeout(tick, peek?3800:1400);
    };
    const approach = (e: MouseEvent) => {
      const target=e.target as HTMLElement;
      pointer = target?.closest?.('button,input') && !target?.closest?.('.pet-peek') ? null : {x:e.clientX, y:e.clientY};
      if (peek) {
        if(reachDirection()!==null && !greeted && animation!=='peek-greet' && !paused && !document.hidden && !motion?.matches){greeted=true;animation='peek-greet';step=0;started=Date.now();clearTimeout(timer);tick();}
        return;
      }
      const direction = reachDirection();
      if ((direction !== null && (animation !== 'reach' || right !== direction))
        || (direction === null && animation === 'reach')) { clearTimeout(timer); tick(); }
    };
    const leave = () => { pointer = null; greeted=false; if (animation === 'reach') { clearTimeout(timer); tick(); } };
    window.addEventListener('mousemove', approach);
    document.documentElement.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);
    reset();
    document.addEventListener('visibilitychange', reset); motion?.addEventListener('change', reset);
    return () => { window.removeEventListener('mousemove', approach); document.documentElement.removeEventListener('mouseleave', leave); window.removeEventListener('blur', leave); clearTimeout(timer); document.removeEventListener('visibilitychange', reset); motion?.removeEventListener('change', reset); };
  }, [peek, style, emergeFrom, held, paused]);
  const frame = held ? 0 : peek ? 11 : emergeFrom ? ({left: 3, right: 1, top: 0, bottom: 2, 'top-left': 3, 'top-right': 1, 'bottom-left': 3, 'bottom-right': 1}[emergeFrom]) : pose.frame;
  const action = !peek && !emergeFrom && !held && pose.animation in actionAnimations;
  const atlas = held ? heldFrames[style] : action ? actionFrames[style] : frames[style];
  const [x, y, width, height] = atlas.frames[frame];
  const source=(held ? heldSheets : action ? actionSheets : sheets)[style];
  return <span className={`pet-avatar pet-cat ${style}${peek ? ' peek' : ''}${emergeFrom ? ` emerge from-${emergeFrom}` : ''} motion-${held ? 'held' : pose.animation}${landing ? ' landing' : ''}${action && pose.animation==='reach' && pose.right ? ' reach-right' : ''}`} ref={avatarRef} aria-hidden="true" data-cat-frame={frame} data-pet-sheet={held ? 'held' : action ? 'actions' : 'base'}>
    <svg className="pet-cat-sprite" viewBox={atlas.frames[frame].join(' ')} preserveAspectRatio="xMidYMax meet">
      <defs><clipPath id={clipId}><rect x={x} y={y} width={width} height={height} /></clipPath></defs>
      <image href={source} width={atlas.width} height={atlas.height} clipPath={`url(#${clipId})`} />
      {peek&&<PeekDetails style={style} closed={pose.frame===1} source={source} atlas={atlas} id={clipId}/> }
    </svg>
    {(pose.animation === 'sleep' || pose.animation === 'drool') && !peek && !emergeFrom && <span className="pet-sleep-mark">z</span>}
  </span>;
});
