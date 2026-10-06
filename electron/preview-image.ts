/** Read a user-selected preview for copy/download without renderer CORS restrictions. */
export async function readPreviewImage(source: string) {
  const url = new URL(source);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Unsupported preview URL');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw Error('Image unavailable');
  const mimeType = (response.headers.get('content-type') || '').split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) throw Error('Unsupported image format');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 20 * 1024 * 1024) throw Error('Image exceeds 20 MB'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return { mimeType, bytes: new Uint8Array(Buffer.concat(chunks)) };
}
