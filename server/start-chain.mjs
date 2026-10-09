import {createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult, decodeEventLog,
  encodeAbiParameters, decodeAbiParameters, encodePacked, keccak256, zeroAddress, zeroHash, toHex, isAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import environmentConfiguration from '../start-registry.config.json' with {type: 'json'};

export const EAS_ADDRESS = '0x4200000000000000000000000000000000000021';
export const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020';
export const SCHEMA = 'string study,string seriesId,string runId,bytes32 configHash,string sourceCheckpoint';
export const SCHEMA_UID = keccak256(encodePacked(['string', 'address', 'bool'], [SCHEMA, zeroAddress, false]));
// Minimal official interfaces: https://github.com/ethereum-attestation-service/eas-contracts/blob/master/contracts/IEAS.sol
// Struct layout: https://github.com/ethereum-attestation-service/eas-contracts/blob/master/contracts/Common.sol
export const EAS_ABI = parseAbi([
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  'function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data) request) payable returns (bytes32)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))',
]);
// https://github.com/ethereum-attestation-service/eas-contracts/blob/master/contracts/ISchemaRegistry.sol
export const SCHEMA_ABI = parseAbi([
  'function register(string schema, address resolver, bool revocable) returns (bytes32)',
  'function getSchema(bytes32 uid) view returns ((bytes32 uid, address resolver, bool revocable, string schema))',
]);
const payloadTypes = [{type: 'string'}, {type: 'string'}, {type: 'string'}, {type: 'bytes32'}, {type: 'string'}];
const equalAddress = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const decimal = value => String(BigInt(value));

export function registryError(code, message, status = 503) { return Object.assign(new Error(message), {code, status}); }

export function configurationForEnvironment(environment, configurations = environmentConfiguration) {
  if (!['test', 'production'].includes(environment)) throw registryError('registry_configuration', 'Select Test or Production for the start registry.');
  const result = {...configurations[environment]};
  const expected = environment === 'test' ? 84532 : 8453;
  if (result.chainId !== expected) throw registryError('registry_configuration', 'The registry network differs from the selected environment.');
  if (result.enabled && configurations.test.signerAddress && configurations.production.signerAddress &&
      equalAddress(configurations.test.signerAddress, configurations.production.signerAddress)) {
    throw registryError('registry_configuration', 'Test and Production require different dedicated signers.');
  }
  return result;
}

export function validateRegistryConfiguration(configuration) {
  if (!configuration || ![84532, 8453].includes(configuration.chainId)) throw registryError('registry_configuration', 'The registry requires a Base network.');
  if (typeof configuration.rpcUrl !== 'string' || !URL.canParse(configuration.rpcUrl) || new URL(configuration.rpcUrl).protocol !== 'https:' ||
      new URL(configuration.rpcUrl).username || new URL(configuration.rpcUrl).password || new URL(configuration.rpcUrl).search || new URL(configuration.rpcUrl).hash) {
    throw registryError('registry_configuration', 'The registry requires a public HTTPS RPC URL without credentials.');
  }
  if (!isAddress(configuration.signerAddress) || equalAddress(configuration.signerAddress, zeroAddress)) throw registryError('registry_configuration', 'Configure the dedicated public signer address.');
  if (!/^[1-9]\d*$/.test(String(configuration.fromBlock))) throw registryError('registry_configuration', 'Configure a positive first block before registering starts.');
  if (configuration.maxLogBlockRange != null && (!Number.isSafeInteger(configuration.maxLogBlockRange) || configuration.maxLogBlockRange < 1 || configuration.maxLogBlockRange > 500)) {
    throw registryError('registry_configuration', 'The log range must be between 1 and 500 blocks.');
  }
  return {...configuration, fromBlock: decimal(configuration.fromBlock)};
}

export function validateStartIdentity(value) {
  if (value?.study !== 'tree-targeting' || !['seriesId', 'runId'].every(key => typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value[key])) ||
      !/^0x[a-f0-9]{64}$/i.test(value.configHash) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sourceCheckpoint)) {
    throw registryError('start_identity_invalid', 'A start requires the fixed study, series, run, configuration hash and source checkpoint.', 400);
  }
  return Object.fromEntries(['study', 'seriesId', 'runId', 'configHash', 'sourceCheckpoint'].map(key => [key, value[key]]));
}
export function encodeStartPayload(value) {
  const identity = validateStartIdentity(value);
  return encodeAbiParameters(payloadTypes, Object.values(identity));
}
export function decodeStartPayload(data) {
  try {
    const [study, seriesId, runId, configHash, sourceCheckpoint] = decodeAbiParameters(payloadTypes, data);
    return validateStartIdentity({study, seriesId, runId, configHash, sourceCheckpoint});
  } catch { throw registryError('attestation_invalid', 'The attestation payload does not match this study registry.'); }
}

