import { resolveMarks, fontForMark, fontSizeForMark } from './objects';
export { resolveMarks, markBounds, hitTestMark, hitTestMarks, moveMark, resizeMark, fontSizeForMark, fontForMark } from './objects';
export type { IdentifiedMark } from './objects';
export type Tool = 'crop' | 'rectangle' | 'ellipse' | 'arrow' | 'pen' | 'mosaic' | 'text' | 'emoji';
export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Mark = { id?: string; tool: Exclude<Tool, 'crop'>; points: Point[]; color: string; width: number; fontSize?: number; blockSize?: number; text?: string };
export type Edit = { crop: Rect } | { mark: Mark } | { change: { id: string; mark: Mark | null } };
export const MAX_EDITS = 200;
export const MAX_POINTS = 4096;
export function rectangle(a: Point, b: Point): Rect {
  return { x: Math.floor(Math.min(a.x,b.x)), y: Math.floor(Math.min(a.y,b.y)), width: Math.max(1,Math.floor(Math.abs(a.x-b.x))), height: Math.max(1,Math.floor(Math.abs(a.y-b.y))) };
}
export function currentCrop(edits: Edit[], width: number, height: number): Rect {
  for (let i=edits.length-1;i>=0;i--) if ('crop' in edits[i]) return (edits[i] as {crop:Rect}).crop;
  return { x:0,y:0,width,height };
}
export function drawMark(ctx: CanvasRenderingContext2D, mark: Mark) {
  const a = mark.points[0], b = mark.points.at(-1)!;
  if (!a) return;
  const r = rectangle(a,b);
  ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = mark.width; ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();
  if (mark.tool === 'rectangle') ctx.strokeRect(r.x,r.y,r.width,r.height);
  else if (mark.tool === 'ellipse') { ctx.ellipse(r.x+r.width/2,r.y+r.height/2,r.width/2,r.height/2,0,0,Math.PI*2);ctx.stroke(); }
  else if (mark.tool === 'pen' || mark.tool === 'arrow') {
    ctx.moveTo(a.x,a.y);for(const p of mark.points.slice(1))ctx.lineTo(p.x,p.y);ctx.stroke();
    if(mark.tool==='pen'&&mark.points.length===1){ctx.arc(a.x,a.y,mark.width/2,0,Math.PI*2);ctx.fill();}
    if(mark.tool==='arrow') {const angle=Math.atan2(b.y-a.y,b.x-a.x),size=Math.max(12,mark.width*4);ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-size*Math.cos(angle-.45),b.y-size*Math.sin(angle-.45));ctx.lineTo(b.x-size*Math.cos(angle+.45),b.y-size*Math.sin(angle+.45));ctx.closePath();ctx.fill();}
  } else if(mark.tool==='text'||mark.tool==='emoji') {
    const fontSize=fontSizeForMark(mark);
    ctx.font=fontForMark(mark);ctx.textBaseline='top';
    const lineHeight=fontSize*1.3;(mark.text??'').split('\n').slice(0,30).forEach((line,i)=>ctx.fillText(line,a.x,a.y+i*lineHeight));
  } else if(mark.tool==='mosaic') {
    // Pixelate only the selected region. The exported PNG is flattened.
    const tile=document.createElement('canvas'),block=mark.blockSize??Math.max(12,mark.width*5);
    tile.width=Math.max(1,Math.ceil(r.width/block));tile.height=Math.max(1,Math.ceil(r.height/block));
    const small=tile.getContext('2d')!;small.drawImage(ctx.canvas,r.x,r.y,r.width,r.height,0,0,tile.width,tile.height);
    ctx.imageSmoothingEnabled=false;ctx.drawImage(tile,0,0,tile.width,tile.height,r.x,r.y,r.width,r.height);tile.width=tile.height=0;
  }
  ctx.restore();
}
export function renderScreenshot(canvas: HTMLCanvasElement, image: HTMLImageElement, edits: Edit[], preview?: Mark) {
  const ctx=canvas.getContext('2d')!;
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);
  const marks=resolveMarks(edits);
  let replaced=false;
  for(const mark of marks) {
    if(preview?.id===mark.id) {drawMark(ctx,preview);replaced=true;}
    else drawMark(ctx,mark);
  }
  if(preview&&!replaced)drawMark(ctx,preview);
}
export function exportScreenshot(canvas: HTMLCanvasElement, crop: Rect) {
  const output=document.createElement('canvas');output.width=crop.width;output.height=crop.height;
  try {output.getContext('2d')!.drawImage(canvas,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);return output.toDataURL('image/png');}
  finally{output.width=output.height=0;}
}
