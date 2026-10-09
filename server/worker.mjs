import {STUDY_NAME, STUDY_BASE, canonicalHostedStudyPath, PUBLIC_BASE, PUBLIC_API_BASE, HOSTED_APP_BASE, HOSTED_API_BASE, PUBLICATION_API_BASE, LOCAL_ANALYSIS_BASE, PUBLIC_ASSETS, labPageForPath} from '../web/study-paths.mjs';
import {createPublicationService} from './publication.mjs';
import {EXPERIMENT, validateConfig} from '../web/run-config.mjs';
import {applyEvent, createRunState, localEligibility, nextDeadline, publicRunState} from './run-engine.mjs';
import {createAccessAuthenticator} from './access.mjs';
import {SessionStore, terminalEventTime} from './session-store.mjs';
import {RandomService} from './random-service.mjs';
import {canonicalJson} from './random-service.mjs';
import analysisProfile from '../analysis-profile.json' with {type: 'json'};
import {createStartChain, configurationForEnvironment} from './start-chain.mjs';
import {createStartRegistry} from './start-registry.mjs';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
  });
}

function html(value) {
  return new Response(value, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
}

function selector(experiment) {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lovefield Lab</title><link rel="stylesheet" href="${experiment.basePath}app.css"></head><body><main><h1>Lovefield Lab</h1><div class="button-row"><a href="/wind-prestudy/">Wind pre-study</a><a href="${HOSTED_APP_BASE}">${STUDY_NAME}</a></div></main></body></html>`);
}

async function bodyObject(request) {
  let value;
  try { value = await request.json(); } catch { throw new HttpError(400, 'invalid_json', 'Send a JSON object.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_body', 'Send a JSON object.');
  }
  return value;
}

function rejectForeignIdentity(body, experiment) {
  if (body.experimentSlug != null && body.experimentSlug !== experiment.slug) {
    throw new HttpError(400, 'experiment_mismatch', 'This request belongs to another experiment.');
  }
}

function routeFor(pathname, experiment) {
  const canonicalPath = canonicalHostedStudyPath(pathname);
  if (canonicalPath !== pathname) {
    const route = routeFor(canonicalPath, experiment);
    if (!route || ['api', 'publicApi', 'publicationApi'].includes(route.kind)) return route;
    return {...route, kind: 'redirect', destination: route.destination ?? canonicalPath};
  }
  if (pathname === '/') return {kind: 'selector'};
  if (labPageForPath(pathname)) return {kind: 'asset', asset: 'public-study', public: true};
  if (pathname === STUDY_BASE || pathname === STUDY_BASE.slice(0, -1)) return {kind: 'redirect', destination: PUBLIC_BASE, public: true};
  if (pathname === HOSTED_APP_BASE.slice(0, -1)) return {kind: 'redirect', destination: HOSTED_APP_BASE};
  if (pathname.startsWith(PUBLIC_API_BASE)) {
    const path = pathname.slice(PUBLIC_API_BASE.length);
    if (path === 'latest' || path === 'status' || /^publications\/[a-f0-9-]{36}(?:\/(?:manifest|reports\/[a-f0-9]{64}|files\/[a-f0-9]{64}\/[^/]+))?$/.test(path)) return {kind: 'publicApi', path, public: true};
    return null;
  }
  if (pathname.startsWith(PUBLIC_BASE)) {
    const path = pathname.slice(PUBLIC_BASE.length);
    if (PUBLIC_ASSETS.includes(path)) return {kind: 'asset', asset: path, public: true};
    if (/^(?:|about|results|recordings(?:\/[A-Za-z0-9_-]{1,80})?|protocol|methods(?:\/analysis)?|reproducibility)\/?$/.test(path)) return {kind: 'asset', asset: 'public-study', public: true};
    return null;
  }
  if (pathname.startsWith(PUBLICATION_API_BASE)) return {kind: 'publicationApi'};
  if (pathname.startsWith(HOSTED_API_BASE)) return {kind: 'api', path: pathname.slice(HOSTED_API_BASE.length)};
  if (pathname === HOSTED_APP_BASE) return {kind: 'asset', asset: ''};
  if (pathname.startsWith(HOSTED_APP_BASE) && /^(?:index\.html|[a-z0-9-]+\.(?:mjs|css|mp3))$/.test(pathname.slice(HOSTED_APP_BASE.length))) return {kind: 'asset', asset: pathname.slice(HOSTED_APP_BASE.length)};
  if (pathname === experiment.basePath || pathname === experiment.basePath.slice(0, -1) || pathname === `${experiment.basePath}index.html`) return {kind: 'redirect', destination: HOSTED_APP_BASE};
  if (pathname === LOCAL_ANALYSIS_BASE || pathname === LOCAL_ANALYSIS_BASE.slice(0, -1)) return {kind: 'macInstructions'};
  if (pathname.startsWith(experiment.apiBasePath)) return {kind: 'api', path: pathname.slice(experiment.apiBasePath.length)};
  const asset = pathname.slice(experiment.basePath.length);
  if (pathname.startsWith(experiment.basePath) && /^(?:[a-z0-9-]+\.(?:mjs|css|mp3))$/.test(asset)) return {kind: 'asset', asset};
  return null;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new HttpError(400, 'invalid_identifier', `${label} needs a valid identifier.`);
  }
  return value;
}

function position(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90 ||
      !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180 ||
      !Number.isFinite(value.accuracyMetres) || value.accuracyMetres < 0 ||
      !Number.isFinite(value.capturedAtMs) ||
      typeof value.deviceId !== 'string' || !value.deviceId.trim()) {
    throw new HttpError(400, 'invalid_position', 'A position needs latitude, longitude, accuracy, time and device.');
  }
  return structuredClone(value);
}

function positions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new HttpError(400, 'invalid_positions', 'Supply at least one captured position.');
  }
  const result = {};
  for (const [name, point] of Object.entries(value)) {
    if (!['practice', 'waiting', 'departure'].includes(name)) {
      throw new HttpError(400, 'invalid_position_role', 'Position role must be practice, waiting or departure.');
    }
    result[name] = position(point);
  }
  return result;
}

function polygon(value, imageSize) {
  if (!Array.isArray(value) || value.length < 3 || !value.every(point => Array.isArray(point) &&
      point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
      point[0] >= 0 && point[0] < imageSize.width && point[1] >= 0 && point[1] < imageSize.height)) {
    throw new HttpError(400, 'invalid_polygon', 'Each region needs at least three in-frame pixel points.');
  }
  const area = value.reduce((sum, point, index) => {
    const next = value[(index + 1) % value.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (Math.abs(area) < 1) throw new HttpError(400, 'invalid_polygon', 'A region polygon needs nonzero area.');
  for (let first = 0; first < value.length; first++) {
    for (let second = first + 2; second < value.length; second++) {
      if (first === 0 && second === value.length - 1) continue;
      if (segmentsIntersect(value[first], value[(first + 1) % value.length],
        value[second], value[(second + 1) % value.length])) {
        throw new HttpError(400, 'invalid_polygon', 'A region polygon cannot cross itself.');
      }
    }
  }
  return structuredClone(value);
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, c) {
  return Math.abs(orientation(a, b, c)) < 1e-9 &&
    c[0] >= Math.min(a[0], b[0]) && c[0] <= Math.max(a[0], b[0]) &&
    c[1] >= Math.min(a[1], b[1]) && c[1] <= Math.max(a[1], b[1]);
}

function segmentsIntersect(a, b, c, d) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (first * second < 0 && third * fourth < 0) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function pointInside(point, polygonPoints) {
  let inside = false;
  for (let index = 0, previous = polygonPoints.length - 1; index < polygonPoints.length; previous = index++) {
    const a = polygonPoints[index];
    const b = polygonPoints[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function polygonsOverlap(left, right) {
  if (left.some(point => pointInside(point, right)) || right.some(point => pointInside(point, left))) return true;
  for (let a = 0; a < left.length; a++) {
    for (let b = 0; b < right.length; b++) {
      if (segmentsIntersect(left[a], left[(a + 1) % left.length], right[b], right[(b + 1) % right.length])) return true;
    }
  }
  return false;
}

function setupRecord(body, actor, nowMs, experiment) {
  if (typeof body.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.imageSha256) ||
      !Number.isSafeInteger(body.imageSize?.width) || body.imageSize.width < 1 ||
      !Number.isSafeInteger(body.imageSize?.height) || body.imageSize.height < 1 ||
      typeof body.cameraProfile !== 'string' || !body.cameraProfile.trim() ||
      !body.regions || typeof body.regions !== 'object') {
    throw new HttpError(400, 'invalid_setup', 'Setup needs image hash, dimensions, camera profile and regions.');
  }
  const regions = {};
  for (const name of ['A', 'B', 'background']) {
    regions[name] = polygon(body.regions[name], body.imageSize);
  }
  if (Object.keys(body.regions).some(name => !['A', 'B', 'background'].includes(name)) ||
      polygonsOverlap(regions.A, regions.B) ||
      polygonsOverlap(regions.A, regions.background) ||
      polygonsOverlap(regions.B, regions.background)) {
    throw new HttpError(400, 'overlapping_regions', 'A, B and background regions must be separate.');
  }
  return {setupId: crypto.randomUUID(), experimentSlug: experiment.slug,
    imageSha256: body.imageSha256, imageSize: structuredClone(body.imageSize),
    cameraProfile: body.cameraProfile, regions, retrospective: body.retrospective === true,
    createdAtMs: nowMs, actor: actor.id};
}

function metadataKey(experiment, type, id) {
  return `${experiment.slug}:${type}:${id}`;
}

function selectedProfile(config, supplied, savedSource = false) {
  const builtin = analysisProfile;
  const profile = supplied ?? builtin;
  if (!profile || profile.profileId !== config.analysisProfileId ||
      profile.version !== analysisProfile.version ||
      !savedSource && canonicalJson(profile) !== canonicalJson(builtin)) {
    throw new HttpError(400, 'invalid_profile', 'Use the complete current technical profile matching the run settings.');
  }
  return structuredClone(profile);
}

async function hashJson(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function publicSeries(series) {
  return {...structuredClone(series), qualificationStatus:
    qualified(series) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(series.codeCheckpoint) ? 'ready' : 'incomplete',
    collectionRunIds: [...series.members].filter(item => item.collectionStartedAtMs != null)
      .sort((left, right) => left.collectionStartedAtMs - right.collectionStartedAtMs || left.runId.localeCompare(right.runId)).map(item => item.runId)};
}

function qualified(series) {
  const checks = ['software', 'realFootage', 'phone', 'clock'];
  return series.qualification?.profileHash === series.profileHash &&
    series.qualification?.codeCheckpoint === series.codeCheckpoint &&
    checks.every(name => series.qualification[name] === 'pass');
}

async function metadataList(storage, experiment, type) {
  const ids = await storage.get(metadataKey(experiment, type, 'index')) ?? [];
  return Promise.all(ids.map(id => storage.get(metadataKey(experiment, type, id))));
}

async function metadataCreate(storage, experiment, type, id, record) {
  await storage.transaction(async transaction => {
    const indexKey = metadataKey(experiment, type, 'index');
    const index = await transaction.get(indexKey) ?? [];
    if (index.includes(id)) throw new HttpError(409, 'duplicate_identifier', 'That identifier already exists.');
    await transaction.put(metadataKey(experiment, type, id), record);
    await transaction.put(indexKey, [...index, id]);
  });
}

function publicRecord(record, nowMs) {
  const state = record.state;
  return {experimentSlug: record.experimentSlug, ...publicRunState(state, nowMs), config: structuredClone(record.config),
    tag: record.tag ?? null,
    createdAtMs: state.createdAtMs ?? null,
    collectionStartedAtMs: state.collectionStartedAtMs ?? null,
    recordingStartedAtMs: state.recordingStartedAtMs ?? null,
    finishedAtMs: state.finishedAtMs ?? terminalEventTime(state.lifecycle, record.events),
    instructionAudioPending: state.cues?.at(-1)?.deliveryStatus === 'pending' ||
      state.cues?.at(-1)?.deliveryStatus === 'played' && state.cues.at(-1).endedAtMs == null,
    siteSnapshot: state.siteSnapshot ?? null, setupSnapshot: state.setupSnapshot ?? null,
    setupId: state.setupSnapshot?.setupId ?? record.config.setupId ?? null,
    setupStatus: state.setupSnapshot?.retrospective ? 'retrospective' : state.setupSnapshot ? 'prospective' : 'missing',
    playbackDeviceId: state.playbackDeviceId ?? null,
    recordingReady: state.recordingReady === true,
    testAudioPlayed: state.testAudioPlayed === true,
    passiveReading: state.passiveReading ?? null,
    clockReferenceCount: record.clockReferences?.length ?? 0,
    seriesId: record.config.seriesId ?? null,
    startRegistration: structuredClone(record.startRegistration ?? null),
    startIssues: record.events.filter(event => event.kind === 'startIssueReported').map(event => structuredClone(event.data)),
    streamUrl: record.events.findLast(event => event.kind === 'startStreamAttached')?.data.streamUrl ?? null};
}

function ticketPlan(config) {
  return Array.from({length: config.tree.count}, (_, index) => ({
    stream: 'tree', opportunityId: `trial-${index + 1}`, rules: {'0': 'A', '1': 'B'},
  }));
}

function opportunityFor(state, stream) {
  if (stream === 'local') return `comparison-${state.currentComparison.index}`;
  if (stream === 'tree') return `trial-${state.currentTrial?.index ?? state.completedCount + 1}`;
  return `phase-${stream}`;
}

function engineEvent(kind, nowMs, data = {}) {
  return {kind, serverAtMs: nowMs, ...data};
}

function recordedEvent(kind, nowMs, actionId, actor, data = {}, clientAtMs = null) {
  return {kind, serverAtMs: nowMs, actionId, actor,
    ...(clientAtMs == null ? {} : {clientAtMs}), data};
}

function actionError(error) {
  if (error instanceof HttpError) return error;
  if (Number.isInteger(error?.status) && typeof error?.code === 'string') {
    return new HttpError(error.status, error.code, error.message);
  }
  const code = error?.code;
  if (code === 'run_not_found' || code === 'export_not_found') return new HttpError(404, code, error.message);
  if (code === 'run_not_terminal' || code === 'run_terminal' || code === 'action_conflict' ||
      code === 'config_immutable' || code === 'ticket_manifest_frozen' || code === 'tickets_exhausted' ||
      code === 'run_exists') return new HttpError(409, code, error.message);
  if (typeof code === 'string') return new HttpError(400, code, error.message);
  return error;
}

function actionInput(body, experiment) {
  rejectForeignIdentity(body, experiment);
  identifier(body.actionId, 'Action');
  if (typeof body.kind !== 'string' || !body.kind) {
    throw new HttpError(400, 'invalid_action', 'Choose an action.');
  }
  if (body.clientAtMs != null && !Number.isFinite(body.clientAtMs)) {
    throw new HttpError(400, 'invalid_client_time', 'Client time must be a finite UTC millisecond value.');
  }
  if (body.deviceId != null) identifier(body.deviceId, 'Device');
  if (body.data != null && (typeof body.data !== 'object' || Array.isArray(body.data))) {
    throw new HttpError(400, 'invalid_action_data', 'Action data must be an object.');
  }
  return {actionId: body.actionId, kind: body.kind,
    clientAtMs: body.clientAtMs ?? null, deviceId: body.deviceId ?? null,
    data: body.data ?? {}};
}

export function createService({experiment = EXPERIMENT, store, storage, randomService, authenticate, clock = Date.now,
  assets = null, logger = console, publish = async () => {}, scheduleAlarm = async () => {},
  connectEvents = null, codeCheckpoint = null, scoredCollectionEnabled = false, startRegistry = null,
  getPublications = async () => ({latestPublicationId: null, runs: []}), scheduleRegistrySync = null} = {}) {
  if (!authenticate) throw new Error('An authenticated operator boundary is required.');
  if (codeCheckpoint != null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(codeCheckpoint)) {
    throw new Error('The injected source checkpoint must be a Git SHA-1 or source SHA-256.');
  }
  const sourceCheckpoint = codeCheckpoint ?? 'development';
  if (store instanceof SessionStore) store = store.withSourceCheckpoint(sourceCheckpoint);
  const runQueues = new Map();
  const serialize = (runId, operation) => {
    const previous = runQueues.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    runQueues.set(runId, result.catch(error => logger.warn('Serialized Tree operation failed; later operations can retry their own identifiers.', {runId, code: error.code ?? 'operation_failed'})));
    return result;
  };

  async function refreshAlarm(record) {
    const deadline = nextDeadline(record.state);
    const delivery = record.state.pendingDelivery;
    const deliveryDeadline = delivery?.deliveryStatus === 'pending' && delivery.stream !== 'testAudio' ?
      {kind: 'cueTimeout', atMs: delivery.issuedAtMs + 10000} : null;
    const earliest = !deadline ? deliveryDeadline : !deliveryDeadline ? deadline :
      deadline.atMs <= deliveryDeadline.atMs ? deadline : deliveryDeadline;
    await scheduleAlarm(record.runId, earliest);
  }

  async function verifyPendingTickets(runId) {
    let record = await store.readRun(runId);
    if (!['completed', 'stopped', 'failed'].includes(record.state.lifecycle)) {
      throw new HttpError(409, 'run_not_terminal', 'Signature verification follows the completed run.');
    }
    for (const ticket of record.tickets.filter(item => item.status === 'issued' &&
        item.verification?.status === 'pending')) {
      let verification;
      try {
        if (typeof randomService.verifySignature !== 'function') {
          throw new HttpError(503, 'verification_unavailable', 'No signature verifier is configured.');
        }
        verification = await randomService.verifySignature(ticket.result, ticket.ticketId, ticket.binding);
      } catch (error) {
        logger.warn('Tree study signature verification is pending; saved signed result is retained.',
          {runId, ticketId: ticket.ticketId, code: error?.code ?? 'verification_unavailable'});
        verification = {status: 'pending', error: {code: error?.code ?? 'verification_unavailable',
          message: 'Signature verification could not be completed.'}};
      }
      await store.recordVerification(runId, ticket.ticketId, verification, clock());
    }
    record = await store.readRun(runId);
    return {experimentSlug: experiment.slug, runId,
      verification: record.tickets.filter(ticket => ticket.status === 'issued').map(ticket => ({
        ticketId: ticket.ticketId, status: ticket.verification.status,
      }))};
  }

  function assignmentBinding(record, state, stream) {
    return {experimentSlug: experiment.slug, runId: record.runId, stream,
      opportunityId: opportunityFor(state, stream), configHash: record.configHash};
  }

  function addCue(state, effect, runId, nowMs, forcedCueId = null) {
    const cue = {experimentSlug: experiment.slug, runId,
      cueId: forcedCueId ?? effect.cueId ?? crypto.randomUUID(),
      trialId: effect.stream === 'tree' ? `trial-${state.currentTrial?.index}` :
        effect.stream === 'local' ? `comparison-${state.currentComparison?.index}` : null,
      stream: effect.stream, text: effect.text,
      dueAtMs: effect.dueAtMs ?? nowMs, issuedAtMs: nowMs, playedAtMs: null,
      deliveryStatus: 'pending', deviceId: state.playbackDeviceId};
    state.cues ??= [];
    state.cues.push(cue);
    state.pendingDelivery = cue;
    return cue;
  }

  function safeActionPayload(action) {
    const {playbackToken, ...data} = action.data;
    return {...action, data};
  }

  function cueClockDetails(data, timestampField) {
    return {
      ...(data.clockExchangeId ? {clockExchangeId: data.clockExchangeId} : {}),
      ...(data.clockUncertaintyMs != null ? {clockUncertaintyMs: data.clockUncertaintyMs} : {}),
      ...(data.clockSegment != null ? {clockSegment: data.clockSegment} : {}),
      timeSource: data[timestampField] == null ? 'server_receipt' :
        data.clockExchangeId ? 'phone_offset' : 'submitted_unqualified',
    };
  }

  async function playbackAuthorized(record, action, actor) {
    if (!action.deviceId || action.deviceId !== record.state.playbackDeviceId ||
        actor.id !== record.state.playbackActorId ||
        action.data.deviceId != null && action.data.deviceId !== action.deviceId) {
      throw new HttpError(403, 'not_playback_device', 'Only the designated instruction phone can confirm audio.');
    }
    const savedToken = await storage.get(metadataKey(experiment, 'playback', record.runId));
    if (!savedToken || action.data.playbackToken !== savedToken) {
      throw new HttpError(403, 'not_playback_device', 'Instruction phone authorization is missing.');
    }
  }

  async function retainCollectionStart(record) {
    if (!record.config.seriesId || record.state.collectionStartedAtMs == null) return;
    await storage.transaction(async transaction => {
      const key = metadataKey(experiment, 'series', record.config.seriesId);
      const series = await transaction.get(key);
      const member = series?.members.find(item => item.runId === record.runId);
      if (!member) throw new HttpError(409, 'series_member_missing', 'The run is absent from its retained series.');
      if (member.collectionStartedAtMs == null) {
        member.collectionStartedAtMs = record.state.collectionStartedAtMs;
        member.configHash = record.configHash;
        member.profileHash = record.profileHash;
        member.codeCheckpoint = record.codeCheckpoint;
      }
      await transaction.put(key, series);
    });
  }

  async function beginScoredRegistration(runId, submitted) {
    const action = actionInput(submitted, experiment);
    const record = await store.readRun(runId);
    if (record.events.some(event => event.kind === 'start')) return null;
    const canceled = ['stopped', 'failed', 'completed'].includes(record.state.lifecycle);
    if (!canceled && !scoredCollectionEnabled) throw new HttpError(409, 'scored_locked', 'This Test release is preparation only.');
    if (!canceled && record.codeCheckpoint !== sourceCheckpoint) throw new HttpError(409, 'scored_source_unavailable', 'Scored Start requires the selected active source checkpoint.');
    if (!canceled && (record.state.lifecycle !== 'prepared' || !record.state.recordingReady || !record.state.testAudioPlayed || !record.state.playbackDeviceId || !record.state.setupSnapshot || record.state.setupSnapshot.retrospective)) {
      throw new HttpError(409, 'start_not_ready', 'Prepare the run, save prospective setup, test instruction audio and confirm recording before Start.');
    }
    if (canceled && !record.startRegistration) throw new HttpError(409, 'run_terminal', 'This run has ended.');
    if (!startRegistry) throw new HttpError(409, 'registry_unconfigured', 'Scored start registration is not configured.');
    if (await hashJson(record.config) !== record.configHash) throw new HttpError(409, 'start_identity_conflict', 'The run configuration differs from its sealed identity.');
    if (!canceled) await store.reserveAction(runId, action.actionId, safeActionPayload(action));
    if (!record.startRegistration || record.startRegistration.status === 'failed') {
      await store.recordStartRegistration(runId, {status: 'pending', registration: null}, clock());
      await publish(await store.readRun(runId));
    }
    return {study: experiment.slug, seriesId: record.config.seriesId, runId, configHash: `0x${record.configHash}`, sourceCheckpoint: record.codeCheckpoint};
  }

  async function processAction(runId, submitted, actor, {internal = false, externalRegistration = null} = {}) {
    let nowMs = clock();
    let record = await store.readRun(runId);
    const action = internal ? submitted : actionInput(submitted, experiment);
    const payload = safeActionPayload(action);
    const prior = record.actions.find(existing => existing.actionId === action.actionId);
    if (prior) {
      const ownerEvent = record.events.find(event => event.actionId === action.actionId && event.actor !== 'server');
      if (ownerEvent && ownerEvent.actor !== actor.id) {
        throw new HttpError(403, 'action_owner_mismatch', 'Another operator owns that saved action.');
      }
      const replay = await store.reserveAction(runId, action.actionId, payload);
      if (replay.receipt) {
        await retainCollectionStart(record);
        const token = action.kind === 'designatePlayback' ?
          await storage.get(metadataKey(experiment, 'playback', runId)) : null;
        return {...replay.receipt, ...(token ? {playbackToken: token} : {}),
          state: publicRecord(await store.readRun(runId), nowMs)};
      }
      if (action.kind !== 'start' || record.config.purpose !== 'scored') return {actionId: action.actionId, accepted: false, pending: true,
        state: publicRecord(record, nowMs)};
    }

    if (action.kind === 'start' && record.config.purpose === 'scored') {
      if (record.events.some(event => event.kind === 'start')) return {actionId: action.actionId, accepted: true, alreadyStarted: true, state: publicRecord(record, nowMs)};
      const canceled = ['stopped', 'failed', 'completed'].includes(record.state.lifecycle);
      if (!canceled && !scoredCollectionEnabled) throw new HttpError(409, 'scored_locked', 'This Test release is preparation only.');
      if (!canceled && record.codeCheckpoint !== sourceCheckpoint) throw new HttpError(409, 'scored_source_unavailable', 'Scored Start requires the selected active source checkpoint.');
      if (!canceled && (record.state.lifecycle !== 'prepared' || !record.state.recordingReady || !record.state.testAudioPlayed || !record.state.playbackDeviceId || !record.state.setupSnapshot || record.state.setupSnapshot.retrospective)) {
        throw new HttpError(409, 'start_not_ready', 'Prepare the run, save prospective setup, test instruction audio and confirm recording before Start.');
      }
      if (canceled && !record.startRegistration) throw new HttpError(409, 'run_terminal', 'This run has ended.');
      if (!startRegistry) throw new HttpError(409, 'registry_unconfigured', 'Scored start registration is not configured.');
      if (await hashJson(record.config) !== record.configHash) throw new HttpError(409, 'start_identity_conflict', 'The run configuration differs from its sealed identity.');
      if (!canceled) await store.reserveAction(runId, action.actionId, payload);
      const identity = {study: experiment.slug, seriesId: record.config.seriesId, runId, configHash: `0x${record.configHash}`, sourceCheckpoint: record.codeCheckpoint};
      const registration = externalRegistration ?? await startRegistry.ensureStart(identity);
      if (registration.status === 'confirmed' && canonicalJson(registration.registration?.identity) !== canonicalJson(identity)) throw new HttpError(409, 'start_identity_conflict', 'The chain receipt differs from this fixed run.');
      record = await store.recordStartRegistration(runId, registration, clock());
      if (registration.status !== 'confirmed' || canceled || !record.state.recordingReady || ['stopped', 'failed', 'completed'].includes(record.state.lifecycle)) {
        await publish(record);
        return {actionId: action.actionId, accepted: false, pending: registration.status === 'pending', registration,
          ...(registration.error ? {error: registration.error} : {}), state: publicRecord(record, clock())};
      }
      nowMs = clock();
    }

    if (record.state.lifecycle === 'completed' || record.state.lifecycle === 'stopped' ||
        record.state.lifecycle === 'failed') {
      if (!['saveClockReference', 'attachSetup', 'cuePlayed', 'cueEnded', 'cueFailed'].includes(action.kind)) {
        throw new HttpError(409, 'run_terminal', 'This run has ended.');
      }
    }
    let state = structuredClone(record.state);
    const events = [];
    const effects = [];
    let providerResult = null;
    let binding = null;
    let specialReceipt = {};
    const data = action.data;

    if (action.kind === 'configure') {
      if (state.lifecycle !== 'draft') throw new HttpError(409, 'config_immutable', 'Settings can change only in draft.');
      if (!data.config && !data.passiveReading) throw new HttpError(400, 'invalid_config', 'Send settings or a reading reference.');
      if (data.config) {
        try { state.config = validateConfig(data.config); }
        catch (error) { throw new HttpError(400, 'invalid_config', error.message); }
      }
      if (data.passiveReading) {
        const reading = data.passiveReading;
        const url = reading.url === undefined ? '' : reading.url;
        if (typeof reading.title !== 'string' || !reading.title.trim() ||
            typeof url !== 'string' || url !== '' && (!/^https?:\/\/[^\s]+$/.test(url) || !URL.canParse(url))) {
          throw new HttpError(400, 'invalid_reading', 'Reading reference needs a title; an optional link must be a valid HTTP or HTTPS URL.');
        }
        state.passiveReading = {title: reading.title.trim(), url};
      }
      events.push(recordedEvent('configure', nowMs, action.actionId, actor.id,
        {config: state.config, passiveReading: state.passiveReading ?? null}, action.clientAtMs));
    } else if (action.kind === 'attachSetup') {
      const setupId = identifier(data.setupId, 'Setup');
      const setup = await storage.get(metadataKey(experiment, 'setup', setupId));
      if (!setup) throw new HttpError(404, 'setup_not_found', 'Setup was not found.');
      const retrospective = ['completed', 'stopped', 'failed'].includes(state.lifecycle);
      if (state.lifecycle !== 'draft' && (!retrospective || record.config.mode !== 'tree' ||
          record.config.purpose !== 'preparation' || !setup.retrospective)) {
        throw new HttpError(409, 'setup_immutable', 'Only draft runs or completed preparation tree runs can attach these regions.');
      }
      state.setupSnapshot = setup;
      if (!retrospective) state.config = validateConfig({...record.config, setupId});
      events.push(recordedEvent('attachSetup', nowMs, action.actionId, actor.id,
        {setupId, imageSha256: setup.imageSha256}, action.clientAtMs));
    } else if (action.kind === 'prepare') {
      if (state.lifecycle !== 'draft') throw new HttpError(409, 'already_prepared', 'Run has already been prepared.');
      const config = record.config;
      if (config.purpose === 'scored') {
        if (!scoredCollectionEnabled) throw new HttpError(409, 'scored_locked', 'This Test release is preparation only.');
        const series = await storage.get(metadataKey(experiment, 'series', config.seriesId));
        if (record.codeCheckpoint !== sourceCheckpoint || series?.status !== 'frozen' || canonicalJson(series.config) !== canonicalJson(config)) throw new HttpError(409, 'series_manifest_mismatch', 'Scored settings differ from the frozen manifest.');
      }
      if (config.siteId) {
        const site = await storage.get(metadataKey(experiment, 'site', config.siteId));
        if (!site) throw new HttpError(400, 'site_not_found', 'Saved site was not found.');
        state.siteSnapshot = structuredClone(site.revisions.at(-1));
        state.siteSnapshot.siteId = site.siteId;
        state.siteSnapshot.label = site.label;
      }
      if (config.mode === 'tree' && config.purpose === 'scored' &&
          (!state.setupSnapshot || state.setupSnapshot.retrospective)) {
        throw new HttpError(409, 'prospective_setup_required', 'Save the final A, B and background setup before a scored tree run.');
      }
      const planned = ticketPlan(config);
      await store.reserveAction(runId, action.actionId, payload);
      let attached;
      try {
        const created = await randomService.createTickets(planned.length);
        if (!Array.isArray(created) || created.length !== planned.length) {
          throw new HttpError(502, 'ticket_count_mismatch', 'The ticket provider returned an incomplete manifest.');
        }
        attached = planned.map((plan, index) => ({...created[index], ...plan}));
        await store.attachTickets(runId, attached);
      } catch (error) {
        if (Array.isArray(error?.createdTickets) && error.createdTickets.length) {
          const partial = error.createdTickets.slice(0, planned.length).map((ticket, index) =>
            ({...ticket, ...planned[index]}));
          await store.attachTickets(runId, partial);
        }
        state.lifecycle = 'failed';
        state.phase = 'FAILED';
        const failure = {code: error?.code ?? 'ticket_creation_failed',
          message: 'Ticket creation is unresolved; this attempt cannot be retried or rerolled.'};
        state.lastError = failure;
        await store.completeAction(runId, action.actionId, {state, failure, serverAtMs: clock(),
          events: [recordedEvent('prepareAttempt', nowMs, action.actionId, actor.id,
            {createdTicketCount: error?.createdTickets?.length ?? 0})],
          receipt: {actionId: action.actionId, accepted: false}});
        throw new HttpError(502, 'ticket_creation_failed', failure.message);
      }
      state.lifecycle = 'prepared';
      state.phase = 'TREE_READY';
      events.push(recordedEvent('prepare', nowMs, action.actionId, actor.id,
        {ticketCount: attached.length, siteRevision: state.siteSnapshot?.revision ?? null,
          setupId: state.setupSnapshot?.setupId ?? null}, action.clientAtMs));
    } else if (action.kind === 'designatePlayback') {
      if (!['draft', 'prepared'].includes(state.lifecycle)) {
        throw new HttpError(409, 'playback_locked', 'Choose the instruction phone before Start.');
      }
      const deviceId = identifier(data.deviceId ?? action.deviceId, 'Playback device');
      if (state.playbackDeviceId && state.playbackDeviceId !== deviceId) {
        throw new HttpError(409, 'playback_locked', 'The existing instruction phone must be retained for this run.');
      }
      if (state.playbackActorId && state.playbackActorId !== actor.id) {
        throw new HttpError(403, 'not_playback_device', 'Another signed-in operator designated the instruction phone.');
      }
      const tokenKey = metadataKey(experiment, 'playback', runId);
      const token = await storage.get(tokenKey) ?? crypto.randomUUID();
      await storage.put(tokenKey, token);
      state.playbackDeviceId = deviceId;
      state.playbackActorId = actor.id;
      state.testAudioPlayed = false;
      const testCue = addCue(state, {stream: 'testAudio', text: 'Test audio'}, runId, nowMs);
      state.pendingTestCueId = testCue.cueId;
      specialReceipt = {playbackToken: token};
      events.push(recordedEvent('designatePlayback', nowMs, action.actionId, actor.id,
        {deviceId, testCueId: testCue.cueId}, action.clientAtMs));
    } else if (action.kind === 'testAudioPlayed') {
      await playbackAuthorized(record, action, actor);
      if (data.playedAtMs != null && !Number.isFinite(data.playedAtMs) ||
          data.clockExchangeId != null && (typeof data.clockExchangeId !== 'string' || !data.clockExchangeId) ||
          data.clockUncertaintyMs != null && (!Number.isFinite(data.clockUncertaintyMs) || data.clockUncertaintyMs < 0) ||
          data.clockSegment != null && (!Number.isSafeInteger(data.clockSegment) || data.clockSegment < 0)) {
        throw new HttpError(400, 'invalid_playback_time', 'Playback time must be a finite UTC millisecond value.');
      }
      if (!state.pendingTestCueId || data.cueId && data.cueId !== state.pendingTestCueId) {
        throw new HttpError(409, 'test_audio_missing', 'No matching test utterance is pending.');
      }
      const cue = state.cues.find(entry => entry.cueId === state.pendingTestCueId);
      cue.deliveryStatus = 'played';
      cue.playedAtMs = data.playedAtMs ?? nowMs;
      state.pendingDelivery = null;
      state.pendingTestCueId = null;
      state.testAudioPlayed = true;
      events.push(recordedEvent('testAudioPlayed', nowMs, action.actionId, actor.id,
        {cueId: cue.cueId, deviceId: action.deviceId, playedAtMs: cue.playedAtMs,
          ...cueClockDetails(data, 'playedAtMs')}, action.clientAtMs));
    } else if (action.kind === 'recordingReady') {
      if (state.lifecycle !== 'prepared') throw new HttpError(409, 'not_prepared', 'Prepare the run first.');
      state.recordingReady = true;
      events.push(recordedEvent('recordingReady', nowMs, action.actionId, actor.id,
        {deviceId: action.deviceId}, action.clientAtMs));
    } else if (action.kind === 'saveClockReference') {
      events.push(recordedEvent('saveClockReference', nowMs, action.actionId, actor.id,
        data, action.clientAtMs));
    } else if (action.kind === 'cuePlayed' || action.kind === 'cueEnded' || action.kind === 'cueFailed') {
      await playbackAuthorized(record, action, actor);
      if (data.playedAtMs != null && !Number.isFinite(data.playedAtMs) ||
          data.endedAtMs != null && !Number.isFinite(data.endedAtMs) ||
          data.clockExchangeId != null && (typeof data.clockExchangeId !== 'string' || !data.clockExchangeId) ||
          data.clockUncertaintyMs != null && (!Number.isFinite(data.clockUncertaintyMs) || data.clockUncertaintyMs < 0) ||
          data.clockSegment != null && (!Number.isSafeInteger(data.clockSegment) || data.clockSegment < 0)) {
        throw new HttpError(400, 'invalid_playback_time', 'Playback and clock-reference details are invalid.');
      }
      const cue = state.cues?.find(entry => entry.cueId === data.cueId);
      if (!cue || cue.stream === 'testAudio' && action.kind === 'cuePlayed') {
        throw new HttpError(409, 'cue_mismatch', 'No matching cue exists.');
      }
      if (action.kind === 'cuePlayed') {
        if (state.pendingDelivery?.cueId !== cue.cueId || cue.deliveryStatus !== 'pending') {
          throw new HttpError(409, 'cue_mismatch', 'This cue is not awaiting playback.');
        }
        if (nowMs > cue.issuedAtMs + 10000) throw new HttpError(409, 'cue_late', 'Cue delivery exceeded the configured limit.');
        cue.playedAtMs = Number.isFinite(data.playedAtMs) ? data.playedAtMs : nowMs;
        cue.deliveryStatus = 'played';
        state.pendingDelivery = null;
        const applied = applyEvent(state, engineEvent('cuePlayed', nowMs,
          {stream: cue.stream, text: cue.text, cueId: cue.cueId, playedAtMs: cue.playedAtMs}), record.config);
        state = applied.state;
        effects.push(...applied.effects);
      } else if (action.kind === 'cueEnded') {
        if (cue.deliveryStatus !== 'played' || cue.endedAtMs != null) {
          throw new HttpError(409, 'cue_mismatch', 'Cue has not started or has already ended.');
        }
        cue.endedAtMs = data.endedAtMs ?? nowMs;
        if (['localComplete', 'treeRelease'].includes(cue.stream)) {
          const applied = applyEvent(state, engineEvent('cueEnded', nowMs, {stream: cue.stream}), record.config);
          state = applied.state;
          effects.push(...applied.effects);
        }
      } else {
        if (!['pending', 'played'].includes(cue.deliveryStatus) || cue.endedAtMs != null) {
          throw new HttpError(409, 'cue_mismatch', 'Cue cannot be marked failed twice.');
        }
        cue.deliveryStatus = 'failed';
        if (state.pendingDelivery?.cueId === cue.cueId) state.pendingDelivery = null;
        if (cue.stream === 'testAudio') {
          state.pendingTestCueId = null;
          state.testAudioPlayed = false;
        } else {
          state.phase = 'FAILED';
          state.lifecycle = 'failed';
          state.lastError = {code: 'cue_failed', message: 'Instruction audio failed.'};
          state.deadline = null;
          state.localDeadline = null;
        }
      }
      events.push(recordedEvent(action.kind, nowMs, action.actionId, actor.id,
        {cueId: cue.cueId, stream: cue.stream, deviceId: action.deviceId,
          ...(action.kind === 'cuePlayed' ? {playedAtMs: cue.playedAtMs} : {}),
          ...(action.kind === 'cueEnded' ? {endedAtMs: cue.endedAtMs} : {}),
          ...cueClockDetails(data, action.kind === 'cueEnded' ? 'endedAtMs' : 'playedAtMs'),
          ...(action.kind === 'cueFailed' ? {reason: data.reason ?? 'speech_error'} : {})}, action.clientAtMs));
    } else if (['start', 'ready', 'stop', 'arrived', 'away', 'approachStarted', 'departureStarted', 'deadlineReached'].includes(action.kind)) {
      if (action.kind === 'start') {
        if (record.config.purpose === 'scored' && !scoredCollectionEnabled) throw new HttpError(409, 'scored_locked', 'This Test release is preparation only.');
        if (state.lifecycle !== 'prepared' || !state.recordingReady || !state.testAudioPlayed || !state.playbackDeviceId) {
          throw new HttpError(409, 'start_not_ready', 'Prepare the run, test instruction audio and confirm recording before Start.');
        }
        if (record.config.mode === 'tree' && record.config.purpose === 'scored' &&
            (!state.setupSnapshot || state.setupSnapshot.retrospective)) {
          throw new HttpError(409, 'prospective_setup_required', 'Scored tree setup must be saved before Start.');
        }
      }
      if (action.kind === 'ready') {
        const eligibility = localEligibility(state, record.config, nowMs);
        if (!eligibility.allowed) {
          const messages = {
            active_cutoff: 'There is no time for another complete comparison before departure.',
            baseline_incomplete: 'The preceding baseline is not complete.',
            comparison_open: 'The current comparison is still in progress.',
            count_complete: 'All planned comparisons are complete.',
            not_active: 'Ready is available only during active practice.',
          };
          throw new HttpError(409, eligibility.reason, messages[eligibility.reason] ?? 'Ready is not available in this run state.');
        }
      }
      const occurredAtMs = ['arrived', 'away', 'approachStarted', 'departureStarted'].includes(action.kind) ?
        (Number.isFinite(data.occurredAtMs) ? data.occurredAtMs : nowMs) : undefined;
      const applied = applyEvent(state, engineEvent(action.kind, nowMs,
        occurredAtMs == null ? {} : {occurredAtMs}), record.config);
      state = applied.state;
      effects.push(...applied.effects);
      events.push(recordedEvent(action.kind, nowMs, action.actionId, actor.id,
        occurredAtMs == null ? {} : {occurredAtMs}, action.clientAtMs));
    } else {
      throw new HttpError(400, 'unknown_action', 'That action is not part of this study.');
    }

    const request = effects.find(effect => effect.kind === 'requestAssignment');
    if (request) binding = assignmentBinding(record, state, request.stream);
    const reservation = await store.reserveAction(runId, action.actionId, payload,
      binding ? {binding} : {});
    if (!reservation.shouldDraw && binding) {
      return {actionId: action.actionId, accepted: false, pending: true,
        state: publicRecord(await store.readRun(runId), nowMs)};
    }
    if (binding) {
      try {
        const draw = await randomService.draw(reservation.ticketId, reservation.binding);
        providerResult = draw.result;
        const ticket = (await store.readRun(runId)).tickets.find(item => item.ticketId === reservation.ticketId);
        const value = ticket.rules[String(draw.value)];
        if (value === undefined) throw new HttpError(502, 'assignment_rule_missing', 'The saved ticket has no mapping for its result.');
        const cueId = ['local', 'tree'].includes(request.stream) ? crypto.randomUUID() : null;
        const assignment = applyEvent(state, engineEvent('assignmentReceived', nowMs,
          {stream: request.stream, value, cueId}), record.config);
        state = assignment.state;
        state.collectionStartedAtMs ??= nowMs;
        effects.push(...assignment.effects);
        events.push(recordedEvent('assignmentReceived', nowMs, action.actionId, 'server',
          {stream: request.stream, value, ticketId: reservation.ticketId,
            opportunityId: reservation.binding.opportunityId}));
      } catch (error) {
        const failure = {code: error?.code ?? 'provider_unavailable',
          message: 'Random assignment could not be resolved for its reserved ticket.'};
        state.phase = 'FAILED';
        state.lifecycle = 'failed';
        state.lastError = failure;
        await store.completeAction(runId, action.actionId,
          {state, events, failure, serverAtMs: clock(), receipt: {actionId: action.actionId, accepted: false}});
        await refreshAlarm(await store.readRun(runId));
        return {actionId: action.actionId, accepted: false, error: failure,
          state: publicRecord(await store.readRun(runId), clock())};
      }
    }
    for (const effect of effects.filter(item => item.kind === 'deliverCue')) {
      const cue = addCue(state, effect, runId, clock(), effect.cueId);
      events.push(recordedEvent('cueIssued', cue.issuedAtMs, action.actionId, 'server',
        {cueId: cue.cueId, stream: cue.stream, dueAtMs: cue.dueAtMs,
          issuedAtMs: cue.issuedAtMs, deviceId: cue.deviceId}));
    }
    const receipt = {actionId: action.actionId, accepted: true};
    await store.completeAction(runId, action.actionId,
      {state, events, providerResult, serverAtMs: clock(), receipt});
    record = await store.readRun(runId);
    await retainCollectionStart(record);
    if (['completed', 'stopped', 'failed'].includes(record.state.lifecycle)) {
      await verifyPendingTickets(runId);
      record = await store.readRun(runId);
    }
    await refreshAlarm(record);
    try { await publish(record); }
    catch (error) { logger.warn('Tree study event delivery failed; saved state remains authoritative.',
      {runId, message: error instanceof Error ? error.message : String(error)}); }
    return {...receipt, ...specialReceipt, state: publicRecord(record, clock())};
  }

  async function advanceDeadline(runId) {
    try {
      return await serialize(runId, async () => {
        const record = await store.readRun(runId);
        const deadline = nextDeadline(record.state);
        const pending = record.state.pendingDelivery;
        const timeout = pending?.deliveryStatus === 'pending' && pending.stream !== 'testAudio' ?
          pending.issuedAtMs + 10000 : null;
        if (timeout != null && clock() >= timeout && (!deadline || timeout <= deadline.atMs)) {
          const actionId = `cue-timeout-${pending.cueId}`;
          if (record.actions.some(action => action.actionId === actionId)) return json({advanced: false});
          const state = structuredClone(record.state);
          state.cues.find(cue => cue.cueId === pending.cueId).deliveryStatus = 'failed';
          state.pendingDelivery = null;
          state.phase = 'FAILED';
          state.lifecycle = 'failed';
          state.lastError = {code: 'cue_timeout', message: 'Instruction audio did not start within ten seconds.'};
          state.deadline = null;
          state.localDeadline = null;
          await store.reserveAction(runId, actionId, {kind: 'cueTimeout'});
          await store.completeAction(runId, actionId, {state, serverAtMs: clock(),
            events: [recordedEvent('failed', clock(), actionId, 'server', {reason: 'cue_timeout'})],
            receipt: {actionId, accepted: true}});
          await verifyPendingTickets(runId);
          const verified = await store.readRun(runId);
          await refreshAlarm(verified);
          await publish(verified);
          return json({advanced: true, state: publicRecord(verified, clock())});
        }
        if (!deadline || deadline.atMs > clock()) return json({advanced: false});
        const actionId = `deadline-${deadline.kind}-${deadline.atMs}`;
        const result = await processAction(runId, {actionId, kind: 'deadlineReached',
          clientAtMs: null, deviceId: null, data: {}}, {id: 'server'}, {internal: true});
        return json({advanced: true, ...result});
      });
    } catch (error) {
      const converted = actionError(error);
      if (converted instanceof HttpError) return json({code: converted.code, message: converted.message}, converted.status);
      logger.warn('Tree study deadline failed.', {runId, message: converted?.message ?? String(converted)});
      return json({code: 'internal_error', message: 'Deadline could not be completed.'}, 500);
    }
  }

  async function freezeSeries(seriesId) {
    return serialize(`series-${seriesId}`, async () => {
      const key = metadataKey(experiment, 'series', seriesId);
      const series = await storage.get(key);
      if (!series) throw new HttpError(404, 'series_not_found', 'Series was not found.');
      if (series.config.purpose !== 'scored' || series.status !== 'draft') throw new HttpError(409, 'series_not_draft', 'Only a scored draft manifest can be frozen.');
      if (series.codeCheckpoint !== sourceCheckpoint || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCheckpoint)) throw new HttpError(409, 'code_checkpoint_unqualified', 'Freeze requires the current immutable source checkpoint.');
      if (!qualified(series)) throw new HttpError(409, 'qualification_incomplete', 'Software, footage, phone and clock checks must pass for this exact profile and source.');
      series.status = 'frozen';
      series.frozenAtMs = clock();
      await storage.put(key, series);
      return publicSeries(series);
    });
  }
  return {
    advanceDeadline,
    async fetch(request) {
      const url = new URL(request.url);
      const route = routeFor(url.pathname, experiment);
      if (!route) return json({code: 'not_found', message: 'The experiment route was not found.'}, 404);
      try {
        const actor = await authenticate(request);
        if (!actor?.id) throw new HttpError(403, 'access_invalid', 'Access sign-in is invalid.');
        if (route.kind === 'selector') return selector(experiment);
        if (route.kind === 'redirect') return Response.redirect(`${url.origin}${route.destination}${url.search}${url.hash}`, 308);
        if (route.kind === 'macInstructions') return Response.redirect(`${url.origin}${HOSTED_APP_BASE}${url.search}#recordings`, 303);
        if (route.kind === 'asset') {
          if (!assets) throw new HttpError(404, 'asset_not_found', 'The requested asset was not found.');
          const mapped = routeForAsset(url, route);
          return assets.fetch(new Request(mapped, request));
        }
        const method = request.method;
        const path = route.path;
        if (route.kind === 'publicApi' && path === 'status' && ['GET', 'HEAD'].includes(method)) {
          if (!startRegistry) return json({registry: {enabled: false, state: 'unconfigured'}, synchronization: {state: 'unconfigured', caughtUp: false}, registrations: [], latestPublicationId: null});
          if (scheduleRegistrySync) scheduleRegistrySync();
          else await startRegistry.synchronize();
          return json(await startRegistry.status({runs: await store.listRuns(), publications: await getPublications()}));
        }
        if (path === 'start-registry' && method === 'GET') return json(startRegistry?.readiness() ?? {enabled: false, configured: false, signingAvailable: false});
        if (path === 'clock' && method === 'GET') {
          const received = clock();
          return json({serverReceivedAtMs: received, serverSentAtMs: clock(), exchangeId: crypto.randomUUID()});
        }
        if (path === 'series' && method === 'POST') {
          if (!storage) throw new HttpError(503, 'storage_unavailable', 'Series storage is unavailable.');
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          let config;
          try { config = validateConfig(body.config); } catch (error) { throw new HttpError(400, 'invalid_config', error.message); }
          if (body.codeCheckpoint != null && body.codeCheckpoint !== sourceCheckpoint) throw new HttpError(409, 'code_checkpoint_changed', 'The source comes from the hosted build.');
          const profile = selectedProfile(config, body.profile);
          const seriesId = crypto.randomUUID();
          config.seriesId = seriesId;
          const saved = {seriesId, experimentSlug: experiment.slug,
            label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Tree sequence',
            status: config.purpose === 'preparation' ? 'open' : 'draft', config,
            sealedConfigJson: JSON.stringify(config), configHash: await hashJson(config),
            profile, sealedProfileJson: JSON.stringify(profile), profileHash: await hashJson(profile),
            codeCheckpoint: sourceCheckpoint, qualification: structuredClone(body.qualification ?? null),
            runIds: [], members: [], createdAtMs: clock(), actor: actor.id};
          await metadataCreate(storage, experiment, 'series', seriesId, saved);
          return json(publicSeries(saved), 201);
        }
        if (path === 'series' && method === 'GET') {
          const series = await metadataList(storage, experiment, 'series');
          return json({series: series.map(publicSeries)});
        }
        const seriesExport = /^series\/([A-Za-z0-9_-]{1,80})\/export$/.exec(path);
        if (seriesExport && method === 'GET') {
          const record = await storage.get(metadataKey(experiment, 'series', seriesExport[1]));
          if (!record) throw new HttpError(404, 'series_not_found', 'Series was not found.');
          return new Response(JSON.stringify(publicSeries(record)), {headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="tree-targeting-series-${record.seriesId}.json"`,
          }});
        }
        const series = /^series\/([A-Za-z0-9_-]{1,80})$/.exec(path);
        if (series && method === 'GET') {
          const record = await storage.get(metadataKey(experiment, 'series', series[1]));
          if (!record) throw new HttpError(404, 'series_not_found', 'Series was not found.');
          return json(publicSeries(record));
        }
        const seriesFreeze = /^series\/([A-Za-z0-9_-]{1,80})\/freeze$/.exec(path);
        if (seriesFreeze && method === 'POST') {
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          return json(await freezeSeries(seriesFreeze[1]));
        }
        if (path === 'runs' && method === 'POST') {
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          let config;
          let seriesRecord = null;
          if (body.seriesId) {
            const seriesId = identifier(body.seriesId, 'Series');
            seriesRecord = await storage.get(metadataKey(experiment, 'series', seriesId));
            if (!seriesRecord || !['open', 'frozen'].includes(seriesRecord.status)) throw new HttpError(409, 'series_unavailable', 'Choose an open preparation series or frozen scored manifest.');
          }
          try { config = validateConfig(body.config ?? seriesRecord?.config); }
          catch (error) { throw new HttpError(400, 'invalid_config', error.message); }
          if (config.purpose === 'scored' && !scoredCollectionEnabled) throw new HttpError(409, 'scored_locked', 'This Test release is unlocked preparation only.');
          if (config.purpose === 'scored' && (!seriesRecord || seriesRecord.status !== 'frozen' || canonicalJson(config) !== canonicalJson(seriesRecord.config))) throw new HttpError(409, 'series_manifest_mismatch', 'Scored settings must match the frozen manifest.');
          if (seriesRecord) {
            if (config.purpose !== seriesRecord.config.purpose) throw new HttpError(409, 'series_purpose_mismatch', 'Preparation and scored histories remain separate.');
            config.seriesId = seriesRecord.seriesId;
          } else if (config.seriesId) throw new HttpError(409, 'series_unavailable', 'Select the retained series manifest.');
          if (body.codeCheckpoint != null && body.codeCheckpoint !== sourceCheckpoint) {
            throw new HttpError(409, 'code_checkpoint_changed', 'The source checkpoint comes from the hosted build.');
          }
          const runId = body.runId ?? crypto.randomUUID();
          if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
            throw new HttpError(400, 'invalid_run_id', 'Use a valid run identifier.');
          }
          const state = createRunState(config, clock(), runId);
          state.lifecycle = 'draft';
          state.phase = 'DRAFT';
          state.cues = [];
          state.pendingDelivery = null;
          const record = await store.createRun({runId, experimentSlug: experiment.slug, config, tag: body.tag,
            profile: selectedProfile(config, seriesRecord?.profile ?? body.profile, Boolean(seriesRecord)),
            codeCheckpoint: config.purpose === 'scored' ? seriesRecord.codeCheckpoint : sourceCheckpoint, state, tickets: []});
          if (seriesRecord) {
            await storage.transaction(async transaction => {
              const key = metadataKey(experiment, 'series', seriesRecord.seriesId);
              const retained = await transaction.get(key);
              retained.runIds.push(runId);
              retained.members.push({runId, configHash: record.configHash, profileHash: record.profileHash,
                codeCheckpoint: record.codeCheckpoint, createdAtMs: record.state.createdAtMs, collectionStartedAtMs: null});
              await transaction.put(key, retained);
            });
          }
          return json(publicRecord(record, clock()), 201);
        }
        if (path === 'sites' && method === 'POST') {
          if (!storage) throw new HttpError(503, 'storage_unavailable', 'Site storage is unavailable.');
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          if (typeof body.label !== 'string' || !body.label.trim()) {
            throw new HttpError(400, 'invalid_site', 'Give the site a name.');
          }
          const siteId = crypto.randomUUID();
          const saved = {siteId, experimentSlug: experiment.slug, label: body.label.trim(), revisions: [
            {revision: 1, positions: positions(body.positions), createdAtMs: clock(), actor: actor.id},
          ]};
          await metadataCreate(storage, experiment, 'site', siteId, saved);
          return json({...saved.revisions[0], siteId, label: saved.label}, 201);
        }
        if (path === 'sites' && method === 'GET') {
          return json({sites: await metadataList(storage, experiment, 'site')});
        }
        const site = /^sites\/([A-Za-z0-9_-]{1,80})$/.exec(path);
        if (site && method === 'GET') {
          const saved = await storage.get(metadataKey(experiment, 'site', site[1]));
          if (!saved) throw new HttpError(404, 'site_not_found', 'Site was not found.');
          return json(saved);
        }
        const siteRevision = /^sites\/([A-Za-z0-9_-]{1,80})\/revisions$/.exec(path);
        if (siteRevision && method === 'POST') {
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          const submitted = positions(body.positions);
          const saved = await storage.transaction(async transaction => {
            const key = metadataKey(experiment, 'site', siteRevision[1]);
            const siteRecord = await transaction.get(key);
            if (!siteRecord) throw new HttpError(404, 'site_not_found', 'Site was not found.');
            const previous = siteRecord.revisions.at(-1);
            const next = {revision: previous.revision + 1,
              positions: {...previous.positions, ...submitted}, createdAtMs: clock(), actor: actor.id};
            siteRecord.revisions.push(next);
            await transaction.put(key, siteRecord);
            return next;
          });
          return json(saved, 201);
        }
        if (path === 'setups' && method === 'POST') {
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          const saved = setupRecord(body, actor, clock(), experiment);
          await metadataCreate(storage, experiment, 'setup', saved.setupId, saved);
          return json(saved, 201);
        }
        const setup = /^setups\/([A-Za-z0-9_-]{1,80})$/.exec(path);
        if (setup && method === 'GET') {
          const saved = await storage.get(metadataKey(experiment, 'setup', setup[1]));
          if (!saved) throw new HttpError(404, 'setup_not_found', 'Setup was not found.');
          return json(saved);
        }
        if (path === 'runs' && method === 'GET') {
          const runs = await store.listRuns();
          return json({runs: runs.map(run => publicRecord(run, clock()))});
        }
        const run = /^runs\/([A-Za-z0-9_-]{1,80})$/.exec(path);
        if (run && method === 'GET') {
          const record = await store.readRun(run[1]);
          if (!record) throw new HttpError(404, 'run_not_found', 'Run was not found.');
          return json(publicRecord(record, clock()));
        }
        const runActions = /^runs\/([A-Za-z0-9_-]{1,80})\/actions$/.exec(path);
        const runMetadata = /^runs\/([A-Za-z0-9_-]{1,80})\/(issues|stream)$/.exec(path);
        if (runMetadata && method === 'POST') {
          if (!startRegistry) throw new HttpError(409, 'registry_unconfigured', 'Start registration is not configured.');
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          await store.readRun(runMetadata[1]);
          const metadata = await serialize(runMetadata[1], async () => {
            const result = runMetadata[2] === 'issues' ? await startRegistry.reportIssue({...body, runId: runMetadata[1], actor: actor.id}) : await startRegistry.setStream({...body, runId: runMetadata[1], actor: actor.id});
            await store.appendEvent(runMetadata[1], recordedEvent(runMetadata[2] === 'issues' ? 'startIssueReported' : 'startStreamAttached', clock(), null, actor.id, result));
            if (runMetadata[2] === 'issues' && body.streamUrl) await store.appendEvent(runMetadata[1], recordedEvent('startStreamAttached', clock(), null, actor.id, {streamUrl: body.streamUrl}));
            await publish(await store.readRun(runMetadata[1]));
            return result;
          });
          return json(metadata, 201);
        }
        const runTag = /^runs\/([A-Za-z0-9_-]{1,80})\/tag$/.exec(path);
        if (runTag && method === 'POST') {
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          const record = await serialize(runTag[1], () => store.updateTag(runTag[1], body.tag,
            {actor: actor.id, serverAtMs: clock()}));
          await publish(record);
          return json(publicRecord(record, clock()));
        }
        if (runActions && method === 'POST') {
          const body = await bodyObject(request);
          let registration = null;
          if (body.kind === 'start' && (await store.readRun(runActions[1])).config.purpose === 'scored') {
            const identity = await serialize(runActions[1], () => beginScoredRegistration(runActions[1], body));
            // Keep the receipt wait outside the run queue so Stop can cancel timing while registration is in flight.
            if (identity) registration = await startRegistry.ensureStart(identity);
          }
          const receipt = await serialize(runActions[1], () => processAction(runActions[1], body, actor, {externalRegistration: registration}));
          return json(receipt);
        }
        const runTickets = /^runs\/([A-Za-z0-9_-]{1,80})\/tickets$/.exec(path);
        if (runTickets && method === 'GET') return json(await store.ticketManifest(runTickets[1]));
        const runExport = /^runs\/([A-Za-z0-9_-]{1,80})\/export$/.exec(path);
        if (runExport && method === 'GET') {
          const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
          const bundle = await store.exportRun(runExport[1], revision);
          const response = json(bundle);
          response.headers.set('Content-Disposition', `attachment; filename="tree-targeting-run-${runExport[1]}.json"`);
          return response;
        }
        const runVerify = /^runs\/([A-Za-z0-9_-]{1,80})\/verify$/.exec(path);
        if (runVerify && method === 'POST') {
          const body = await bodyObject(request);
          rejectForeignIdentity(body, experiment);
          return json(await serialize(runVerify[1], () => verifyPendingTickets(runVerify[1])));
        }
        const runEvents = /^runs\/([A-Za-z0-9_-]{1,80})\/events$/.exec(path);
        if (runEvents && method === 'GET') {
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
            throw new HttpError(426, 'upgrade_required', 'Open this event route as a WebSocket.');
          }
          if (!connectEvents) throw new HttpError(503, 'events_unavailable', 'Event connection is unavailable.');
          const record = await store.readRun(runEvents[1]);
          return connectEvents(request, actor, record, publicRecord(record, clock()));
        }
        throw new HttpError(404, 'not_found', 'The experiment route was not found.');
      } catch (originalError) {
        const error = actionError(originalError);
        if (error instanceof HttpError || Number.isInteger(error?.status) && error?.code) {
          return json({code: error.code, message: error.message}, error.status);
        }
        logger.warn('Tree study request failed.', error instanceof Error ? error.message : String(error));
        return json({code: 'internal_error', message: 'The request could not be completed.'}, 500);
      }
    },
  };
}

function routeForAsset(url, route) { return `${url.origin}/${route.asset ?? ''}`; }

export default {
  async fetch(request, env) { return hostedWorker.fetch(request, env); },
};

export class DurableStorageAdapter {
  constructor(storage) { this.storage = storage; }
  get(key) { return this.storage.get(key); }
  put(key, value) { return this.storage.put(key, value); }
  list(options) { return this.storage.list(options); }
  transaction(operation) {
    return this.storage.transaction(transaction => operation({
      get: key => transaction.get(key),
      put: (key, value) => transaction.put(key, value),
    }));
  }
}

export function createWorkerHandler({authenticate} = {}) {
  if (typeof authenticate !== 'function') throw new Error('The hosted entrypoint needs Access authentication.');
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const route = routeFor(url.pathname, EXPERIMENT);
      if (!route) return json({code: 'not_found', message: 'The experiment route was not found.'}, 404);
      const publicRead = route.public && env.RELEASE_ENVIRONMENT === 'production' && env.PUBLIC_STUDY_ENABLED === 'true';
      let actor = publicRead ? {role: 'reader'} : null;
      try { if (!publicRead) actor = await authenticate(request, env); }
      catch (originalError) {
        const error = actionError(originalError);
        if (Number.isInteger(error?.status) && typeof error?.code === 'string') {
          return json({code: error.code, message: error.message}, error.status);
        }
        return json({code: 'access_unavailable', message: 'Access sign-in could not be verified.'}, 503);
      }
      if (!publicRead && !actor?.id) return json({code: 'access_invalid', message: 'Access sign-in is invalid.'}, 403);
      const role = actor?.role ?? 'operator';
      if (route.kind === 'publicationApi' && role !== 'publisher' || route.kind !== 'publicationApi' && role === 'publisher') return json({code: 'role_forbidden', message: 'This identity cannot access that study operation.'}, 403);
      if (route.public && !['GET', 'HEAD'].includes(request.method)) return json({code: 'method_not_allowed', message: 'Published results are read-only.'}, 405);
      if (route.kind === 'selector') return selector(EXPERIMENT);
      if (route.kind === 'redirect') return Response.redirect(`${url.origin}${route.destination}${url.search}${url.hash}`, 308);
      if (route.kind === 'macInstructions') return Response.redirect(`${url.origin}${HOSTED_APP_BASE}${url.search}#recordings`, 303);
      if (route.kind === 'asset') {
        if (!env.ASSETS) return json({code: 'asset_unavailable', message: 'App assets are unavailable.'}, 503);
        return env.ASSETS.fetch(new Request(routeForAsset(url, route), request));
      }
      if (route.kind === 'api' && route.path === 'release') {
        if (request.method !== 'GET') return json({code: 'method_not_allowed', message: 'Use GET for release identity.'}, 405);
        return json({experimentSlug: EXPERIMENT.slug, environment: env.RELEASE_ENVIRONMENT ?? null,
          sourceCommit: env.SOURCE_CHECKPOINT ?? null, releaseTag: env.RELEASE_TAG ?? null,
          releaseState: env.RELEASE_STATE ?? null});
      }
      if (!env.TREE_SESSIONS) return json({code: 'storage_unavailable', message: 'Run storage is unavailable.'}, 503);
      const headers = new Headers(request.headers);
      headers.delete('X-Tree-Actor');
      headers.delete('X-Tree-Actor-Role');
      if (actor.id) headers.set('X-Tree-Actor', actor.id);
      headers.set('X-Tree-Actor-Role', role);
      headers.delete('CF-Access-Client-Id');
      headers.delete('CF-Access-Client-Secret');
      headers.delete('Cf-Access-Jwt-Assertion');
      const forwarded = new Request(request, {headers});
      return env.TREE_SESSIONS.get(env.TREE_SESSIONS.idFromName(EXPERIMENT.slug)).fetch(forwarded);
    },
  };
}

let accessAuthenticator;
let accessConfiguration;
const hostedWorker = createWorkerHandler({authenticate: (request, env) => {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUDIENCE) {
    throw new AccessConfigurationError();
  }
  const configuration = `${env.ACCESS_TEAM_DOMAIN}\n${env.ACCESS_AUDIENCE}\n${env.PUBLICATION_ACCESS_AUDIENCE ?? ''}\n${env.PUBLICATION_SERVICE_IDENTITY ?? ''}`;
  if (!accessAuthenticator || configuration !== accessConfiguration) {
    accessAuthenticator = createAccessAuthenticator({teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUDIENCE, publisherAudience: env.PUBLICATION_ACCESS_AUDIENCE,
      publisherServiceIdentity: env.PUBLICATION_SERVICE_IDENTITY});
    accessConfiguration = configuration;
  }
  return accessAuthenticator(request);
}});

class AccessConfigurationError extends Error {
  constructor() {
    super('Cloudflare Access is not configured.');
    this.status = 503;
    this.code = 'access_unavailable';
  }
}

function cueForSocket(cue) {
  return {experimentSlug: cue.experimentSlug, runId: cue.runId, cueId: cue.cueId,
    kind: cue.stream === 'testAudio' ? 'testAudio' : 'measured', stream: cue.stream,
    text: cue.text, dueAtMs: cue.dueAtMs, issuedAtMs: cue.issuedAtMs, deviceId: cue.deviceId};
}

export class TreeTargetingSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = new DurableStorageAdapter(ctx.storage);
    this.store = new SessionStore({storage: this.storage, experimentSlug: EXPERIMENT.slug});
    this.clock = env.DEVELOPMENT_CLOCK ?? Date.now;
    const environment = env.RELEASE_ENVIRONMENT ?? 'test';
    const registryConfiguration = env.START_REGISTRY_CONFIG ? JSON.parse(env.START_REGISTRY_CONFIG) : configurationForEnvironment(environment);
    if (registryConfiguration.chainId !== (environment === 'test' ? 84532 : 8453)) throw new Error('The start registry differs from the selected release network.');
    let chain = null;
    let registryConfigurationError = null;
    if (registryConfiguration.enabled && !env.SYNTHETIC_START_REGISTRY) {
      try { chain = env.SYNTHETIC_START_CHAIN ?? createStartChain({configuration: registryConfiguration, privateKey: env.START_REGISTRY_PRIVATE_KEY}); }
      catch (error) {
        registryConfigurationError = {code: error?.code ?? 'registry_configuration', message: 'The configured registry signing identity is unavailable.'};
        console.warn('Start registry configuration failed; scored Start remains unavailable and preparation can continue.', {code: registryConfigurationError.code});
      }
    }
    this.startRegistry = env.SYNTHETIC_START_REGISTRY ?? createStartRegistry({storage: this.storage, chain, configuration: registryConfiguration, clock: this.clock});
    this.registryConfigurationError = registryConfigurationError;
    this.publicationService = createPublicationService({storage: this.storage, bucket: env.TREE_PUBLICATIONS,
      getInventory: (seriesId, state) => this.publicationInventory(seriesId, state), clock: this.clock,
      environment: env.RELEASE_ENVIRONMENT ?? 'test'});
    this.randomService = env.SYNTHETIC_RANDOM_SERVICE ?? (env.RANDOM_ORG_API_KEY ?
      new RandomService({apiKey: env.RANDOM_ORG_API_KEY, experimentSlug: EXPERIMENT.slug}) : {
        async createTickets() { throw new HttpError(503, 'provider_unavailable', 'Random assignment provider is not configured.'); },
        async draw() { throw new HttpError(503, 'provider_unavailable', 'Random assignment provider is not configured.'); },
      });
    this.service = createService({experiment: EXPERIMENT, store: this.store, storage: this.storage,
      randomService: this.randomService, clock: this.clock, codeCheckpoint: env.SOURCE_CHECKPOINT ?? null,
      scoredCollectionEnabled: env.SCORED_COLLECTION_ENABLED === 'true', startRegistry: this.startRegistry,
      authenticate: request => {
        const id = request.headers.get('X-Tree-Actor');
        if (!id) throw new HttpError(403, 'access_missing', 'Access sign-in is required.');
        const role = request.headers.get('X-Tree-Actor-Role') ?? 'operator';
        if (role !== 'operator') throw new HttpError(403, 'operator_required', 'Field controls require operator sign-in.');
        return {id, role};
      },
      publish: record => this.publish(record),
      scheduleAlarm: (runId, deadline) => this.scheduleAlarm(runId, deadline),
      connectEvents: (request, actor, record, state) => this.connectEvents(request, actor, record, state),
    });
  }

  fetch(request) {
    const path = canonicalHostedStudyPath(new URL(request.url).pathname);
    if (path === `${PUBLIC_API_BASE}status`) return this.publicStatus(request);
    if (path.startsWith(PUBLIC_API_BASE)) return this.publicationService.readPublic(request);
    if (path.startsWith(PUBLICATION_API_BASE)) {
      return this.publicationService.fetch(request, {id: request.headers.get('X-Tree-Actor'),
        role: request.headers.get('X-Tree-Actor-Role')});
    }
    return this.service.fetch(request);
  }

  async publicStatus(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return json({code: 'method_not_allowed', message: 'Start registrations are read-only.'}, 405);
    try {
      // The public response uses cached records. RPC latency remains in one bounded background reconciliation.
      this.ctx.waitUntil(this.startRegistry.synchronize());
      const status = await this.startRegistry.status({runs: await this.store.listRuns(), publications: await this.publicationService.statusInventory()});
      if (this.registryConfigurationError) status.synchronization = {...status.synchronization, state: 'failed', error: this.registryConfigurationError};
      const response = json(status);
      return request.method === 'HEAD' ? new Response(null, {headers: response.headers}) : response;
    } catch (error) {
      console.warn('Public start registration status could not be read; start registrations remain retained.', {code: error?.code ?? 'status_unavailable'});
      return json({code: 'status_unavailable', message: 'Start registration status could not be loaded. Retry to read the retained records.'}, 503);
    }
  }

  async publicationInventory(seriesId, state = this.storage) {
    const inventoryStore = new SessionStore({storage: {get: key => state.get(key), transaction: operation => operation(state)}, experimentSlug: EXPERIMENT.slug});
    const series = await state.get(metadataKey(EXPERIMENT, 'series', seriesId));
    if (!series || series.config.purpose !== 'scored') return null;
    const inventory = [];
    for (const runId of publicSeries(series).collectionRunIds) {
      const member = series.members.find(item => item.runId === runId);
      const record = await inventoryStore.readRun(runId);
      inventory.push({...member, tag: record.tag ?? null, lifecycle: record.state.lifecycle,
        recordingStartedAtMs: record.state.recordingStartedAtMs ?? null,
        finishedAtMs: record.state.finishedAtMs ?? terminalEventTime(record.state.lifecycle, record.events)});
    }
    return inventory;
  }

  async scheduleAlarm(runId, deadline) {
    const key = metadataKey(EXPERIMENT, 'alarm', 'index');
    const deadlines = await this.storage.transaction(async transaction => {
      const pending = await transaction.get(key) ?? {};
      if (deadline) pending[runId] = deadline.atMs;
      else delete pending[runId];
      await transaction.put(key, pending);
      return pending;
    });
    await this.setNextAlarm(deadlines);
  }

  async setNextAlarm(deadlines) {
    const earliest = Math.min(...Object.values(deadlines));
    if (Number.isFinite(earliest)) {
      await this.ctx.storage.setAlarm(Math.max(Math.ceil(earliest), Math.ceil(this.clock() + 1)));
    } else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const key = metadataKey(EXPERIMENT, 'alarm', 'index');
    const deadlines = await this.storage.get(key) ?? {};
    for (const [runId, atMs] of Object.entries(deadlines)) {
      if (atMs <= this.clock()) {
        const result = await this.service.advanceDeadline(runId);
        if (!result.ok) {
          console.warn('Tree study alarm could not advance a run; it will be retried.',
            {runId, status: result.status});
          await this.scheduleAlarm(runId, {atMs: this.clock() + 1000});
        }
      }
    }
    await this.setNextAlarm(await this.storage.get(key) ?? {});
  }

  connectEvents(request, actor, record, state) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({runId: record.runId, actorId: actor.id, playback: false, lastCueId: null});
    server.send(JSON.stringify({kind: 'state', state}));
    return new Response(null, {status: 101, webSocket: client});
  }

  async publish(record) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.runId !== record.runId) continue;
      try {
        socket.send(JSON.stringify({kind: 'state', state: publicRecord(record, this.clock())}));
        this.sendPendingCue(socket, record);
      } catch (error) {
        console.warn('Tree study socket delivery failed; saved run state remains authoritative.',
          {runId: record.runId, message: error instanceof Error ? error.message : String(error)});
      }
    }
  }

  sendPendingCue(socket, record) {
    const attachment = socket.deserializeAttachment();
    const cue = record.state.pendingDelivery;
    if (!attachment?.playback || !cue || cue.deviceId !== attachment.deviceId ||
        attachment.lastCueId === cue.cueId) return;
    socket.send(JSON.stringify({kind: 'cue', cue: cueForSocket(cue)}));
    socket.serializeAttachment({...attachment, lastCueId: cue.cueId});
  }

  async webSocketMessage(socket, message) {
    let submitted;
    try { submitted = JSON.parse(message); }
    catch { socket.send(JSON.stringify({kind: 'error', code: 'invalid_json'})); return; }
    if (submitted?.kind !== 'playbackAuth') {
      socket.send(JSON.stringify({kind: 'error', code: 'unknown_message'}));
      return;
    }
    const attachment = socket.deserializeAttachment();
    const record = await this.store.readRun(attachment.runId);
    const token = await this.storage.get(metadataKey(EXPERIMENT, 'playback', attachment.runId));
    if (!token || submitted.playbackToken !== token ||
        submitted.deviceId !== record.state.playbackDeviceId ||
        attachment.actorId !== record.state.playbackActorId) {
      socket.send(JSON.stringify({kind: 'error', code: 'not_playback_device'}));
      return;
    }
    socket.serializeAttachment({...attachment, playback: true, deviceId: submitted.deviceId});
    socket.send(JSON.stringify({kind: 'playbackReady', runId: attachment.runId}));
    this.sendPendingCue(socket, record);
  }

  webSocketClose() {}
}
