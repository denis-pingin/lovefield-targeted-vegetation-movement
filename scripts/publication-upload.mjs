import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, stat, open, realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {publicationCredentialReader} from './publication-auth.mjs';
import {PUBLICATION_API_BASE, PUBLIC_BASE, canonicalHostedStudyPath} from '../web/study-paths.mjs';

export const PUBLICATION_ORIGINS = Object.freeze({test: 'https://test.lab.sourceof.love', production: 'https://lab.sourceof.love'});
const API = PUBLICATION_API_BASE, PUBLIC = PUBLIC_BASE;
const PART_SIZE = 8 * 1024 * 1024, HASH = /^[a-f0-9]{64}$/;
class UploadError extends Error { safe = true; }
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function originFor(environment) {
  const origin = PUBLICATION_ORIGINS[environment]; if (!origin) throw new UploadError('Choose the Test or Production publication environment.'); return origin;
}
async function transport({environment, credentialReader, fetch = globalThis.fetch, onProgress = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const origin = originFor(environment), credentials = await credentialReader(environment);
  if (!credentials?.clientId || !credentials?.clientSecret) throw new UploadError('The selected publication service identity is unavailable.');
  return async (path, method = 'GET', body, extraHeaders = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response, reason;
      try {
        response = await fetch(origin + API + path, {method, redirect: 'manual', signal: AbortSignal.timeout(120000),
          headers: {'CF-Access-Client-Id': credentials.clientId, 'CF-Access-Client-Secret': credentials.clientSecret,
            ...(body === undefined ? {} : {'Content-Type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json'}), ...extraHeaders},
          ...(body === undefined ? {} : {body: body instanceof Uint8Array ? body : JSON.stringify(body)})});
      } catch (error) {
        reason = `Network ${['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error'}`;
        if (attempt === 2) throw new UploadError('Publication connection failed. Resume this same publication after resolving the connection.');
      }
      if (response) {
        if (response.status >= 300 && response.status < 400 || response.redirected || response.url && new URL(response.url).origin !== origin) throw new UploadError('Publication redirect was refused; the selected service identity stays on its fixed origin.');
        if (response.ok) {
          try { return await response.json(); } catch { throw new UploadError('The publication service returned an invalid response. Resume the same job.'); }
        }
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
          let code; try { code = (await response.json()).code; } catch { code = null; }
          const freshSnapshot = {inventory_changed: 'The collected inventory changed. Import the latest series bundle and prepare a new publication.',
            publication_stale: 'Another publication became current. Prepare a new publication using the current destination state.',
            correction_reason_required: 'A previously selected analysis changed. Prepare a new publication with its correction reason.'}[code];
          if (freshSnapshot) { const error = new UploadError(freshSnapshot); error.code = code; error.requiresNewSnapshot = true; throw error; }
          const safeCode = typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? ` (${code})` : '';
          throw new UploadError(`Publication request failed with HTTP ${response.status}${safeCode}. Resolve this failure before resuming the same job.`);
        }
        reason = `HTTP ${response.status}`;
        if (attempt === 2) throw new UploadError(`Publication service is unavailable (HTTP ${response.status}). Resume the same publication later.`);
      }
      onProgress({stage: method === 'PUT' ? 'Retrying upload part' : 'Retrying publication request', attempt: attempt + 2, operation: `${method} ${path}`, reason});
      await sleep(500 * 2 ** attempt);
    }
  };
}

export async function readPublicationInventory({seriesId, softwareTest = false, ...options}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(seriesId) || softwareTest && options.environment !== 'test') throw new UploadError('Choose a scored series in the selected publication environment.');
  const request = await transport(options);
  return request(`series/${encodeURIComponent(seriesId)}/inventory${softwareTest ? '?softwareTest=true' : ''}`);
}

