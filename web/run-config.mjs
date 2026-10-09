const experimentSlug = 'tree-targeting';
export const EXPERIMENT = Object.freeze({
  slug: experimentSlug,
  path: `/${experimentSlug}/`,
  apiPath: `/${experimentSlug}/api/`,
  basePath: `/${experimentSlug}/`,
  apiBasePath: `/${experimentSlug}/api/`,
});

const VERSION = 'tree-targeting-3';
const MODES = new Set(['tree']);
const PURPOSES = new Set(['preparation', 'scored']);

export function defaultConfig(mode, purpose = 'preparation') {
  if (!MODES.has(mode)) throw new Error('Only Tree mode belongs to this study.');
  if (!PURPOSES.has(purpose)) throw new Error('Choose preparation or scored purpose.');
  return {
    version: VERSION,
    experimentSlug,
    mode,
    purpose,
    tree: {
      preRollSeconds: 30,
      responseSeconds: 15,
      recoverySeconds: 0,
      postRollSeconds: 30,
      announceRelease: false,
      count: 16,
    },
    siteId: null,
    setupId: null,
    seriesId: null,
    analysisProfileId: 'tree-development-1',
  };
}

function object(value, name, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${name}.${key} is not a field setting.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${name}.${key} is required.`);
  }
}

function seconds(value, name, allowZero = false) {
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER / 1000 || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a nonnegative' : 'a positive'} finite number of seconds.`);
  }
}

function count(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a nonnegative' : 'a positive'} whole number.`);
  }
}

function choices(value, name) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${name} needs two duration choices.`);
  for (const duration of value) seconds(duration, name);
  if (value[0] === value[1]) throw new Error(`${name} choices must be distinct.`);
}

function optionalId(value, name) {
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`${name} must be a nonempty identifier or null.`);
  }
}

function release(value, recoverySeconds, name) {
  if (typeof value !== 'boolean') throw new Error(`${name}.announceRelease must be true or false.`);
  if (value && recoverySeconds === 0) throw new Error(`${name} release announcement requires positive recovery.`);
}

export function validateConfig(config) {
  config = structuredClone(config);
  object(config, 'configuration', [
    'version', 'experimentSlug', 'mode', 'purpose', 'tree',
    'siteId', 'setupId', 'seriesId', 'analysisProfileId',
  ]);
  if (config.version !== VERSION) throw new Error('Unsupported Tree configuration version.');
  if (config.experimentSlug !== experimentSlug) throw new Error('Configuration belongs to another experiment.');
  if (!MODES.has(config.mode)) throw new Error('Only Tree mode belongs to this study.');
  if (!PURPOSES.has(config.purpose)) throw new Error('Choose preparation or scored purpose.');

  config.tree.preRollSeconds ??= 30;
  config.tree.postRollSeconds ??= 30;
  object(config.tree, 'tree', ['preRollSeconds', 'responseSeconds', 'recoverySeconds', 'postRollSeconds', 'announceRelease', 'count']);
  seconds(config.tree.preRollSeconds, 'tree preRollSeconds');
  seconds(config.tree.responseSeconds, 'tree responseSeconds');
  seconds(config.tree.recoverySeconds, 'tree recoverySeconds', true);
  seconds(config.tree.postRollSeconds, 'tree postRollSeconds');
  release(config.tree.announceRelease, config.tree.recoverySeconds, 'tree');
  count(config.tree.count, 'tree count');

  for (const name of ['siteId', 'setupId', 'seriesId']) optionalId(config[name], name);
  if (typeof config.analysisProfileId !== 'string' || !config.analysisProfileId.trim()) {
    throw new Error('An analysis profile identifier is required.');
  }

  return structuredClone(config);
}

export function copyForRepeat(config, changes) {
  const next = structuredClone(config);
  for (const [name, value] of Object.entries(changes)) {
    next[name] = structuredClone(value);
  }
  return validateConfig(next);
}
