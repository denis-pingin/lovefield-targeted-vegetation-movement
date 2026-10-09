import {MemoryStorage} from './service-fixtures.mjs';
import {SCHEMA_UID} from '../../server/start-chain.mjs';
export const registryConfiguration = {enabled: true, chainId: 84532, rpcUrl: 'https://rpc.example.test', signerAddress: '0x1234567890123456789012345678901234567890', fromBlock: '100'};
export const startIdentity = {study: 'tree-targeting', seriesId: 'series-one', runId: 'run-one', configHash: `0x${'c'.repeat(64)}`, sourceCheckpoint: 'd'.repeat(40)};
export const fixtureHash = number => `0x${number.toString(16).padStart(64, '0')}`;
export function registryFixture() {
  const storage = new MemoryStorage(), prepared = [], broadcasts = [], calls = [], warnings = [], receipts = new Map(), attestations = new Map();
  let now = 1000, schemaExists = true;
  function spend(method, budget) {budget?.spend(); calls.push(method);}
  const chain = {
    readiness: () => ({configured: true, signingAvailable: true, fundingAddress: registryConfiguration.signerAddress}),
    async validateNetwork(budget) {spend('network', budget); return true;},
    async schema(budget) {spend('schema', budget); return schemaExists;},
    async prepareTransaction(identity) {
      const number = prepared.length + 1;
      const result = {kind: identity.kind ?? 'start', serializedTransaction: 'synthetic-signed-' + number,
        transactionHash: fixtureHash(number), nonce: String(number - 1), request: {to: 'fixture', data: 'fixture'}};
      prepared.push({identity, result}); return result;
    },
    async broadcast(bytes) {broadcasts.push(bytes); return prepared.find(item => item.result.serializedTransaction === bytes).result.transactionHash;},
    async receipt(hash, {budget} = {}) {
      spend('receipt', budget);
      const item = receipts.get(hash);
      if (item?.status === 'confirmed') schemaExists = true;
      return item ?? null;
    },
    async finalizedBlock(budget) {spend('head', budget); return {number: '1000', timestamp: 1000};},
    async transactionCount(block, budget) {spend('nonce', budget); return '0';},
    async logs(from, to, budget) {spend('logs', budget); return [];},
    async attestation(uid, budget) {spend('attestation', budget); return attestations.get(uid);},
  };
  const options = {storage, chain, configuration: registryConfiguration, clock: () => now, logger: {warn: (...args) => warnings.push(args)}};
  return {options, storage, chain, prepared, broadcasts, receipts, attestations, calls, warnings, setTime: value => {now = value;}, setSchema: value => {schemaExists = value;},
    confirmed(hash, identity = startIdentity, blockNumber = '100') {return {status: 'confirmed', identity, transactionHash: hash, attestationUid: fixtureHash(500 + Number(BigInt(hash))), schemaUid: SCHEMA_UID, blockNumber, blockHash: fixtureHash(Number(blockNumber)), chainTimestamp: 1000};}};
}
