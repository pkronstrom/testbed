/**
 * Design state encoding (spec §11).
 *
 *     JSON -> deflate-raw (native CompressionStream) -> base64url
 *
 * One payload, three carriers: the URL hash (`#d=<payload>`), a custom key in
 * the PDF Info dictionary, and a QR code on the cover sheet. All three round
 * trip through the two functions here.
 *
 * CompressionStream is native in browsers and in Node >= 18, so this needs no
 * library -- but it is stream-based, hence async. Callers must await.
 *
 * Unknown fields survive the round trip: the payload is the whole params
 * object, so a payload written by a later schema version keeps its extra keys
 * when an older build reads it. The single exception is `derived`, which is
 * recomputed output, never input -- storing it would bloat the hash and let a
 * stale copy contradict the parameters that produced it.
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

  /** Highest schemaVersion this build understands. */
  const SCHEMA_VERSION = 1;

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  async function pipe(bytes, stream) {
    const writer = stream.writable.getWriter();
    // On a corrupt payload the writable side rejects too. Its rejection must
    // be settled here or it surfaces as an unhandled rejection and takes the
    // process down instead of reaching the caller's try/catch. The readable
    // side carries the error we actually want to report.
    const written = writer.write(bytes)
      .then(() => writer.close())
      .catch(() => {});
    try {
      const buf = await new Response(stream.readable).arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      await written;
    }
  }

  function bytesToBase64url(bytes) {
    let bin = '';
    // Chunked so a large payload never blows the argument limit.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64urlToBytes(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Params minus the recomputed `derived` block. */
  function payloadOf(params) {
    const copy = Object.assign({}, params);
    delete copy.derived;
    return copy;
  }

  /** @returns {Promise<string>} base64url payload for a URL hash or QR code. */
  async function encode(params) {
    const json = JSON.stringify(payloadOf(params));
    const packed = await pipe(textEncoder.encode(json), new CompressionStream('deflate-raw'));
    return bytesToBase64url(packed);
  }

  /** @returns {Promise<object>} the params object, unknown fields intact. */
  async function decode(payload) {
    if (typeof payload !== 'string' || !payload.length) {
      throw new Error('decode: empty payload');
    }
    let bytes;
    try {
      bytes = await pipe(base64urlToBytes(payload), new DecompressionStream('deflate-raw'));
    } catch (e) {
      throw new Error('decode: payload is not a valid design (corrupt or truncated)');
    }
    const obj = JSON.parse(textDecoder.decode(bytes));
    return migrate(obj);
  }

  /**
   * Schema migration (§11). v1 is the only schema so far, so this only
   * version-stamps and refuses payloads from the future -- the real migration
   * harness gets written alongside schema v2, not speculatively before it.
   */
  function migrate(obj) {
    const v = obj.schemaVersion;
    if (v == null) {
      // Pre-versioning payloads never shipped; treat as v1 rather than reject.
      obj.schemaVersion = SCHEMA_VERSION;
      return obj;
    }
    if (v > SCHEMA_VERSION) {
      throw new Error(`decode: design uses schema version ${v}, this build understands ${SCHEMA_VERSION}. Update the app.`);
    }
    return obj;
  }

  /** Read a design payload out of a URL hash, or null if there isn't one. */
  function payloadFromHash(hash) {
    const m = /(?:^#|&)d=([A-Za-z0-9\-_]+)/.exec(hash || '');
    return m ? m[1] : null;
  }

  const api = {
    SCHEMA_VERSION, encode, decode, migrate, payloadOf, payloadFromHash,
    bytesToBase64url, base64urlToBytes,
  };

  P.encode = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