export function createStartChain({configuration, privateKey = null, transport = null} = {}) {
  configuration = validateRegistryConfiguration(configuration);
  let account = null;
  if (privateKey) {
    try { account = privateKeyToAccount(privateKey); }
    catch { throw registryError('signer_invalid', 'The Worker signing secret is invalid.'); }
    if (!equalAddress(account.address, configuration.signerAddress)) throw registryError('signer_mismatch', 'The Worker key differs from the configured dedicated signer.');
  }
  const client = createPublicClient({cacheTime: 0, transport: transport ?? http(configuration.rpcUrl, {retryCount: 0, timeout: 10000})});
  async function rpc(method, params, budget) {
    budget?.spend();
    try { return await client.request({method, params}, {retryCount: 0}); }
    catch { throw registryError('rpc_unavailable', 'The registry RPC request failed; retained progress is unchanged.'); }
  }
  async function validateNetwork(budget) {
    if (Number(BigInt(await rpc('eth_chainId', [], budget))) !== configuration.chainId) throw registryError('network_mismatch', 'The RPC network differs from the configured Base network.');
    return true;
  }
  async function schema(budget) {
    const data = encodeFunctionData({abi: SCHEMA_ABI, functionName: 'getSchema', args: [SCHEMA_UID]});
    const raw = await rpc('eth_call', [{to: SCHEMA_REGISTRY_ADDRESS, data}, 'latest'], budget);
    let record;
    try { record = decodeFunctionResult({abi: SCHEMA_ABI, functionName: 'getSchema', data: raw}); }
    catch { throw registryError('schema_mismatch', 'The EAS schema definition could not be verified.'); }
    if (record.uid === zeroHash) return false;
    if (record.uid !== SCHEMA_UID || record.schema !== SCHEMA || !equalAddress(record.resolver, zeroAddress) || record.revocable) {
      throw registryError('schema_mismatch', 'The EAS schema differs from the fixed non-revocable definition.');
    }
    return true;
  }
  async function attestation(uid, budget, block = 'latest') {
    const data = encodeFunctionData({abi: EAS_ABI, functionName: 'getAttestation', args: [uid]});
    const raw = await rpc('eth_call', [{to: EAS_ADDRESS, data}, block === 'latest' ? block : toHex(BigInt(block))], budget);
    let record;
    try { record = decodeFunctionResult({abi: EAS_ABI, functionName: 'getAttestation', data: raw}); }
    catch { throw registryError('attestation_invalid', 'The start attestation could not be decoded.'); }
    if (record.uid !== uid || record.schema !== SCHEMA_UID || !equalAddress(record.attester, configuration.signerAddress) ||
        record.revocable || record.expirationTime !== 0n || record.revocationTime !== 0n || record.refUID !== zeroHash || !equalAddress(record.recipient, zeroAddress)) {
      throw registryError('attestation_invalid', 'The attestation differs from the dedicated non-revocable start contract.');
    }
    return {attestationUid: uid, schemaUid: SCHEMA_UID, identity: decodeStartPayload(record.data), chainTimestamp: Number(record.time)};
  }
  function decodeLog(log) {
    if (!equalAddress(log.address, EAS_ADDRESS) || log.removed) throw registryError('attestation_invalid', 'An inconsistent registry log was returned.');
    let args;
    try { args = decodeEventLog({abi: EAS_ABI, eventName: 'Attested', topics: log.topics, data: log.data, strict: true}).args; }
    catch { throw registryError('attestation_invalid', 'An EAS start log could not be decoded.'); }
    if (!equalAddress(args.attester, configuration.signerAddress) || args.schemaUID !== SCHEMA_UID || !equalAddress(args.recipient, zeroAddress)) throw registryError('attestation_invalid', 'An EAS log differs from the configured registry.');
    return {attestationUid: args.uid, transactionHash: log.transactionHash, blockNumber: decimal(log.blockNumber), blockHash: log.blockHash, logIndex: decimal(log.logIndex)};
  }
  return {
    validateNetwork, schema, attestation,
    readiness: () => ({configured: true, signingAvailable: Boolean(account), fundingAddress: configuration.signerAddress, chainId: configuration.chainId, schemaUid: SCHEMA_UID}),
    async prepareTransaction(start) {
      if (!account) throw registryError('signer_missing', 'The dedicated Worker signing secret is not configured.');
      await validateNetwork();
      const setup = start.kind === 'schema';
      if (!setup && !await schema()) throw registryError('schema_missing', 'Register and verify the fixed EAS schema before a scored start.');
      if (!setup) {
        const head = await rpc('eth_getBlockByNumber', ['latest', false]);
        if (!head || BigInt(head.number) < BigInt(configuration.fromBlock)) throw registryError('first_block_ahead', 'The configured first block is later than the sealed chain head. Select a block at or before the first scored Start.');
      }
      const to = setup ? SCHEMA_REGISTRY_ADDRESS : EAS_ADDRESS;
      const data = setup ? encodeFunctionData({abi: SCHEMA_ABI, functionName: 'register', args: [SCHEMA, zeroAddress, false]}) :
        encodeFunctionData({abi: EAS_ABI, functionName: 'attest', args: [{schema: SCHEMA_UID, data: {recipient: zeroAddress, expirationTime: 0n, revocable: false, refUID: zeroHash, data: encodeStartPayload(start), value: 0n}}]});
      const nonce = BigInt(await rpc('eth_getTransactionCount', [account.address, 'pending']));
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw registryError('nonce_invalid', 'The signer nonce exceeds the supported range.');
      const gasPrice = BigInt(await rpc('eth_gasPrice', []));
      const gas = BigInt(await rpc('eth_estimateGas', [{from: account.address, to, data, value: '0x0', nonce: toHex(nonce)}]));
      const serializedTransaction = await account.signTransaction({chainId: configuration.chainId, type: 'legacy', to, data, value: 0n, gas: gas * 12n / 10n, gasPrice, nonce: Number(nonce)});
      return {serializedTransaction, transactionHash: keccak256(serializedTransaction), nonce: String(nonce), kind: setup ? 'schema' : 'start', request: {to, data}};
    },
    async broadcast(serializedTransaction) {
      const hash = await rpc('eth_sendRawTransaction', [serializedTransaction]);
      if (hash !== keccak256(serializedTransaction)) throw registryError('broadcast_uncertain', 'The RPC reply did not identify the saved transaction.');
      return hash;
    },
    async receipt(transactionHash, {kind = 'start', budget} = {}) {
      const record = await rpc('eth_getTransactionReceipt', [transactionHash], budget);
      if (!record) return null;
      if (record.transactionHash !== transactionHash) throw registryError('receipt_inconsistent', 'The receipt does not match the saved transaction.');
      const base = {transactionHash, blockNumber: decimal(record.blockNumber), blockHash: record.blockHash};
      if (record.status === '0x0') return {status: 'failed', ...base, error: {code: 'transaction_reverted', message: 'The saved registry transaction reverted.'}};
      if (kind === 'start' && BigInt(base.blockNumber) < BigInt(configuration.fromBlock)) throw registryError('first_block_ahead', 'The saved start receipt precedes the configured first block.');
      if (record.status !== '0x1' || !equalAddress(record.from, configuration.signerAddress) || !equalAddress(record.to, kind === 'schema' ? SCHEMA_REGISTRY_ADDRESS : EAS_ADDRESS)) throw registryError('receipt_inconsistent', 'The receipt does not match the dedicated registry transaction.');
      const block = await rpc('eth_getBlockByHash', [record.blockHash, false], budget);
      if (!block || block.hash !== record.blockHash || decimal(block.number) !== base.blockNumber) throw registryError('receipt_inconsistent', 'The receipt block is not available or differs.');
      if (kind === 'schema') {
        if (!await schema(budget)) throw registryError('schema_missing', 'The schema setup receipt has no verified schema.');
        return {status: 'confirmed', ...base, chainTimestamp: Number(BigInt(block.timestamp)), schemaUid: SCHEMA_UID};
      }
      const matching = record.logs.filter(log => equalAddress(log.address, EAS_ADDRESS));
      if (matching.length !== 1) throw registryError('receipt_inconsistent', 'The start receipt must contain one EAS attestation.');
      const decoded = decodeLog(matching[0]);
      if (decoded.blockHash !== base.blockHash || decoded.blockNumber !== base.blockNumber || decoded.transactionHash !== transactionHash) throw registryError('receipt_inconsistent', 'The start log differs from its receipt.');
      const verified = await attestation(decoded.attestationUid, budget, base.blockNumber);
      if (verified.chainTimestamp !== Number(BigInt(block.timestamp))) throw registryError('receipt_inconsistent', 'The attestation time differs from its sealed block.');
      return {status: 'confirmed', ...base, ...verified};
    },
    async finalizedBlock(budget) {
      const block = await rpc('eth_getBlockByNumber', ['finalized', false], budget);
      if (!block) throw registryError('finalized_unavailable', 'The finalized registry boundary is unavailable.');
      return {number: decimal(block.number), hash: block.hash, timestamp: Number(BigInt(block.timestamp))};
    },
    async transactionCount(block, budget) {
      return decimal(await rpc('eth_getTransactionCount', [configuration.signerAddress, toHex(BigInt(block))], budget));
    },
    async logs(fromBlock, toBlock, budget) {
      const from = BigInt(fromBlock), to = BigInt(toBlock);
      if (from < BigInt(configuration.fromBlock) || to < from || to - from + 1n > BigInt(configuration.maxLogBlockRange ?? 500)) throw registryError('invalid_log_range', 'Registry log requests require at most 500 blocks within the declared first block.');
      const eventTopic = keccak256(new TextEncoder().encode('Attested(address,address,bytes32,bytes32)'));
      const signerTopic = `0x${configuration.signerAddress.slice(2).toLowerCase().padStart(64, '0')}`;
      const logs = await rpc('eth_getLogs', [{address: EAS_ADDRESS, topics: [eventTopic, null, signerTopic, SCHEMA_UID], fromBlock: toHex(from), toBlock: toHex(to)}], budget);
      return logs.map(decodeLog);
    },
  };
}
