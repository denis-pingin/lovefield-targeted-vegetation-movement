/** Select retained identity fields without buffering numerical JSON subtrees. */
export class ArtifactIdentityError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export async function selectArtifactIdentity(stream, paths, {maximumBytes = 2 * 1024 * 1024} = {}) {
  const projection = {}, stack = [{kind: 'root', path: [], state: 'value'}];
  let token = null, capture = null, selectedBytes = 0;
  const invalid = () => { throw new ArtifactIdentityError(409, 'artifact_invalid', 'A retained JSON artifact is invalid.'); };
  const tooLarge = () => { throw new ArtifactIdentityError(413, 'artifact_metadata_too_large', 'Retained artifact identity metadata exceeds the 2 MiB format bound.'); };
  const prefix = (left, right) => left.length <= right.length && left.every((part, index) => part === right[index]);
  function append(character) {
    if (!capture) return;
    const point = character.codePointAt(0);
    selectedBytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (selectedBytes > maximumBytes) tooLarge();
    capture.text += character;
  }
  function beginValue() {
    const parent = stack.at(-1);
    if (!['value', 'valueOrEnd'].includes(parent.state)) invalid();
    const path = parent.kind === 'object' ? [...parent.path, parent.key]
      : parent.kind === 'array' ? [...parent.path, parent.index] : [];
    if (!capture && paths.some(selected => path.length === selected.length && prefix(path, selected))) {
      capture = {path, depth: stack.length, text: ''};
    }
    return path;
  }
  function finishValue() {
    if (capture && capture.depth === stack.length) {
      let destination = projection;
      for (const part of capture.path.slice(0, -1)) destination = destination[part] ??= {};
      Object.defineProperty(destination, capture.path.at(-1), {value: JSON.parse(capture.text), enumerable: true, configurable: true, writable: true});
      capture = null;
    }
    const parent = stack.at(-1);
    if (!['value', 'valueOrEnd'].includes(parent.state)) invalid();
    parent.state = parent.kind === 'root' ? 'done' : 'commaOrEnd';
    if (parent.kind === 'array') parent.index++;
  }
  function endString() {
    if (token.key) {
      const parent = stack.at(-1), key = JSON.parse(token.text), path = [...parent.path, key];
      if (paths.some(selected => prefix(path, selected))) {
        if (parent.identityKeys.has(key)) throw new ArtifactIdentityError(409, 'artifact_invalid', 'A retained JSON artifact has a duplicate identity branch.');
        parent.identityKeys.add(key);
      }
      parent.key = key; parent.state = 'colon'; token = null;
    } else { token = null; finishValue(); }
  }
  function number(character) {
    const digit = character >= '0' && character <= '9', state = token.state;
    if (digit && ['minus', 'dot', 'exponent', 'sign'].includes(state)) token.state = state === 'minus' ? character === '0' ? 'zero' : 'integer' : state === 'dot' ? 'fraction' : 'exponentDigits';
    else if (digit && ['integer', 'fraction', 'exponentDigits'].includes(state)) { /* Continue the numeric token without retaining it. */ }
    else if (character === '.' && ['zero', 'integer'].includes(state)) token.state = 'dot';
    else if ((character === 'e' || character === 'E') && ['zero', 'integer', 'fraction'].includes(state)) token.state = 'exponent';
    else if ((character === '+' || character === '-') && state === 'exponent') token.state = 'sign';
    else {
      if (!['zero', 'integer', 'fraction', 'exponentDigits'].includes(state)) invalid();
      token = null; finishValue(); return false;
    }
    append(character); return true;
  }
  function consume(character) {
    if (token?.kind === 'string') {
      append(character);
      if (token.key) { token.text += character; if (token.text.length > 4096) tooLarge(); }
      if (token.unicode) {
        if (!/^[a-fA-F0-9]$/.test(character)) invalid(); token.unicode--; return;
      }
      if (token.escape) {
        token.escape = false;
        if (character === 'u') token.unicode = 4;
        else if (!'"\\/bfnrt'.includes(character)) invalid();
        return;
      }
      if (character === '\\') token.escape = true;
      else if (character === '"') endString();
      else if (character.codePointAt(0) < 32) invalid();
      return;
    }
    if (token?.kind === 'number' && number(character)) return;
    if (token?.kind === 'literal') {
      if (character !== token.expected[token.index++]) invalid(); append(character);
      if (token.index === token.expected.length) { token = null; finishValue(); }
      return;
    }
    const parent = stack.at(-1);
    if (' \r\n\t'.includes(character)) { append(character); return; }
    if (character === '"') {
      const key = parent.kind === 'object' && ['key', 'keyOrEnd'].includes(parent.state);
      if (!key) beginValue(); append(character);
      token = {kind: 'string', key, text: key ? '"' : '', escape: false, unicode: 0}; return;
    }
    if (character === '{' || character === '[') {
      const path = beginValue(); append(character);
      if (stack.length >= 64) tooLarge();
      stack.push(character === '{' ? {kind: 'object', path, state: 'keyOrEnd', identityKeys: new Set()}
        : {kind: 'array', path, state: 'valueOrEnd', index: 0}); return;
    }
    if (character === '}' || character === ']') {
      if (character === '}' ? parent.kind !== 'object' || !['keyOrEnd', 'commaOrEnd'].includes(parent.state)
        : parent.kind !== 'array' || !['valueOrEnd', 'commaOrEnd'].includes(parent.state)) invalid();
      append(character); stack.pop(); finishValue(); return;
    }
    if (character === ':') {
      if (parent.kind !== 'object' || parent.state !== 'colon') invalid(); append(character); parent.state = 'value'; return;
    }
    if (character === ',') {
      if (parent.state !== 'commaOrEnd' || parent.kind === 'root') invalid(); append(character);
      parent.state = parent.kind === 'object' ? 'key' : 'value'; return;
    }
    if (character === '-' || character >= '0' && character <= '9') {
      beginValue(); append(character);
      token = {kind: 'number', state: character === '-' ? 'minus' : character === '0' ? 'zero' : 'integer'}; return;
    }
    if ('tfn'.includes(character)) {
      beginValue(); append(character); token = {kind: 'literal', expected: {t: 'true', f: 'false', n: 'null'}[character], index: 1}; return;
    }
    invalid();
  }
  const decoder = new TextDecoder('utf-8', {fatal: true}), reader = stream.getReader();
  try {
    for (;;) {
      const {value, done} = await reader.read();
      let decoded;
      try { decoded = decoder.decode(value, {stream: !done}); } catch { invalid(); }
      for (const character of decoded) consume(character);
      if (done) break;
    }
    if (token?.kind === 'number') number(' ');
    if (token || stack.length !== 1 || stack[0].state !== 'done') invalid();
    return projection;
  } catch (error) {
    try { await reader.cancel(); } catch { console.warn('Retained artifact identity stream cancellation failed.'); }
    throw error;
  } finally { reader.releaseLock(); }
}
