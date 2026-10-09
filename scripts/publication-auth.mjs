import {access, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const PUBLICATION_CREDENTIAL_SELECTORS = Object.freeze(Object.fromEntries(['test', 'production'].map(environment => [environment, Object.freeze({
  clientId: Object.freeze({service: `lovefield-tree-publication-${environment}-client-id`, account: 'denis'}),
  clientSecret: Object.freeze({service: `lovefield-tree-publication-${environment}-client-secret`, account: 'denis'})
})])));

class CredentialError extends Error { safe = true; }

export async function loadProjectKeychainHelper({searchPath = process.env.PATH ?? ''} = {}) {
  for (const directory of searchPath.split(':').filter(Boolean)) {
    const executable = join(directory, 'lovefield-keychain');
    try { await access(executable, constants.X_OK); }
    catch (error) { if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) continue; throw new CredentialError('The installed lovefield-keychain helper could not be resolved.'); }
    try {
      const helper = await import(pathToFileURL(await realpath(executable)).href);
      if (typeof helper.createMacOSKeychain !== 'function') throw new Error('Incompatible helper');
      return helper;
    } catch { throw new CredentialError('The installed lovefield-keychain helper is unavailable or incompatible.'); }
  }
  throw new CredentialError('The installed lovefield-keychain helper is unavailable.');
}

export function publicationCredentialReader({source = 'keychain', loadHelper = loadProjectKeychainHelper, environmentVariables = process.env} = {}) {
  if (!['keychain', 'environment'].includes(source)) throw new CredentialError('Select keychain or environment as the explicit publication credential source.');
  return async environment => {
    const selectors = PUBLICATION_CREDENTIAL_SELECTORS[environment];
    if (!selectors) throw new CredentialError('Choose the Test or Production publication environment.');
    if (source === 'environment') {
      const clientId = environmentVariables.CF_ACCESS_CLIENT_ID, clientSecret = environmentVariables.CF_ACCESS_CLIENT_SECRET;
      if (!clientId || !clientSecret || /[\r\n\0]/.test(clientId + clientSecret)) throw new CredentialError('Explicit publication credentials require CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET process variables.');
      return {clientId, clientSecret};
    }
    const helper = await loadHelper(), reader = helper.createMacOSKeychain();
    const credentials = {};
    for (const [name, {service, account}] of Object.entries(selectors)) {
      try {
        const value = await reader.read(service, account);
        if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error('Unavailable credential');
        credentials[name] = value;
      } catch { throw new CredentialError(`Required Keychain item is unavailable: ${service} for account ${account}.`); }
    }
    return credentials;
  };
}
