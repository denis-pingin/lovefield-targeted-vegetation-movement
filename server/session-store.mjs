import {canonicalJson, protocolError, validateBinding, validateExperimentSlug, validateSignedResult} from './random-service.mjs';

const TERMINAL = new Set(['completed', 'stopped', 'failed']);
const EVENT_LIFECYCLES = {stop: 'stopped', stopped: 'stopped', failed: 'failed', completed: 'completed'};
const LIFECYCLE_ORDER = ['draft', 'prepared', 'running', 'completed', 'stopped', 'failed'];
const TERMINAL_EVENT_KINDS = {
  completed: ['deadlineReached'], stopped: ['stop', 'stopped'],
  failed: ['providerFailed', 'failed', 'cueFailed'],
};

export function terminalEventTime(lifecycle, events = []) {
  const kinds = TERMINAL_EVENT_KINDS[lifecycle];
  return kinds ? events.findLast(event => kinds.includes(event.kind) && Number.isFinite(event.serverAtMs))?.serverAtMs ?? null : null;
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw protocolError('invalid_identifier', `${label} is required.`);
  return value;
}

function same(a, b) { return canonicalJson(a) === canonicalJson(b); }

function runTag(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 200) throw protocolError('invalid_tag', 'Use a run tag of at most 200 characters.');
  return value.trim() || null;
}

export class SessionStore {
  #storage;
  #sourceCheckpoint;

  constructor({storage, experimentSlug, sourceCheckpoint = null}) {
    if (typeof storage?.transaction !== 'function') throw protocolError('transaction_required', 'Session storage requires atomic transactions.');
    this.#storage = storage;
    this.#sourceCheckpoint = sourceCheckpoint;
    Object.defineProperty(this, 'experimentSlug', {value: validateExperimentSlug(experimentSlug), enumerable: true});
  }

  withSourceCheckpoint(sourceCheckpoint) {
    return new SessionStore({storage: this.#storage, experimentSlug: this.experimentSlug, sourceCheckpoint});
  }

  #key(runId, suffix = '') {
    return `experiment:${this.experimentSlug}:run:${encodeURIComponent(identifier(runId, 'Run identifier'))}${suffix}`;
  }

  #checkIdentity(record, runId) {
    if (record?.experimentSlug != null && record.experimentSlug !== this.experimentSlug) throw protocolError('experiment_mismatch', 'Record belongs to another experiment.');
    if (runId && record?.runId != null && record.runId !== runId) throw protocolError('run_mismatch', 'Record belongs to another run.');
  }

