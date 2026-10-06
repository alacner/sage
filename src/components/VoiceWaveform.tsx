import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Overlay below the composer, outside clipped layout containers; never shifts the input. */
export function VoiceWaveform({ anchor, levels, label }: { anchor: RefObject<HTMLDivElement>; levels: number[]; label: string }) {
  const [rect, setRect] = useState<{left:number;top:number;width:number;height:number}>();
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const update = () => {
      const r = element.getBoundingClientRect();
      setRect({left:r.left+12,top:r.bottom+2,width:Math.max(0,r.width-24),height:Math.max(0,Math.min(34,window.innerHeight-r.bottom-4))});
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    window.addEventListener('resize',update); window.addEventListener('scroll',update,true);
    return () => { observer.disconnect(); window.removeEventListener('resize',update); window.removeEventListener('scroll',update,true); };
  }, [anchor]);
  if (!rect) return null;
  const count = Math.max(1, Math.floor(rect.width / 5));
  const samples = levels.slice(-count);
  const empty = count - samples.length;
  return createPortal(<div className="chat-voice-waveform" role="status" aria-label={label} style={rect}>
    <svg width="100%" height="100%" viewBox={`0 0 ${rect.width} 34`} preserveAspectRatio="none" aria-hidden="true">
      {Array.from({length:count},(_,i)=>{
        const sample = samples[i-empty];
        const level = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
        const h = Math.max(2, level*30);
        return <rect key={i} x={(i+0.5)*rect.width/count-1} y={(34-h)/2} width="2" height={h} rx="1" style={{opacity:sample===undefined?0.28:0.7}}/>;
      })}
    </svg>
  </div>,document.body);
}
