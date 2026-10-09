import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createAccessAuthenticator} from '../../server/access.mjs';
import {createService} from '../../server/worker.mjs';
import {SessionStore} from '../../server/session-store.mjs';
import {EXPERIMENT, defaultConfig} from '../../web/run-config.mjs';

const base = 'https://lab.sourceof.love';

async function signedAccessToken(claims = {}) {
  const keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = encoded({alg: 'RS256', typ: 'JWT', kid: 'test-key'});
  const payload = encoded({
    iss: 'https://study.cloudflareaccess.com', aud: 'tree-audience',
    sub: 'operator-1', email: 'operator@example.test', iat: now - 10, exp: now + 60,
    ...claims,
  });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`));
  return {token: `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`,
    publicKey: {...publicKey, kid: 'test-key', use: 'sig', alg: 'RS256'}};
}

test('Access verifies signature, audience, issuer and expiry and rejects missing assertions', async () => {
  const signed = await signedAccessToken();
  const authenticate = createAccessAuthenticator({
    teamDomain: 'https://study.cloudflareaccess.com', audience: 'tree-audience',
    fetcher: async () => new Response(JSON.stringify({keys: [signed.publicKey]})),
  });
  const request = token => new Request(`${base}/tree-targeting/`, {
    headers: token ? {'Cf-Access-Jwt-Assertion': token} : {},
  });
  assert.equal((await authenticate(request(signed.token))).id, 'operator-1');
  await assert.rejects(() => authenticate(request()), {code: 'access_missing'});
  for (const changed of [
    {aud: 'other'}, {iss: 'https://other.cloudflareaccess.com'},
    {exp: Math.floor(Date.now() / 1000) - 1},
  ]) {
    const invalid = await signedAccessToken(changed);
    const verifier = createAccessAuthenticator({
      teamDomain: 'https://study.cloudflareaccess.com', audience: 'tree-audience',
      fetcher: async () => new Response(JSON.stringify({keys: [invalid.publicKey]})),
    });
    await assert.rejects(() => verifier(request(invalid.token)), {code: 'access_invalid'});
  }
  const pieces = signed.token.split('.');
  pieces[1] = `${pieces[1].slice(0, -1)}A`;
  await assert.rejects(() => authenticate(request(pieces.join('.'))), {code: 'access_invalid'});
});

test('Access fails closed when configured keys are unavailable', async () => {
  const signed = await signedAccessToken();
  const authenticate = createAccessAuthenticator({
    teamDomain: 'https://study.cloudflareaccess.com', audience: 'tree-audience',
    fetcher: async () => { throw new Error('network down'); },
  });
  await assert.rejects(() => authenticate(new Request(`${base}/tree-targeting/`, {
    headers: {'Cf-Access-Jwt-Assertion': signed.token},
  })), {code: 'access_unavailable'});
});

test('the lab and Tree routes share authentication and unknown routes cannot expose run data', async () => {
  const service = createService({experiment: EXPERIMENT, authenticate: async request => {
    if (request.headers.get('x-test-operator') !== 'yes') throw Object.assign(new Error('Unauthorized'), {status: 403, code: 'access_missing'});
    return {id: 'operator-1'};
  }, store: {}, randomService: {}, clock: () => 5000});
  const request = (path, authenticated = true) => new Request(`${base}${path}`, {
    headers: authenticated ? {'x-test-operator': 'yes'} : {},
  });
  assert.equal((await service.fetch(request('/', false))).status, 403);
  const selector = await service.fetch(request('/'));
  assert.equal(selector.status, 200);
  assert.match(await selector.text(), /href="\/studies\/targeted-vegetation-movement\/app\/"/);
  assert.equal((await service.fetch(request('/api/runs'))).status, 404);
  assert.equal((await service.fetch(request('/unknown/api/runs'))).status, 404);
  assert.equal((await service.fetch(request('/tree-targeting/api/missing'))).status, 404);
  assert.equal((await service.fetch(request('/tree-targeting/api/clock', false))).status, 403);
  const clock = await (await service.fetch(request('/tree-targeting/api/clock'))).json();
  assert.equal(clock.serverReceivedAtMs, 5000);
  assert.equal(clock.serverSentAtMs, 5000);
  assert.ok(clock.exchangeId);
});

test('a dedicated service JWT has only the publisher audience and exact service identity', async () => {
  const configured = {teamDomain: 'https://study.cloudflareaccess.com', audience: 'tree-audience',
    publisherAudience: 'publication-audience', publisherServiceIdentity: 'software-test.access'};
  const request = token => new Request(`${base}/studies/tree-targeting/app/api/publication/jobs`, {headers: {'Cf-Access-Jwt-Assertion': token}});
  for (const [claims, accepted] of [
    [{sub: '', aud: ['publication-audience'], common_name: 'software-test.access', type: 'app'}, true],
    [{sub: '', aud: ['tree-audience'], common_name: 'software-test.access', type: 'app'}, false],
    [{sub: '', aud: ['publication-audience'], common_name: 'other.access', type: 'app'}, false],
    [{sub: 'operator-1', aud: ['publication-audience'], common_name: 'software-test.access', type: 'app'}, false],
  ]) {
    const signed = await signedAccessToken(claims);
    const authenticate = createAccessAuthenticator({...configured, fetcher: async () => new Response(JSON.stringify({keys: [signed.publicKey]}))});
    if (accepted) assert.equal((await authenticate(request(signed.token))).role, 'publisher');
    else await assert.rejects(() => authenticate(request(signed.token)), {code: 'access_invalid'});
  }
});


test('signed operator and publisher identities retain the same roles on old and canonical Test APIs', async () => {
  const {createWorkerHandler} = await import('../../server/worker.mjs');
  for (const [claims, role] of [[{}, 'operator'], [{sub: '', aud: ['publication-audience'], common_name: 'software-test.access', type: 'app'}, 'publisher']]) {
    const signed = await signedAccessToken(claims);
    const authenticate = createAccessAuthenticator({teamDomain: 'https://study.cloudflareaccess.com', audience: 'tree-audience',
      publisherAudience: 'publication-audience', publisherServiceIdentity: 'software-test.access',
      fetcher: async () => Response.json({keys: [signed.publicKey]})});
    const handler = createWorkerHandler({authenticate}), names = [];
    const env = {RELEASE_ENVIRONMENT: 'test', TREE_SESSIONS: {idFromName: name => {names.push(name); return name;},
      get: () => ({fetch: async request => Response.json({actor: request.headers.get('X-Tree-Actor'), role: request.headers.get('X-Tree-Actor-Role')})})}};
    for (const slug of ['targeted-vegetation-movement', 'tree-targeting']) {
      const api = base + '/studies/' + slug + '/app/api/';
      for (const [suffix, accepted] of [['runs', role === 'operator'], ['publication/jobs', role === 'publisher']]) {
        assert.equal((await handler.fetch(new Request(api + suffix), env)).status, 403);
        const response = await handler.fetch(new Request(api + suffix, {headers: {'Cf-Access-Jwt-Assertion': signed.token}}), env);
        assert.equal(response.status, accepted ? 200 : 403, role + ' ' + slug + ' ' + suffix);
        if (accepted) assert.equal((await response.json()).role, role);
      }
    }
    assert.deepEqual(names, ['tree-targeting', 'tree-targeting']);
  }
});
