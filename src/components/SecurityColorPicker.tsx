import {useSecurityCopy} from './SecurityProfileIcon';
const base=['#ffffff','#171717','#e7e6e6','#17365d','#176582','#ed7d31','#1e702b','#13a4c8','#96358f','#51a52a'];
const standard=['#c00000','#ff0000','#ffc000','#ffff00','#92d050','#00b050','#00b0f0','#0070c0','#002060','#7030a0'];
function shade(hex:string,amount:number){const n=parseInt(hex.slice(1),16);return '#'+[16,8,0].map(shift=>{const c=(n>>shift)&255;return Math.round(amount>0?c+(255-c)*amount:c*(1+amount)).toString(16).padStart(2,'0');}).join('');}
export function SecurityColorPicker({value,onChange,onSelect}:{value:string;onChange:(color:string)=>void;onSelect?:()=>void}){
 const copy=useSecurityCopy();
 const swatch=(color:string,key:string)=><button type="button" key={key} aria-label={color} aria-pressed={value.toLowerCase()===color} style={{background:color}} onClick={()=>{onChange(color);onSelect?.();}}/>;
 const neutral=[['#f2f2f2','#d9d9d9','#bfbfbf','#a6a6a6','#808080'],['#808080','#595959','#404040','#262626','#0d0d0d'],['#d0cece','#aeabab','#757171','#514e4e','#343232']];
 return <div className="security-color-palette" role="group" aria-label={copy('颜色','Color')}>
  <div className="security-theme-section"><span>{copy('主题颜色','Theme colors')}</span><div className="security-theme-colors">{base.map((color,i)=><div key={color}>{swatch(color,`${i}-base`)}<div className="security-theme-shades">{(neutral[i]??[.8,.6,.35,-.25,-.5].map(a=>shade(color,a))).map((c,j)=>swatch(c,`${i}-${j}`))}</div></div>)}</div></div>
  <div className="security-standard-section"><span>{copy('标准颜色','Standard colors')}</span><div className="security-standard-colors">{standard.map(color=>swatch(color,color))}</div></div>
  <label className="security-more-colors"><input type="color" aria-label={copy('自定义颜色','Custom color')} value={value} onChange={e=>{onChange(e.target.value);onSelect?.();}}/>{copy('更多颜色…','More colors…')}</label>
 </div>;
}
