const ENDPOINT = 'https://api.random.org/json-rpc/4/invoke';

export function protocolError(code, message) {
  return Object.assign(new Error(message), {code});
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw protocolError('invalid_record', 'Records must contain only finite JSON values.');
}

export function validateExperimentSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw protocolError('invalid_experiment', 'A valid experiment slug is required.');
  }
  return slug;
}

export function validateBinding(binding, experimentSlug) {
  if (binding?.experimentSlug !== experimentSlug) throw protocolError('experiment_mismatch', 'Assignment belongs to another experiment.');
  for (const field of ['runId', 'stream', 'opportunityId', 'configHash', 'actionId']) {
    if (typeof binding[field] !== 'string' || !binding[field].trim()) throw protocolError('invalid_binding', `Assignment requires ${field}.`);
  }
  if (JSON.stringify(binding).length > 1000) throw protocolError('invalid_binding', 'Assignment binding exceeds the provider limit.');
  canonicalJson(binding);
  return structuredClone(binding);
}

export function validateSignedResult(result, ticketId, binding) {
  const random = result?.random;
  if (!random || random.method !== 'generateSignedIntegers' || random.n !== 1 || random.min !== 0 || random.max !== 1
      || random.replacement !== true || random.base !== 10 || random.pregeneratedRandomization !== null
      || !Array.isArray(random.data) || random.data.length !== 1 || ![0, 1].includes(random.data[0])
      || random.ticketData?.ticketId !== ticketId || canonicalJson(random.userData ?? null) !== canonicalJson(binding)
      || !Number.isInteger(random.serialNumber) || random.serialNumber < 0
      || typeof random.completionTime !== 'string' || !Number.isFinite(Date.parse(random.completionTime))
      || typeof result.signature !== 'string' || !result.signature) {
    throw protocolError('provider_result_mismatch', 'Signed result does not match the frozen ticket, binding or fresh binary request.');
  }
  return random.data[0];
}

export class RandomService {
  #apiKey;
  #fetcher;
  #logger;
  #now;
  #sleep;
  #queue = Promise.resolve();
  #nextCallAtMs = 0;
  #sequence = 0;
  #bindings = new Map();

  constructor({fetcher = (...args) => globalThis.fetch(...args), apiKey, experimentSlug = 'tree-targeting', logger = console,
    now = Date.now, sleep = delay => new Promise(resolve => setTimeout(resolve, delay))}) {
    Object.defineProperty(this, 'experimentSlug', {value: validateExperimentSlug(experimentSlug), enumerable: true});
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
    this.#logger = logger;
    this.#now = now;
    this.#sleep = sleep;
  }

  #warn(message, context) { this.#logger.warn(message, context); }

