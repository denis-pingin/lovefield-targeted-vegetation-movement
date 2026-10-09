export class AccessError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid JWT encoding.');
  const binary = atob(part.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function jsonPart(part) {
  return JSON.parse(new TextDecoder().decode(decodePart(part)));
}

function configuredTeamDomain(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A Cloudflare Access team domain is required.'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash ||
      !url.hostname.endsWith('.cloudflareaccess.com')) {
    throw new Error('Cloudflare Access team domain must be an HTTPS cloudflareaccess.com origin.');
  }
  return url.origin;
}

export function createAccessAuthenticator({teamDomain, audience, fetcher = fetch, clock = Date.now,
  logger = console, publisherAudience = null, publisherServiceIdentity = null} = {}) {
  const issuer = configuredTeamDomain(teamDomain);
  if (typeof audience !== 'string' || !audience) throw new Error('Cloudflare Access audience is required.');
  let cachedKeys = null;
  let keysExpireAtMs = 0;

  async function publicKeys(refresh = false) {
    if (!refresh && cachedKeys && clock() < keysExpireAtMs) return cachedKeys;
    try {
      const response = await fetcher(`${issuer}/cdn-cgi/access/certs`);
      if (!response.ok) throw new Error(`Signing-key endpoint returned HTTP ${response.status}.`);
      const document = await response.json();
      if (!Array.isArray(document.keys) || document.keys.length === 0) throw new Error('No Access signing keys returned.');
      cachedKeys = document.keys.filter(key => key.kty === 'RSA' && key.alg === 'RS256' &&
        typeof key.kid === 'string' && key.kid);
      if (cachedKeys.length === 0) throw new Error('No RS256 Access signing key returned.');
      keysExpireAtMs = clock() + 300000;
      return cachedKeys;
    } catch (error) {
      logger.warn('Cloudflare Access key retrieval failed for the Tree study; request denied.',
        error instanceof Error ? error.message : String(error));
      throw new AccessError('access_unavailable', 'Access signing keys are unavailable.', 503);
    }
  }

  return async function authenticate(request) {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new AccessError('access_missing', 'An Access sign-in is required.');
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid JWT format.');
      const header = jsonPart(parts[0]);
      const claims = jsonPart(parts[1]);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid JWT algorithm or key.');
      let keys = await publicKeys();
      let signingKey = keys.find(key => key.kid === header.kid);
      if (!signingKey) {
        keys = await publicKeys(true);
        signingKey = keys.find(key => key.kid === header.kid);
      }
      if (!signingKey) throw new Error('Unknown Access signing key.');
      const imported = await crypto.subtle.importKey('jwk', signingKey,
        {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported,
        decodePart(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      if (!valid) throw new Error('Invalid Access signature.');
      const seconds = Math.floor(clock() / 1000);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== issuer ||
          !Number.isInteger(claims.exp) || claims.exp <= seconds ||
          claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds)) {
        throw new Error('Access token claims are invalid.');
      }
      if (claims.sub === '') {
        if (!publisherAudience || !publisherServiceIdentity || !audiences.includes(publisherAudience) ||
            claims.common_name !== publisherServiceIdentity || claims.type !== 'app') throw new Error('Invalid publisher identity.');
        return {id: 'tree-publication-service', role: 'publisher'};
      }
      if (typeof claims.sub !== 'string' || !claims.sub || !audiences.includes(audience) || claims.common_name) throw new Error('Invalid operator identity.');
      return {id: claims.sub, role: 'operator', email: typeof claims.email === 'string' ? claims.email : null};
    } catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError('access_invalid', 'Access sign-in is invalid or expired.');
    }
  };
}
