import type { PetStyle } from './avatar';

// Eyelids reuse a small forehead patch from each original atlas, preserving
// the pet's fur texture instead of placing a flat-colored shape over its eyes.
const details = {
  pixel: {eyes:[[1224,954,19,18],[1300,954,19,18]],fur:[1254,914,16,16]},
  comic: {eyes:[[1225,949,23,23],[1318,949,23,23]],fur:[1258,901,24,24]},
  'dog-pixel': {eyes:[[1231,946,17,18],[1308,946,17,18]],fur:[1258,904,20,20]},
  'dog-comic': {eyes:[[1240,968,20,22],[1314,968,20,22]],fur:[1264,920,24,24]},
} as const;

export function PeekDetails({style,closed,source,atlas,id}:{
  style:PetStyle;closed:boolean;source:string;atlas:{width:number;height:number};id:string;
}) {
  const config=details[style];
  return <>
    {closed&&<g className="pet-peek-eyelids">{config.eyes.map(([cx,cy,ex,ey],i)=><g key={i}>
      <defs><clipPath id={`${id}-eye-${i}`}><ellipse cx={cx} cy={cy} rx={ex+2} ry={ey+2}/></clipPath></defs>
      <g clipPath={`url(#${id}-eye-${i})`}><svg x={cx-ex-2} y={cy-ey-2} width={ex*2+4} height={ey*2+4} viewBox={config.fur.join(' ')} preserveAspectRatio="none"><image href={source} width={atlas.width} height={atlas.height}/></svg></g>
      <path d={`M ${cx-ex*.85} ${cy} Q ${cx} ${cy+ey*.65} ${cx+ex*.85} ${cy}`} fill="none" stroke="#443d36" strokeWidth={style.includes('pixel')?5:3} strokeLinecap="round"/>
    </g>)}</g>}
  </>;
}