  async #request(method, params, id = `${method}-${++this.#sequence}`) {
    const operation = async () => {
      const delay = this.#nextCallAtMs - this.#now();
      if (delay > 0) await this.#sleep(delay);
      let response;
      let envelope;
      try {
        response = await this.#fetcher(ENDPOINT, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({jsonrpc: '2.0', method, params, id}),
        });
        if (!response.ok) throw protocolError('provider_transport', 'RANDOM.ORG transport is unavailable.');
        envelope = await response.json();
      } catch {
        throw protocolError('provider_transport', 'RANDOM.ORG response is unavailable; the ticket outcome may be unresolved.');
      }
      if (envelope?.jsonrpc !== '2.0' || envelope.id !== id) throw protocolError('provider_response_invalid', 'RANDOM.ORG returned an unrelated or malformed response.');
      if (envelope.error) {
        throw Object.assign(protocolError('provider_error', 'RANDOM.ORG rejected the request.'), {
          providerCode: Number.isInteger(envelope.error.code) ? envelope.error.code : null,
        });
      }
      if (!Object.hasOwn(envelope, 'result')) throw protocolError('provider_response_invalid', 'RANDOM.ORG returned no result.');
      const delayMs = envelope.result?.advisoryDelay;
      if (Number.isFinite(delayMs) && delayMs > 0) this.#nextCallAtMs = this.#now() + delayMs;
      return envelope;
    };
    const result = this.#queue.then(operation, operation);
    this.#queue = result;
    return result;
  }

  async createTickets(count) {
    if (!Number.isSafeInteger(count) || count < 1) throw protocolError('invalid_ticket_count', 'A positive ticket count is required.');
    const tickets = [];
    try {
      while (tickets.length < count) {
        const size = Math.min(50, count - tickets.length);
        const {result} = await this.#request('createTickets', {apiKey: this.#apiKey, n: size, showResult: false});
        if (!Array.isArray(result) || result.length !== size || result.some(ticket =>
          typeof ticket.ticketId !== 'string' || !ticket.ticketId || ticket.nextTicketId !== null || ticket.previousTicketId != null)) {
          throw protocolError('provider_response_invalid', 'RANDOM.ORG did not return the requested independent tickets.');
        }
        tickets.push(...structuredClone(result));
        if (new Set(tickets.map(ticket => ticket.ticketId)).size !== tickets.length) throw protocolError('provider_response_invalid', 'RANDOM.ORG returned duplicate tickets.');
      }
      return tickets;
    } catch (error) {
      this.#warn('Ticket creation failed; preserve any created tickets and stop preparation.', {code: error.code, createdCount: tickets.length});
      error.createdTickets = tickets;
      throw error;
    }
  }

  async draw(ticketId, binding) {
    const expected = validateBinding(binding, this.experimentSlug);
    if (typeof ticketId !== 'string' || !ticketId) throw protocolError('invalid_ticket', 'A reserved ticket is required.');
    const previous = this.#bindings.get(ticketId);
    if (previous && canonicalJson(previous) !== canonicalJson(expected)) throw protocolError('ticket_binding_conflict', 'A ticket cannot be rebound to another opportunity.');
    this.#bindings.set(ticketId, expected);
    let envelope;
    try {
      envelope = await this.#request('generateSignedIntegers', {
        apiKey: this.#apiKey, n: 1, min: 0, max: 1, replacement: true, base: 10,
        pregeneratedRandomization: null, ticketId, userData: expected,
      }, expected.actionId);
    } catch (error) {
      const recoverable = error.code === 'provider_transport' || error.code === 'provider_response_invalid' || error.providerCode === 422;
      this.#warn('Random assignment request failed.', {ticketId, runId: expected.runId, code: error.code,
        providerCode: error.providerCode ?? null, recovery: recoverable ? 'retrieve_same_ticket' : 'stop'});
      if (!recoverable) throw error;
      return this.recover(ticketId, expected);
    }
    return this.#evidence(envelope.result, ticketId, expected, false);
  }

  #evidence(result, ticketId, binding, recovered) {
    const value = validateSignedResult(result, ticketId, binding);
    return {value, result: structuredClone(result), recovered, verification: {status: 'pending'}};
  }

  async recover(ticketId, binding = this.#bindings.get(ticketId)) {
    const expected = validateBinding(binding, this.experimentSlug);
    const {result: ticket} = await this.#request('getTicket', {ticketId});
    if (ticket?.ticketId !== ticketId || ticket.showResult !== false) throw protocolError('provider_result_mismatch', 'Recovery returned another or publicly revealing ticket.');
    if (!Number.isInteger(ticket.serialNumber) || ticket.serialNumber < 0 || !ticket.usedTime) {
      throw protocolError('provider_recovery_pending', 'The reserved ticket has no recoverable result; progression must stop.');
    }
    const {result} = await this.#request('getResult', {apiKey: this.#apiKey, serialNumber: ticket.serialNumber});
    if (result?.random?.serialNumber !== ticket.serialNumber) throw protocolError('provider_result_mismatch', 'Recovery returned a different result serial number.');
    return this.#evidence(result, ticketId, expected, true);
  }

  async verifySignature(result, ticketId, binding) {
    validateBinding(binding, this.experimentSlug);
    validateSignedResult(result, ticketId, binding);
    try {
      const response = await this.#request('verifySignature', {random: result.random, signature: result.signature});
      if (typeof response.result?.authenticity !== 'boolean') throw protocolError('provider_response_invalid', 'Signature verification returned no authenticity decision.');
      return {status: response.result.authenticity ? 'verified' : 'invalid', response: structuredClone(response)};
    } catch (error) {
      this.#warn('Signature verification unavailable; audit remains pending.', {ticketId, runId: binding.runId, code: error.code});
      return {status: 'pending', error: {code: error.code, message: error.message}};
    }
  }
}
