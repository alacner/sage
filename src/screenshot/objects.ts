import type { SelectionHandle } from '../../shared/screenshot-selection';
import type { Edit, Mark, Point, Rect } from './drawing';

export type IdentifiedMark = Mark & { id: string };
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const normalizedRect = (a: Point, b: Point): Rect => ({ x:Math.min(a.x,b.x), y:Math.min(a.y,b.y), width:Math.max(1,Math.abs(a.x-b.x)), height:Math.max(1,Math.abs(a.y-b.y)) });

/** Replay immutable object commands; their original paint order never changes. */
export function resolveMarks(edits: readonly Edit[]): IdentifiedMark[] {
  const order: string[] = [], marks = new Map<string, IdentifiedMark | null>();
  edits.forEach((edit,index) => {
    if ('mark' in edit) {
      const id = edit.mark.id || `legacy-${index}`;
      if (!marks.has(id)) order.push(id);
      marks.set(id, {...edit.mark,id});
    } else if ('change' in edit && marks.has(edit.change.id)) {
      marks.set(edit.change.id,edit.change.mark ? {...edit.change.mark,id:edit.change.id} : null);
    }
  });
  return order.flatMap(id => { const mark=marks.get(id); return mark ? [mark] : []; });
}

export function fontSizeForMark(mark: Mark) {
  return mark.fontSize ?? (mark.tool==='emoji' ? Math.max(32,mark.width*10) : Math.max(18,mark.width*6));
}
export function fontForMark(mark: Mark) {
  return `${fontSizeForMark(mark)}px -apple-system, BlinkMacSystemFont, sans-serif`;
}
function arrowHead(mark: Mark): Point[] {
  const a=mark.points[0],b=mark.points.at(-1);
  if(!a||!b)return [];
  const angle=Math.atan2(b.y-a.y,b.x-a.x),size=Math.max(12,mark.width*4);
  return [b,{x:b.x-size*Math.cos(angle-.45),y:b.y-size*Math.sin(angle-.45)},{x:b.x-size*Math.cos(angle+.45),y:b.y-size*Math.sin(angle+.45)}];
}
function pointsBounds(points: readonly Point[]): Rect {
  if(!points.length)return {x:0,y:0,width:1,height:1};
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const p of points){left=Math.min(left,p.x);top=Math.min(top,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);}
  return {x:left,y:top,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};
}

/** Use the same real canvas font and line spacing as drawing, including emoji. */
export function markBounds(mark: Mark, ctx: CanvasRenderingContext2D): Rect {
  const a=mark.points[0];if(!a)return {x:0,y:0,width:1,height:1};
  if(mark.tool==='text'||mark.tool==='emoji') {
    const size=fontSizeForMark(mark),lines=(mark.text??'').split('\n').slice(0,30);
    let left=0,top=0,right=0,bottom=size;
    ctx.save();
    try {
      ctx.font=fontForMark(mark);ctx.textBaseline='top';
      lines.forEach((line,index)=>{
        const measured=ctx.measureText(line);
        left=Math.min(left,-(measured.actualBoundingBoxLeft||0));
        right=Math.max(right,measured.width,measured.actualBoundingBoxRight||0);
        top=Math.min(top,index*size*1.3-(measured.actualBoundingBoxAscent||0));
        bottom=Math.max(bottom,index*size*1.3+size,index*size*1.3+(measured.actualBoundingBoxDescent||0));
      });
    } finally {ctx.restore();}
    return {x:a.x+left,y:a.y+top,width:Math.max(lines.some(line=>line.length>0)?1:size*.6,right-left),height:Math.max(size,bottom-top)};
  }
  if(mark.tool==='arrow')return pointsBounds([...mark.points,...arrowHead(mark)]);
  if(mark.tool==='pen')return pointsBounds(mark.points);
  const b=mark.points.at(-1)!;
  // Rectangle, ellipse and mosaic rendering normalize and floor their region.
  const r=normalizedRect(a,b);
  return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.max(1,Math.floor(r.width)),height:Math.max(1,Math.floor(r.height))};
}
function segmentDistance(p: Point,a: Point,b: Point) {
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
  const t=length ? clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/length,0,1) : 0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
