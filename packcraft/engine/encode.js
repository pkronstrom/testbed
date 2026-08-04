/**
 * engine/encode.js -- the permalink codec. THE DOCUMENT, AND NOTHING ELSE.
 *
 *     doc -> quantise -> JSON -> gzip -> base64url -> "#d=..."
 *
 * ---------------------------------------------------------------------------
 * WHY THE DOCUMENT ONLY (plan v3 amendment)
 *
 * The old app encoded `params` -- the generator's INPUT -- and rebuilt the boat
 * by re-running the derive chain, so a link was only as stable as the chain
 * that read it. Here the weld document IS the boat: nine numbers a weld plus a
 * floor block, and every panel is derived from them. So the link carries the
 * document and nothing else. Panels, the ring, the labels and the checks are
 * all recomputed on arrival; storing any of them would let a stale copy
 * contradict the welds that produced it.
 *
 * A template is not carried either -- `templates.js` emits documents, and once
 * emitted a document has no memory of which generator made it. That is the
 * point of "generators emit documents, the engine consumes documents".
 *
 * ---------------------------------------------------------------------------
 * QUANTISATION, AND WHY IT IS NOT LOSSY IN ANY WAY THAT EXISTS
 *
 * A double stringifies as up to 17 significant digits, and a weld carries
 * eleven of them. Quantising first is the whole compression story: `212.1` is
 * four characters where `212.13203435596427` is eighteen, and gzip then has a
 * far shorter, far more repetitive string to work on.
 *
 * The steps come from the fabric floor (plan, "Tolerance philosophy"), not from
 * taste. Nothing below ~1 mm exists in fabric: home-printer scale is
 * +-0.1-0.5%, taping +-0.5-1 mm a joint, tracing +-1-2 mm, scissors +-1-2 mm.
 *
 *   LINEAR_STEP  0.1 mm    -- 10x below the finest thing a builder can hold,
 *                             and the plan's own number.
 *   ANGLE_STEP   1e-4 rad  -- at the largest semi-axis any shipped template
 *                             carries (~420 mm at the diy7 stern tip) that is
 *                             0.042 mm of arc. Deliberately not 1e-3, which
 *                             would be 0.42 mm and visible.
 *   UNIT_STEP    1e-6      -- weld normals are unit vectors, so their step is
 *                             dimensionless; 1e-6 is ~1.7e-6 rad, i.e. 7e-4 mm
 *                             at that same 420 mm. Free, and it keeps the
 *                             normal out of the round-trip error budget where
 *                             the two visible steps above already sit.
 *   PROFILE_STEP 1e-4      -- profile coefficients are DIMENSIONLESS radial
 *                             ratios (engine/doc.js header), so one step serves
 *                             every boat: at the same 420 mm semi-axis it is
 *                             0.042 mm of radius, matching ANGLE_STEP's budget
 *                             exactly, and at a 150 mm tube it is 0.015 mm.
 *                             This is why the profile is stored as a ratio and
 *                             not as control points in mm -- a mm step would
 *                             have to be chosen for the largest boat and would
 *                             be wasteful on every other one.
 *
 * The round-trip gate is measured, not asserted by hand-waving:
 * tests/engine-export.test.js walks every weld ellipse of every library
 * template at 256 stations and records the worst displacement.
 *
 * ---------------------------------------------------------------------------
 * BOTH RUNTIMES, ONE CODE PATH
 *
 * `CompressionStream` is native in browsers and in Node >= 18, and it is the
 * only compressor a file:// page can have. It is stream-based, hence async,
 * hence `encode`/`decode` return promises -- callers must await. Where it is
 * missing (older Node, a worker without the API) the codec falls back to
 * `zlib`, which is a Node builtin and therefore never a dependency.
 *
 * Both paths are exported separately rather than hidden, because a fallback
 * nobody can run is a fallback nobody has tested: the suite drives `viaZlib`
 * explicitly even on a Node that would have used the stream.
 *
 * base64url is hand-rolled from a table rather than borrowed from `btoa` or
 * `Buffer`. Twenty lines, no environment sniffing, byte-identical in both
 * runtimes -- which matters because the payload is compared for equality in
 * tests and pasted between machines by users.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') { require('./doc.js'); }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const D = E.doc;

  /** Quantisation steps. See the header before changing one. */
  const LINEAR_STEP = 0.1;      // mm
  const ANGLE_STEP = 1e-4;      // rad
  const UNIT_STEP = 1e-6;       // dimensionless (weld normals)
  const DEG_STEP = 1e-3;        // degrees (floor.clockAngle, floor.wrapMaxAngle)
  const PROFILE_STEP = 1e-4;    // dimensionless (weld profile coefficients)

  /**
   * Round to a step and come back as a SHORT double.
   *
   * `Math.round(v / step) * step` is the whole trick: the result is the nearest
   * multiple of the step, and JS stringifies a double as its shortest
   * round-tripping decimal, so 212.1 prints as "212.1" and not as
   * "212.09999999999999" -- which is what a naive `toFixed` + `parseFloat`
   * dance is usually written to avoid. Nothing else is needed.
   *
   * The `+ 0` normalises -0 to 0: a mirrored centre component can land on the
   * negative zero, which JSON writes as "0" anyway but which compares unequal
   * to 0 under Object.is and so would make a byte-stability test lie.
   */
  function q(v, step) {
    return Math.round(v / step) * step + 0;
  }

  const qLin = (v) => q(v, LINEAR_STEP);
  const qAng = (v) => q(v, ANGLE_STEP);
  const qUnit = (v) => q(v, UNIT_STEP);
  const qProf = (v) => q(v, PROFILE_STEP);

  /**
   * The document with every number on its quantisation grid.
   *
   * Returns a PLAIN doc-shaped object, deliberately not run through
   * `doc.create`: create re-normalises the weld normal, which would undo the
   * quantisation of the very field it was applied to and put the long digits
   * straight back into the payload. Normalisation belongs on the DECODE side,
   * where it is exactly right -- the normal that comes back is unit to a part
   * in 1e-16 rather than to a part in 1e-6.
   */
  function quantize(doc) {
    return {
      schema: doc.schema,
      nextId: doc.nextId,
      mirror: doc.mirror,
      welds: doc.welds.map((w) => ({
        id: w.id,
        c: w.c.map(qLin),
        n: w.n.map(qUnit),
        a: qLin(w.a),
        b: qLin(w.b),
        roll: qAng(w.roll),
        seam: qAng(w.seam),
        onCentreplane: w.onCentreplane,
        profile: w.profile ? { k: w.profile.k.map(qProf) } : null,
      })),
      floor: {
        clockAngle: q(doc.floor.clockAngle, DEG_STEP),
        tabWidth: qLin(doc.floor.tabWidth),
        wrapMaxAngle: q(doc.floor.wrapMaxAngle, DEG_STEP),
      },
      locks: {
        uniformB: doc.locks.uniformB,
        mirror: doc.locks.mirror,
        pairs: doc.locks.pairs,
      },
      meta: { name: doc.meta.name, note: doc.meta.note },
    };
  }

  /** The exact string that gets compressed. Stable: same doc, same bytes. */
  function payloadJSON(doc) {
    return D.toJSON(quantize(doc));
  }

  // ------------------------------------------------------------------
  // base64url, from a table
  // ------------------------------------------------------------------

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const B64INV = (() => {
    const m = new Int16Array(256).fill(-1);
    for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i;
    // Accept standard base64 too, so a payload that went through a mailer that
    // "helpfully" re-encoded it still opens.
    m['+'.charCodeAt(0)] = 62; m['/'.charCodeAt(0)] = 63;
    return m;
  })();

  function bytesToBase64url(bytes) {
    let s = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
      const v = bytes[i] << 16;
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
    } else if (rest === 2) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63];
    }
    return s;   // unpadded: '=' has to be escaped in a URL and carries nothing
  }

  function base64urlToBytes(s) {
    const clean = String(s).replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
      const d = B64INV[clean.charCodeAt(i)];
      if (d < 0) throw new Error('encode.decode: payload is not base64url');
      acc = (acc << 6) | d;
      bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return out.subarray(0, o);
  }

  // ------------------------------------------------------------------
  // gzip, two ways
  // ------------------------------------------------------------------

  const hasStreams = typeof CompressionStream === 'function'
    && typeof DecompressionStream === 'function' && typeof Response === 'function';

  /** Node's zlib, loaded lazily and only where `require` exists. */
  function zlib() {
    if (typeof require !== 'function') {
      throw new Error('encode: no CompressionStream and no zlib in this runtime');
    }
    return require('zlib');
  }

  async function viaStream(bytes, Ctor) {
    const stream = new Ctor('gzip');
    const writer = stream.writable.getWriter();
    // A corrupt payload rejects the WRITABLE side too. That rejection has to be
    // settled here or it surfaces as an unhandled rejection and takes the
    // process down instead of reaching the caller's try/catch; the readable
    // side carries the error worth reporting.
    const written = writer.write(bytes).then(() => writer.close()).catch(() => {});
    try {
      const buf = await new Response(stream.readable).arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      await written;
    }
  }

  function viaZlib(bytes, dir) {
    const z = zlib();
    // Level 9: the payload is a few hundred bytes and gets pasted into chat
    // clients that wrap long lines. The extra milliseconds are not measurable.
    const out = dir === 'deflate'
      ? z.gzipSync(Buffer.from(bytes), { level: 9 })
      : z.gunzipSync(Buffer.from(bytes));
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }

  async function gzip(bytes) {
    return hasStreams ? viaStream(bytes, CompressionStream) : viaZlib(bytes, 'deflate');
  }

  async function gunzip(bytes) {
    return hasStreams ? viaStream(bytes, DecompressionStream) : viaZlib(bytes, 'inflate');
  }

  const utf8 = (s) => {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  };
  const fromUtf8 = (b) => {
    if (typeof TextDecoder === 'function') return new TextDecoder().decode(b);
    return Buffer.from(b).toString('utf8');
  };

  // ------------------------------------------------------------------
  // The two functions everything else is for
  // ------------------------------------------------------------------

  /** @returns {Promise<string>} base64url payload for a URL hash or a QR code. */
  async function encode(doc) {
    return bytesToBase64url(await gzip(utf8(payloadJSON(doc))));
  }

  /**
   * @returns {Promise<object>} the document, through `doc.create` so the weld
   * normals come back unit and the ids come back stable.
   */
  async function decode(payload) {
    if (typeof payload !== 'string' || !payload.length) {
      throw new Error('encode.decode: empty payload');
    }
    let json;
    try {
      json = fromUtf8(await gunzip(base64urlToBytes(payload)));
    } catch (e) {
      throw new Error('encode.decode: payload is not a design (corrupt or truncated)');
    }
    let obj;
    try {
      obj = JSON.parse(json);
    } catch (e) {
      throw new Error('encode.decode: payload decompressed but is not JSON');
    }
    if (!obj || obj.schema !== D.SCHEMA) {
      throw new Error('encode.decode: payload schema is ' + (obj && obj.schema)
        + ', this build understands ' + D.SCHEMA);
    }
    return D.create(obj);
  }

  // ------------------------------------------------------------------
  // The carrier
  // ------------------------------------------------------------------

  /** Read a document payload out of a URL hash, or null if there isn't one. */
  function payloadFromHash(hash) {
    const m = /(?:^#|[#&])d=([A-Za-z0-9\-_+/=]+)/.exec(hash || '');
    return m ? m[1] : null;
  }

  /** The hash a permalink carries. */
  const hashFor = (payload) => '#d=' + payload;

  const api = {
    LINEAR_STEP, ANGLE_STEP, UNIT_STEP, DEG_STEP, PROFILE_STEP,
    q, quantize, payloadJSON,
    bytesToBase64url, base64urlToBytes,
    gzip, gunzip, viaStream, viaZlib, hasStreams,
    encode, decode, payloadFromHash, hashFor,
  };

  E.encode = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