  #checkNestedIdentity(record, runId) {
    if (!record || typeof record !== 'object') return;
    this.#checkIdentity(record, runId);
    for (const value of Object.values(record)) this.#checkNestedIdentity(value, runId);
  }

  #indexKey() { return `experiment:${this.experimentSlug}:runs`; }

  async #read(storage, runId) {
    const run = await storage.get(this.#key(runId));
    if (!run) throw protocolError('run_not_found', 'Run was not found in this experiment.');
    return run;
  }

  async createRun(record) {
    this.#checkIdentity(record);
    this.#checkIdentity(record.config);
    const runId = identifier(record.runId, 'Run identifier');
    const config = structuredClone(record.config);
    if (!config || config.experimentSlug !== this.experimentSlug) throw protocolError('experiment_mismatch', 'Configuration must declare the owning experiment.');
    const profile = structuredClone(record.profile ?? {});
    canonicalJson(config);
    canonicalJson(profile);
    const sealedConfigJson = JSON.stringify(config);
    const sealedProfileJson = JSON.stringify(profile);
    const configHash = await sha256(sealedConfigJson);
    const profileHash = await sha256(sealedProfileJson);
    const tickets = this.#tickets(record.tickets ?? [], runId, configHash);
    const run = {
      ...structuredClone(record), version: 'tree-targeting-3', experimentSlug: this.experimentSlug, runId,
      tag: runTag(record.tag),
      config, profile, sealedConfigJson, sealedProfileJson, configHash, profileHash,
      state: structuredClone(record.state ?? {lifecycle: 'draft'}), tickets, actions: [], events: [], clockReferences: [],
      revision: 1, exportRevision: 0, exportedContentRevision: null,
    };
    delete run.hash;
    this.#checkNestedIdentity(run, runId);
    canonicalJson(run);
    return this.#storage.transaction(async storage => {
      if (await storage.get(this.#key(runId))) throw protocolError('run_exists', 'Run already exists; repeat creates a new run.');
      await this.#claimTickets(storage, runId, tickets);
      await storage.put(this.#key(runId), run);
      const runIds = await storage.get(this.#indexKey()) ?? [];
      await storage.put(this.#indexKey(), [...runIds, runId]);
      return structuredClone(run);
    });
  }

  #tickets(input, runId, configHash) {
    const tickets = input.map(ticket => {
      this.#checkIdentity(ticket, runId);
      this.#checkIdentity(ticket.binding, runId);
      for (const field of ['stream', 'opportunityId']) {
        if (Object.hasOwn(ticket, field) && ticket.binding && Object.hasOwn(ticket.binding, field)
            && ticket[field] !== ticket.binding[field]) {
          throw protocolError('ticket_binding_conflict', 'Ticket fields contradict the nested opportunity binding.');
        }
      }
      const binding = {experimentSlug: this.experimentSlug, runId,
        stream: identifier(ticket.stream ?? ticket.binding?.stream, 'Ticket stream'),
        opportunityId: identifier(ticket.opportunityId ?? ticket.binding?.opportunityId, 'Ticket opportunity'), configHash};
      if (ticket.binding?.configHash && ticket.binding.configHash !== configHash) throw protocolError('ticket_binding_conflict', 'Ticket configuration differs from the sealed run.');
      const saved = {ticketId: identifier(ticket.ticketId, 'Ticket identifier'), binding,
        rules: structuredClone(ticket.rules ?? {}), status: 'unused'};
      if (ticket.creationTime != null) {
        saved.providerTicket = Object.fromEntries(['ticketId', 'creationTime', 'previousTicketId', 'nextTicketId', 'expirationTime']
          .filter(key => Object.hasOwn(ticket, key)).map(key => [key, structuredClone(ticket[key])]));
      }
      return saved;
    });
    if (new Set(tickets.map(ticket => ticket.ticketId)).size !== tickets.length
        || new Set(tickets.map(ticket => canonicalJson([ticket.binding.stream, ticket.binding.opportunityId]))).size !== tickets.length) {
      throw protocolError('duplicate_ticket', 'Every opportunity requires its own unique ticket.');
    }
    return tickets;
  }

  async #claimTickets(storage, runId, tickets) {
    for (const ticket of tickets) {
      const ownerKey = `experiment:${this.experimentSlug}:ticket:${encodeURIComponent(ticket.ticketId)}`;
      if (await storage.get(ownerKey)) throw protocolError('ticket_binding_conflict', 'Ticket is already reserved for another run.');
      await storage.put(ownerKey, runId);
    }
  }

  async attachTickets(runId, input) {
    this.#checkNestedIdentity(input, runId);
    canonicalJson(input);
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      const tickets = this.#tickets(input, runId, run.configHash);
      if (run.tickets.length) {
        if (same(run.tickets, tickets)) return structuredClone(run);
        throw protocolError('ticket_manifest_frozen', 'The ordered ticket manifest cannot be replaced.');
      }
      if (!['draft', 'prepared'].includes(run.state.lifecycle)) throw protocolError('run_started', 'Attach the ordered ticket manifest before starting the run.');
      await this.#claimTickets(storage, runId, tickets);
      run.tickets = tickets;
      run.revision += 1;
      await storage.put(this.#key(runId), run);
      return structuredClone(run);
    });
  }

  async readRun(runId) { return structuredClone(await this.#read(this.#storage, runId)); }

  async recordStartRegistration(runId, registration, serverAtMs) {
    this.#checkNestedIdentity(registration, runId);
    canonicalJson(registration);
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      if (same(run.startRegistration ?? null, registration)) return structuredClone(run);
      if (run.startRegistration?.status === 'confirmed' && !same(run.startRegistration.registration, registration.registration)) {
        throw protocolError('start_identity_conflict', 'A confirmed run registration cannot be replaced.');
      }
      run.startRegistration = structuredClone(registration);
      this.#append(run, {kind: 'startRegistrationUpdated', serverAtMs, data: registration});
      run.revision += 1;
      await storage.put(this.#key(runId), run);
      return structuredClone(run);
    });
  }

  async updateTag(runId, value, {actor, serverAtMs}) {
    const tag = runTag(value);
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      if ((run.tag ?? null) === tag) return structuredClone(run);
      run.tag = tag;
      this.#append(run, {kind: 'runTagUpdated', actor, serverAtMs, data: {tag}});
      run.revision += 1;
      await storage.put(this.#key(runId), run);
      return structuredClone(run);
    });
  }

  async listRuns() {
    const runIds = await this.#storage.get(this.#indexKey()) ?? [];
    return Promise.all(runIds.map(runId => this.readRun(runId)));
  }

  async reserveAction(runId, actionId, payload, {binding, ticketId} = {}) {
    identifier(actionId, 'Action identifier');
    this.#checkNestedIdentity(payload, runId);
    this.#checkIdentity(binding, runId);
    const payloadJson = canonicalJson(payload);
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      const existing = run.actions.find(action => action.actionId === actionId);
      if (existing) {
        if (existing.payloadJson !== payloadJson || (binding && !this.#matchesBinding(existing.binding, binding))
            || (ticketId && existing.ticketId !== ticketId)) throw protocolError('action_conflict', 'Action identifier was reused with conflicting data.');
        return this.#reservation(existing, false, true);
      }
      if (TERMINAL.has(run.state.lifecycle) &&
          !['saveClockReference', 'attachSetup', 'cuePlayed', 'cueEnded', 'cueFailed', 'cueTimeout'].includes(payload.kind)) {
        throw protocolError('run_terminal', 'This run has ended.');
      }
      let ticket;
      if (binding) {
        ticket = run.tickets.find(candidate => this.#matchesBinding(candidate.binding, binding));
        if (!ticket || (ticketId && ticket.ticketId !== ticketId)) throw protocolError('ticket_binding_conflict', 'No planned ticket matches this opportunity.');
      } else if (ticketId) {
        ticket = run.tickets.find(candidate => candidate.ticketId === ticketId);
        if (!ticket) throw protocolError('ticket_binding_conflict', 'Ticket is not planned for this run.');
      } else if (payload.kind === 'ready') {
        ticket = run.tickets.find(candidate => candidate.binding.stream === 'local' && candidate.status === 'reserved')
          ?? run.tickets.find(candidate => candidate.binding.stream === 'local' && candidate.status === 'unused');
        if (!ticket) throw protocolError('tickets_exhausted', 'No planned local opportunity remains.');
      }
      const shouldDraw = ticket?.status === 'unused';
      if (shouldDraw) {
        ticket.status = 'reserved';
        ticket.binding = validateBinding({...ticket.binding, actionId}, this.experimentSlug);
        ticket.ownerActionId = actionId;
      }
      const action = {actionId, ownerActionId: ticket?.ownerActionId ?? actionId, payload: structuredClone(payload),
        payloadJson, status: 'reserved', receipt: null, ticketId: ticket?.ticketId ?? null, binding: ticket?.binding ?? null};
      run.actions.push(action);
      run.revision += 1;
      await storage.put(this.#key(runId), run);
      return this.#reservation(action, shouldDraw, false);
    });
  }

  #matchesBinding(first, second) {
    return first && second && ['experimentSlug', 'runId', 'stream', 'opportunityId', 'configHash'].every(key => first[key] === second[key]);
  }

  #reservation(action, shouldDraw, replay) {
    const {payload, payloadJson, ...reservation} = action;
    return structuredClone({...reservation, shouldDraw: Boolean(shouldDraw), replay});
  }

  #append(run, input) {
    this.#checkIdentity(input, run.runId);
    if (!Number.isFinite(input.serverAtMs)) throw protocolError('invalid_event', 'Event requires a finite server timestamp.');
    identifier(input.kind, 'Event kind');
    const event = {...structuredClone(input), experimentSlug: this.experimentSlug, runId: run.runId,
      sequence: run.events.length + 1, actionId: input.actionId ?? null, actor: input.actor ?? 'server',
      ...(this.#sourceCheckpoint === null ? {} : {sourceCheckpoint: this.#sourceCheckpoint})};
    run.events.push(event);
    const lifecycle = EVENT_LIFECYCLES[event.kind];
    if (lifecycle && !TERMINAL.has(run.state.lifecycle)) {
      run.state.lifecycle = lifecycle;
      if (!Number.isFinite(run.state.finishedAtMs)) run.state.finishedAtMs = event.serverAtMs;
    }
    if (event.kind === 'saveClockReference') run.clockReferences.push(structuredClone(event));
    return event;
  }

  async appendEvent(runId, event) {
    this.#checkNestedIdentity(event, runId);
    canonicalJson(event);
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      const saved = this.#append(run, event);
      run.revision += 1;
      await storage.put(this.#key(runId), run);
      return structuredClone(saved);
    });
  }

  async completeAction(runId, actionId, completion) {
    this.#checkNestedIdentity(completion, runId);
    canonicalJson(completion);
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      const action = run.actions.find(candidate => candidate.actionId === actionId);
      if (!action) throw protocolError('action_not_reserved', 'Reserve an action before completing it.');
      const terminal = TERMINAL.has(run.state.lifecycle);
      let savedResult = false;
      if (completion.providerResult) {
        const ticket = run.tickets.find(candidate => candidate.ticketId === action.ticketId);
        if (!ticket) throw protocolError('ticket_not_reserved', 'Reserve an opportunity before recording a provider result.');
        validateSignedResult(completion.providerResult, ticket.ticketId, ticket.binding);
        if (ticket.result && !same(ticket.result, completion.providerResult)) throw protocolError('assignment_conflict', 'An issued assignment cannot be replaced.');
        if (!ticket.result) {
          ticket.result = structuredClone(completion.providerResult);
          ticket.status = 'issued';
          ticket.verification = {status: 'pending'};
          savedResult = true;
          this.#append(run, {kind: 'assignmentRecorded', serverAtMs: completion.serverAtMs, actionId,
            actor: 'server', data: {ticketId: ticket.ticketId, late: terminal}});
        }
      }
      if (action.status === 'completed' && !savedResult) {
        if (completion.receipt && !same(action.receipt, completion.receipt)) throw protocolError('action_conflict', 'A completed action receipt cannot be changed.');
        return {receipt: structuredClone(action.receipt), allowDelivery: false};
      }
      if (terminal && completion.state && ['cuePlayed', 'cueEnded', 'cueFailed', 'cueTimeout'].includes(action.payload.kind)) {
        run.state.cues = structuredClone(completion.state.cues);
        run.state.pendingDelivery = structuredClone(completion.state.pendingDelivery);
        run.state.currentInstruction = completion.state.currentInstruction;
        if (['cueFailed', 'cueTimeout'].includes(action.payload.kind)) {
          run.state.lastError = structuredClone(completion.state.lastError);
        }
      }
      if (terminal && completion.state && action.payload.kind === 'attachSetup') {
        run.state.setupSnapshot = structuredClone(completion.state.setupSnapshot);
      }
      if (!terminal && completion.state) {
        if (completion.state.config && !same(completion.state.config, run.config)) {
          if (run.state.lifecycle !== 'draft' || run.tickets.length) throw protocolError('config_immutable', 'Only an unticketed draft can change configuration.');
          run.config = structuredClone(completion.state.config);
          run.sealedConfigJson = JSON.stringify(run.config);
          run.configHash = await sha256(run.sealedConfigJson);
        }
        const nextLifecycle = LIFECYCLE_ORDER.indexOf(completion.state.lifecycle);
        if (nextLifecycle < 0 || nextLifecycle < LIFECYCLE_ORDER.indexOf(run.state.lifecycle)) {
          throw protocolError('invalid_lifecycle', 'Run lifecycle cannot be omitted or moved backwards.');
        }
        run.state = structuredClone(completion.state);
      }
      if (completion.failure) {
        if (!terminal) run.state.lifecycle = 'failed';
        run.state.lastError = structuredClone(completion.failure);
        this.#append(run, {kind: 'providerFailed', serverAtMs: completion.serverAtMs, actionId,
          actor: 'server', data: structuredClone(completion.failure)});
      }
      for (const event of completion.events ?? []) this.#append(run, event);
      if (!terminal && TERMINAL.has(run.state.lifecycle) && !Number.isFinite(run.state.finishedAtMs)
          && Number.isFinite(completion.serverAtMs)) {
        run.state.finishedAtMs = terminalEventTime(run.state.lifecycle, completion.events) ?? completion.serverAtMs;
      }
      if (action.status !== 'completed') action.receipt = structuredClone(completion.receipt ?? {actionId, accepted: !completion.failure});
      action.status = 'completed';
      run.revision += 1;
      await storage.put(this.#key(runId), run);
      return {receipt: structuredClone(action.receipt), allowDelivery: savedResult && !TERMINAL.has(run.state.lifecycle)};
    });
  }

  async ticketManifest(runId) {
    const run = await this.#read(this.#storage, runId);
    return {experimentSlug: this.experimentSlug, runId, configHash: run.configHash,
      tickets: run.tickets.map(ticket => ({ticketId: ticket.ticketId, rules: structuredClone(ticket.rules), binding: {
        experimentSlug: this.experimentSlug, runId, stream: ticket.binding.stream,
        opportunityId: ticket.binding.opportunityId, configHash: run.configHash,
      }}))};
  }

  async recordVerification(runId, ticketId, verification, serverAtMs = Date.now()) {
    this.#checkNestedIdentity(verification, runId);
    canonicalJson(verification);
    if (!Number.isFinite(serverAtMs)) throw protocolError('invalid_event', 'Verification needs a finite server timestamp.');
    if (!['pending', 'verified', 'invalid'].includes(verification?.status)) {
      throw protocolError('invalid_verification', 'Verification status is invalid.');
    }
    if (verification.status !== 'pending' &&
        verification.response?.result?.authenticity !== (verification.status === 'verified')) {
      throw protocolError('invalid_verification', 'Provider authenticity must match verification status.');
    }
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      const ticket = run.tickets.find(candidate => candidate.ticketId === ticketId);
      if (!ticket || ticket.status !== 'issued' || !ticket.result) {
        throw protocolError('ticket_not_issued', 'Only an issued ticket can be verified.');
      }
      if (same(ticket.verification, verification)) return structuredClone(ticket.verification);
      if (ticket.verification?.status !== 'pending') {
        throw protocolError('verification_conflict', 'A decided signature verification cannot be replaced.');
      }
      ticket.verification = structuredClone(verification);
      this.#append(run, {kind: 'signatureVerification', serverAtMs, actor: 'server',
        data: {ticketId, status: verification.status}});
      run.revision += 1;
      await storage.put(this.#key(runId), run);
      return structuredClone(ticket.verification);
    });
  }

  async exportRun(runId, revision) {
    return this.#storage.transaction(async storage => {
      const run = await this.#read(storage, runId);
      if (!TERMINAL.has(run.state.lifecycle)) throw protocolError('run_not_terminal', 'Full audit export is available only after the run ends.');
      if (revision != null) {
        if (!Number.isSafeInteger(revision) || revision < 1) throw protocolError('invalid_revision', 'A positive export revision is required.');
        const saved = await storage.get(this.#key(runId, `:export:${revision}`));
        if (!saved) throw protocolError('export_not_found', 'Export revision was not found.');
        return structuredClone(saved);
      }
      if (run.exportedContentRevision === run.revision) return structuredClone(await storage.get(this.#key(runId, `:export:${run.exportRevision}`)));
      const {revision: contentRevision, exportRevision, exportedContentRevision, ...content} = run;
      const snapshot = {...content, cues: structuredClone(run.state.cues ?? run.cues ?? []), bundleRevision: exportRevision + 1};
      snapshot.hash = await sha256(JSON.stringify(snapshot));
      await storage.put(this.#key(runId, `:export:${snapshot.bundleRevision}`), snapshot);
      run.exportRevision = snapshot.bundleRevision;
      run.exportedContentRevision = contentRevision;
      await storage.put(this.#key(runId), run);
      return structuredClone(snapshot);
    });
  }
}