function inRect(p: Point,r: Rect,tolerance=0) {
  return p.x>=r.x-tolerance&&p.y>=r.y-tolerance&&p.x<=r.x+r.width+tolerance&&p.y<=r.y+r.height+tolerance;
}
function inTriangle(p: Point,a: Point,b: Point,c: Point) {
  const area=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(!area)return false;
  const u=((b.y-c.y)*(p.x-c.x)+(c.x-b.x)*(p.y-c.y))/area;
  const v=((c.y-a.y)*(p.x-c.x)+(a.x-c.x)*(p.y-c.y))/area;
  return u>=0&&v>=0&&u+v<=1;
}
/** Empty shape interiors do not steal clicks from objects below them. */
export function hitTestMark(mark: Mark,p: Point,ctx: CanvasRenderingContext2D,tolerance=6): boolean {
  if(!mark.points.length)return false;
  const r=markBounds(mark,ctx),distance=Math.max(0,tolerance)+Math.max(0,mark.width)/2;
  if(!inRect(p,r,distance))return false;
  if(mark.tool==='text'||mark.tool==='emoji'||mark.tool==='mosaic')return inRect(p,r,Math.max(0,tolerance));
  if(mark.tool==='rectangle') {
    const corners=[{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}];
    return corners.some((a,i)=>segmentDistance(p,a,corners[(i+1)%4])<=distance);
  }
  if(mark.tool==='ellipse') {
    const rx=r.width/2,ry=r.height/2,dx=p.x-r.x-rx,dy=p.y-r.y-ry;
    const radius=Math.hypot(dx/rx,dy/ry);if(!radius)return false;
    // Distance along the ellipse's local normal, rather than its bounding box.
    const normal=Math.hypot(dx/(rx*rx*radius),dy/(ry*ry*radius));
    return Math.abs(radius-1)/normal<=distance;
  }
  if(mark.tool==='arrow') {
    const [a,b,c]=arrowHead(mark);
    if(a&&b&&c&&(inTriangle(p,a,b,c)||segmentDistance(p,a,b)<=distance||segmentDistance(p,b,c)<=distance||segmentDistance(p,c,a)<=distance))return true;
  }
  const points=mark.points;
  if(points.length===1)return Math.hypot(p.x-points[0].x,p.y-points[0].y)<=distance;
  return points.slice(1).some((b,i)=>segmentDistance(p,points[i],b)<=distance);
}
export function hitTestMarks(marks: readonly IdentifiedMark[],p: Point,ctx: CanvasRenderingContext2D,tolerance=6) {
  for(let i=marks.length-1;i>=0;i--)if(hitTestMark(marks[i],p,ctx,tolerance))return marks[i];
  return undefined;
}

/** Delta and bounds are output pixels, just like the original annotation points. */
export function moveMark(mark: Mark,delta: Point,bounds?: Rect,ctx?: CanvasRenderingContext2D): Mark {
  let {x,y}=delta;
  if(bounds) {
    const r=ctx ? markBounds(mark,ctx) : pointsBounds(mark.points);
    x=clamp(x,bounds.x-r.x,Math.max(bounds.x-r.x,bounds.x+bounds.width-r.x-r.width));
    y=clamp(y,bounds.y-r.y,Math.max(bounds.y-r.y,bounds.y+bounds.height-r.y-r.height));
  }
  return {...mark,points:mark.points.map(p=>({x:p.x+x,y:p.y+y}))};
}

/** Eight handles scale geometry; text remains readable and mosaic cells stay fixed. */
export function resizeMark(mark: Mark,handle: SelectionHandle,p: Point,ctx: CanvasRenderingContext2D,bounds?: Rect): Mark {
  const r=markBounds(mark,ctx);
  if(bounds)p={x:clamp(p.x,bounds.x,bounds.x+bounds.width),y:clamp(p.y,bounds.y,bounds.y+bounds.height)};
  const left=handle.includes('w')?p.x:r.x,right=handle.includes('e')?p.x:r.x+r.width;
  const top=handle.includes('n')?p.y:r.y,bottom=handle.includes('s')?p.y:r.y+r.height;
  const horizontal=handle.includes('w')||handle.includes('e'),vertical=handle.includes('n')||handle.includes('s');
  if(mark.tool==='text'||mark.tool==='emoji') {
    const xScale=Math.abs(right-left)/r.width,yScale=Math.abs(bottom-top)/r.height;
    const scale=horizontal&&vertical ? Math.max(xScale,yScale) : horizontal ? xScale : yScale;
    let next:Mark={...mark,fontSize:clamp(fontSizeForMark(mark)*scale,6,5120),points:[{x:0,y:0}]};
    let measured=markBounds(next,ctx);
    if(bounds&&(measured.width>bounds.width||measured.height>bounds.height)) {
      next={...next,fontSize:Math.max(6,fontSizeForMark(next)*Math.min(bounds.width/measured.width,bounds.height/measured.height))};
      measured=markBounds(next,ctx);
    }
    const x=handle.includes('w') ? (left<=right?right-measured.width:right)
      : handle.includes('e') ? (right>=left?left:left-measured.width) : r.x+(r.width-measured.width)/2;
    const y=handle.includes('n') ? (top<=bottom?bottom-measured.height:bottom)
      : handle.includes('s') ? (bottom>=top?top:top-measured.height) : r.y+(r.height-measured.height)/2;
    next={...next,points:[{x:x-measured.x,y:y-measured.y}]};
    return bounds ? moveMark(next,{x:0,y:0},bounds,ctx) : next;
  }
  const xScale=(right-left)/r.width,yScale=(bottom-top)/r.height;
  return {...mark,points:mark.points.map(point=>({x:left+(point.x-r.x)*xScale,y:top+(point.y-r.y)*yScale}))};
}
