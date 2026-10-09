import test from 'node:test';
import assert from 'node:assert/strict';
import {createStartChain, configurationForEnvironment, EAS_ABI, SCHEMA_ABI, SCHEMA_UID, SCHEMA, EAS_ADDRESS, SCHEMA_REGISTRY_ADDRESS, encodeStartPayload, decodeStartPayload} from '../../server/start-chain.mjs';
import {custom, decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, recoverTransactionAddress, zeroAddress, zeroHash} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

// Deterministic fixture owned only by this test; never use this account on a network.
const fixtureKey = `0x${'11'.repeat(32)}`;
const signerAddress = privateKeyToAccount(fixtureKey).address;
const configuration = {enabled: true, chainId: 84532, rpcUrl: 'https://rpc.example.test', signerAddress, fromBlock: '100'};
const start = {study: 'tree-targeting', seriesId: 'series', runId: 'run', configHash: `0x${'a'.repeat(64)}`, sourceCheckpoint: 'b'.repeat(40)};
const uid = `0x${'c'.repeat(64)}`, blockHash = `0x${'d'.repeat(64)}`;
function fixture(overrides = {}, selectedConfiguration = configuration) {
  const calls = [];
  const transport = custom({request: async request => {
    calls.push(request);
    if (overrides[request.method]) return overrides[request.method](request);
    if (request.method === 'eth_chainId') return '0x14a34';
    if (request.method === 'eth_getTransactionCount') return '0x7';
    if (request.method === 'eth_gasPrice') return '0x3b9aca00';
    if (request.method === 'eth_estimateGas') return '0x493e0';
    if (request.method === 'eth_call') {
      if (request.params[0].to === SCHEMA_REGISTRY_ADDRESS) return encodeFunctionResult({abi: SCHEMA_ABI, functionName: 'getSchema', result: {uid: SCHEMA_UID, resolver: zeroAddress, revocable: false, schema: SCHEMA}});
      return encodeFunctionResult({abi: EAS_ABI, functionName: 'getAttestation', result: {uid, schema: SCHEMA_UID, time: 1000n, expirationTime: 0n, revocationTime: 0n, refUID: zeroHash, recipient: zeroAddress, attester: signerAddress, revocable: false, data: encodeStartPayload(start)}});
    }
    if (request.method === 'eth_getTransactionReceipt') return {transactionHash: request.params[0], from: signerAddress, to: EAS_ADDRESS, status: '0x1', blockNumber: '0x64', blockHash, logs: [{address: EAS_ADDRESS, topics: encodeEventTopics({abi: EAS_ABI, eventName: 'Attested', args: {recipient: zeroAddress, attester: signerAddress, schemaUID: SCHEMA_UID}}), data: encodeAbiParameters([{type: 'bytes32'}], [uid]), blockNumber: '0x64', blockHash, transactionHash: request.params[0], logIndex: '0x0'}]};
    if (request.method === 'eth_getBlockByHash' || request.method === 'eth_getBlockByNumber') return {number: '0x64', hash: blockHash, timestamp: '0x3e8'};
    if (request.method === 'eth_getLogs') return [];
    if (request.method === 'eth_sendRawTransaction') return keccak256(request.params[0]);
    throw new Error(`Unexpected fixture RPC ${request.method}`);
  }}, {retryCount: 0});
  return {calls, chain: createStartChain({configuration: selectedConfiguration, privateKey: fixtureKey, transport})};
}

test('environment selection stays disabled with distinct Base networks until explicitly configured', () => {
  const testConfig = configurationForEnvironment('test'), production = configurationForEnvironment('production');
  assert.equal(testConfig.chainId, 84532); assert.equal(production.chainId, 8453);
  assert.equal(testConfig.enabled, false); assert.equal(production.enabled, false);
  assert.equal(testConfig.rpcUrl, 'https://sepolia.base.org'); assert.equal(production.rpcUrl, 'https://mainnet.base.org');
  assert.throws(() => createStartChain({configuration: {...configuration, fromBlock: '0'}}), /positive first block/);
  assert.throws(() => createStartChain({configuration: {...configuration, chainId: 1}}), /Base/);
  assert.throws(() => createStartChain({configuration, privateKey: `0x${'22'.repeat(32)}`}), /signer/);
});

