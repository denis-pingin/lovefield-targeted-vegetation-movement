/** Content identities and streamed R2 delivery; no scientific calculations. */
export const PART_SIZE = 8 * 1024 * 1024;
export const objectKey = hash => `sha256/${hash}`;
export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
export async function verifyObjectHash(bucket, key) {
  const object = await bucket.get(key);
  if (!object) throw new Error('The uploaded object is missing.');
  const digest = new crypto.DigestStream('SHA-256');
  await object.body.pipeTo(digest);
  return Array.from(new Uint8Array(await digest.digest), value => value.toString(16).padStart(2, '0')).join('');
}
export async function boundedBytes(request, maximum) {
  const stated = request.headers.get('Content-Length');
  if (stated !== null && (!/^\d+$/.test(stated) || Number(stated) > maximum)) throw Object.assign(new Error('The request exceeds the permitted byte length.'), {status: 413});
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks = []; let length = 0;
  for (;;) {
    const {value, done} = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw Object.assign(new Error('The request exceeds the permitted byte length.'), {status: 413}); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export function byteRange(header, size) {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || !match[1] && !match[2]) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start || !match[1] && Number(match[2]) === 0) return false;
  return {offset: start, length: end - start + 1, end};
}
export async function servePublishedFile(request, bucket, metadata) {
  const range = byteRange(request.headers.get('Range'), metadata.size);
  if (range === false) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${metadata.size}`}});
  const headers = new Headers({'Content-Type': metadata.contentType, 'Content-Length': String(range?.length ?? metadata.size),
    'Accept-Ranges': 'bytes', 'ETag': `"${metadata.sha256}"`, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`});
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${metadata.size}`);
  const object = request.method === 'HEAD' ? await bucket.head(objectKey(metadata.sha256))
    : await bucket.get(objectKey(metadata.sha256), range ? {range: {offset: range.offset, length: range.length}} : undefined);
  if (!object || object.size !== metadata.size) return new Response('Published file unavailable.', {status: 404});
  return new Response(request.method === 'HEAD' ? null : object.body, {status: range ? 206 : 200, headers});
}
