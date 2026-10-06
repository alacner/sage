import { deflateSync } from 'node:zlib';
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, bytes: Buffer) {
  const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type,bytes])));
  return Buffer.concat([size,type,bytes,crc]);
}
/** Valid 64×64 RGB PNG: red top half, blue bottom half. No external fetch needed. */
export function visionProbePng(): string {
  const header = Buffer.alloc(13); header.writeUInt32BE(64,0); header.writeUInt32BE(64,4); header[8]=8; header[9]=2;
  const pixels = Buffer.alloc(64*(1+64*3));
  for(let y=0;y<64;y++) for(let x=0;x<64;x++) pixels[y*193+1+x*3+(y<32?0:2)] = 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