test('attestation binds immutable run identity and signs a non-revocable direct EAS transaction', async () => {
  const {chain} = fixture(); const prepared = await chain.prepareTransaction(start);
  assert.equal(prepared.transactionHash, keccak256(prepared.serializedTransaction));
  assert.equal((await recoverTransactionAddress({serializedTransaction: prepared.serializedTransaction})).toLowerCase(), signerAddress.toLowerCase());
  assert.equal(prepared.nonce, '7'); assert.equal(prepared.request.to, EAS_ADDRESS);
  const request = decodeFunctionData({abi: EAS_ABI, data: prepared.request.data});
  assert.equal(request.functionName, 'attest'); assert.equal(request.args[0].schema, SCHEMA_UID);
  assert.equal(request.args[0].data.revocable, false); assert.equal(request.args[0].data.expirationTime, 0n);
  assert.equal(request.args[0].data.recipient, zeroAddress); assert.equal(request.args[0].data.value, 0n);
  assert.deepEqual(decodeStartPayload(request.args[0].data.data), start);
  assert.equal(JSON.stringify(prepared).includes(fixtureKey), false);
});

test('schema setup uses the deterministic definition and a non-revocable zero resolver', async () => {
  const {chain} = fixture(); const prepared = await chain.prepareTransaction({kind: 'schema'});
  const decoded = decodeFunctionData({abi: SCHEMA_ABI, data: prepared.request.data});
  assert.equal(prepared.request.to, SCHEMA_REGISTRY_ADDRESS);
  assert.deepEqual(decoded.args, [SCHEMA, zeroAddress, false]);
  assert.equal(await chain.schema(), true);
});

test('a successful receipt includes verified start UID, exact sealed block and chain time', async () => {
  const {chain} = fixture(); const hash = `0x${'e'.repeat(64)}`;
  const receipt = await chain.receipt(hash);
  assert.equal(receipt.status, 'confirmed'); assert.equal(receipt.attestationUid, uid);
  assert.equal(receipt.blockNumber, '100'); assert.equal(receipt.blockHash, blockHash);
  assert.equal(receipt.chainTimestamp, 1000); assert.deepEqual(receipt.identity, start);
});

test('unknown and reverted transactions have distinct receipt states', async () => {
  assert.equal(await fixture({eth_getTransactionReceipt: () => null}).chain.receipt(uid), null);
  assert.equal((await fixture({eth_getTransactionReceipt: () => ({status: '0x0', transactionHash: uid, blockNumber: '0x64', blockHash})}).chain.receipt(uid)).status, 'failed');
});

test('network and schema mismatch stop signing before gas requests', async () => {
  const wrongNetwork = fixture({eth_chainId: () => '0x2105'});
  await assert.rejects(wrongNetwork.chain.prepareTransaction(start), {code: 'network_mismatch'});
  assert.equal(wrongNetwork.calls.some(call => call.method === 'eth_estimateGas'), false);
  const wrongSchema = fixture({eth_call: () => encodeFunctionResult({abi: SCHEMA_ABI, functionName: 'getSchema', result: {uid: SCHEMA_UID, resolver: zeroAddress, revocable: true, schema: SCHEMA}})});
  await assert.rejects(wrongSchema.chain.schema(), {code: 'schema_mismatch'});
});

test('a first block later than the sealed head stops Start before nonce allocation, gas estimation or signing', async () => {
  const h = fixture({}, {...configuration, fromBlock: '101'});
  await assert.rejects(h.chain.prepareTransaction(start), {code: 'first_block_ahead'});
  assert.equal(h.calls.some(call => ['eth_getTransactionCount', 'eth_estimateGas', 'eth_sendRawTransaction'].includes(call.method)), false);
  assert.ok(await h.chain.prepareTransaction({kind: 'schema'}));
});

test('a saved start receipt below the declared first block cannot acknowledge registration', async () => {
  const h = fixture({}, {...configuration, fromBlock: '101'});
  await assert.rejects(h.chain.receipt(uid), {code: 'first_block_ahead'});
});

test('reads spend the explicit budget once and transports do not retry failed RPC', async () => {
  const h = fixture({eth_getLogs: () => {throw new Error('sensitive-provider-error');}});
  let remaining = 1; const budget = {spend() {if (remaining-- <= 0) throw Object.assign(new Error('Budget'), {code: 'rpc_budget'});}};
  await assert.rejects(h.chain.logs('100', '599', budget), error => error.code === 'rpc_unavailable' && !error.message.includes('sensitive'));
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.chain.transactionCount('599', budget), {code: 'rpc_budget'});
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.chain.logs('100', '600'), {code: 'invalid_log_range'});
});