export async function uploadPublication({manifestPath, manifestSha256, localFiles, environment, onProgress = () => {}, ...options}) {
  const origin = originFor(environment);
  let manifestJson, manifest;
  try {
    if ((await stat(manifestPath)).size > 2 * 1024 * 1024) throw new Error('Too large');
    manifestJson = await readFile(manifestPath, 'utf8'); manifest = JSON.parse(manifestJson);
  } catch { throw new UploadError('The retained publication manifest is missing or invalid.'); }
  if (manifest.environment !== environment) throw new UploadError('The retained publication environment differs from its selected destination.');
  if (digest(Buffer.from(manifestJson, 'utf8')) !== manifestSha256) throw new UploadError('The retained publication manifest changed. Prepare a new snapshot.');
  const files = Object.entries(manifest.files), total = files.reduce((sum, [, file]) => sum + file.size, 0);
  let verifiedBytes = 0;
  onProgress({stage: 'Verifying publication files', completed: 0, total, unit: 'bytes'});
  for (const [hash, file] of files) {
    if (!HASH.test(hash) || file.sha256 !== hash || !Number.isSafeInteger(file.size) || file.size < 0 || !localFiles[hash]) throw new UploadError('A retained publication file has an invalid identity.');
    try {
      if ((await stat(localFiles[hash])).size !== file.size) throw new Error('Size changed');
      const calculation = createHash('sha256');
      for await (const part of createReadStream(localFiles[hash], {highWaterMark: PART_SIZE})) {
        calculation.update(part); verifiedBytes += part.length;
        onProgress({stage: 'Verifying publication files', completed: verifiedBytes, total, unit: 'bytes'});
      }
      if (calculation.digest('hex') !== hash) throw new Error('Hash changed');
    } catch { throw new UploadError('A retained publication file changed or is missing. Prepare a new snapshot before uploading.'); }
  }
  const request = await transport({environment, onProgress, ...options});
  const state = await request('jobs', 'POST', {manifestJson, manifestSha256});
  if (state.publicationId !== manifest.publicationId || state.manifestSha256 !== manifestSha256 || state.partSize !== PART_SIZE) throw new UploadError('The publication service returned a mismatching snapshot identity.');
  const path = `jobs/${manifest.publicationId}`;
  let completed = 0;
  if (state.status !== 'completed') {
    for (const [hash, file] of files) {
      if (state.verifiedFiles.includes(hash)) { completed += file.size; onProgress({stage: 'Uploading publication', completed, total, unit: 'bytes'}); continue; }
      const upload = await request(`${path}/files/${hash}`, 'POST', {});
      if (upload.verified) { completed += file.size; continue; }
      if (upload.partSize !== PART_SIZE) throw new UploadError('The upload part size differs from the publication contract.');
      let source;
      try { source = await open(localFiles[hash], 'r'); }
      catch { throw new UploadError('A retained publication file is missing. Prepare a new snapshot.'); }
      try {
        for (let offset = 0, number = 1; offset < file.size; offset += PART_SIZE, number++) {
          const size = Math.min(PART_SIZE, file.size - offset), part = Buffer.allocUnsafe(size);
          let read = 0;
          while (read < size) { const value = await source.read(part, read, size - read, offset + read); if (!value.bytesRead) throw new UploadError('A retained publication file changed during upload.'); read += value.bytesRead; }
          const partHash = digest(part), accepted = upload.parts?.find(item => item.partNumber === number);
          if (accepted) {
            if (accepted.sha256 !== partHash || accepted.size !== size) throw new UploadError('An accepted upload part differs from the retained original. Prepare a new snapshot.');
          } else await request(`${path}/files/${hash}/parts/${number}`, 'PUT', part, {'X-Content-Sha256': partHash});
          completed += size; onProgress({stage: 'Uploading publication', completed, total, unit: 'bytes'});
        }
      } finally { await source.close(); }
      onProgress({stage: 'Verifying uploaded file', completed, total, unit: 'bytes'});
      await request(`${path}/files/${hash}/complete`, 'POST', {});
    }
  }
  onProgress({stage: 'Committing publication', completed: total, total, unit: 'bytes'});
  const receipt = state.status === 'completed' ? state.receipt : await request(`${path}/commit`, 'POST', {});
  if (receipt.publicationId !== manifest.publicationId || receipt.status !== 'completed') throw new UploadError('Publication completion returned a mismatching identity.');
  const safeReceipt = {publicationId: receipt.publicationId, seriesId: manifest.seriesId, status: 'completed', completedAtMs: receipt.completedAtMs};
  for (const name of ['resultsUrl', 'recordingsUrl']) {
    const link = new URL(receipt[name], origin);
    link.pathname = canonicalHostedStudyPath(link.pathname);
    if (link.origin !== origin || !link.pathname.startsWith(PUBLIC)) throw new UploadError('Publication completion returned an invalid result link.');
    safeReceipt[name] = link.href;
  }
  onProgress({stage: 'Publication completed', completed: total, total, unit: 'bytes'});
  return safeReceipt;
}

async function main(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index], value = arguments_[index + 1];
    if (!['--job', '--environment', '--series', '--software-test', '--credential-source'].includes(name) || value === undefined) throw new UploadError('Use --job or --series, --environment, and an explicit optional --credential-source.');
    options[name.slice(2)] = value;
  }
  const credentialReader = publicationCredentialReader({source: options['credential-source'] ?? 'keychain'});
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (options.job) {
    const job = JSON.parse(await readFile(options.job, 'utf8'));
    emit({type: 'result', value: await uploadPublication({...job, environment: options.environment, credentialReader, onProgress: value => emit({type: 'progress', value})})});
  } else if (options.series) emit({type: 'result', value: await readPublicationInventory({seriesId: options.series, environment: options.environment, softwareTest: options['software-test'] === 'true', credentialReader})});
  else throw new UploadError('Choose a retained publication job or scored series.');
}
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stdout.write(JSON.stringify({type: 'error', message: error.safe ? error.message : 'Publication transport failed. Resume the same job after resolving the failure.', ...(error.safe && error.requiresNewSnapshot ? {code: error.code, requiresNewSnapshot: true} : {})}) + '\n'); process.exitCode = 1;
  });
}
