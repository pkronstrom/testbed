/**
 * Hull shape curves and the per-side centreline sampler (spec §3.2).
 *
 * The hull is defined by three curves over a normalised parameter t in [0,1]
 * running along ONE side's tube centreline, bow tip (t=0) to stern tip (t=1):
 *
 *     keel(t)       height of the bottom of the tube
 *     sheer(t)      height of the top of the tube
 *     halfWidth(t)  plan-view half-width of the tube centreline
 *
 * with the tube centreline height and radius DERIVED, never entered:
 *
 *     z(t) = (sheer + keel) / 2
 *     r(t) = (sheer - keel) / 2
 *
 * INTERPRETATION (the spec leaves this implicit): the spec states the curves
 * over "station x" but parameterises them by t, and never says how t maps to
 * x. We take x to be affine in t across the hull's length:
 *
 *     x(t) = xBow + t * (xStern - xBow),  xBow = +LOA/2 - r(0)
 *                                         xStern = -LOA/2 + r(1)
 *
 * so t is monotone in x everywhere (as §3.2 requires over the midbody), the
 * origin is the LOA midpoint (§2b), and the hull's extreme points -- the tip
 * centreline plus its tube radius -- land exactly on +/-LOA/2.
 *
 * Interpolation is PCHIP (monotone cubic Hermite), not a natural spline: a
 * natural spline overshoots at halfWidth(0)=0 and would put the tube outboard
 * of the designed plan outline near the tips.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') { require('./vec3.js'); }
  const P = root.Packraft || (root.Packraft = {});

  /**
   * Fritsch-Carlson monotone cubic interpolant through control points
   * [[t, value], ...] sorted ascending in t.
   * @returns {{at: function(number): number, slopeAt: function(number): number}}
   */
  function pchip(points) {
    if (!points || points.length < 2) throw new Error('pchip: need >= 2 points');
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const n = xs.length;
    for (let i = 1; i < n; i++) {
      if (!(xs[i] > xs[i - 1])) throw new Error('pchip: control points must be strictly increasing in t');
    }

    const h = new Array(n - 1);
    const d = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i];
      d[i] = (ys[i + 1] - ys[i]) / h[i];
    }

    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) {
        m[i] = 0; // local extremum: flatten, never overshoot
      } else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }

    function seg(t) {
      if (t <= xs[0]) return 0;
      if (t >= xs[n - 1]) return n - 2;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= t) lo = mid; else hi = mid;
      }
      return lo;
    }

    function at(t) {
      const i = seg(t);
      const s = (t - xs[i]) / h[i];
      const s2 = s * s, s3 = s2 * s;
      return ys[i] * (2 * s3 - 3 * s2 + 1)
           + h[i] * m[i] * (s3 - 2 * s2 + s)
           + ys[i + 1] * (-2 * s3 + 3 * s2)
           + h[i] * m[i + 1] * (s3 - s2);
    }

    function slopeAt(t) {
      const i = seg(t);
      const s = (t - xs[i]) / h[i];
      const s2 = s * s;
      return (ys[i] * (6 * s2 - 6 * s)
            + h[i] * m[i] * (3 * s2 - 4 * s + 1)
            + ys[i + 1] * (-6 * s2 + 6 * s)
            + h[i] * m[i + 1] * (3 * s2 - 2 * s)) / h[i];
    }

    return { at, slopeAt, controlPoints: points };
  }

  /**
   * Bind a curve set to a hull length, giving 3D centreline evaluation.
   * @param {{keel: Array, sheer: Array, halfWidth: Array}} curves control points
   * @param {number} loa overall hull length, mm
   */
  function hullCurves(curves, loa) {
    const keel = pchip(curves.keel);
    const sheer = pchip(curves.sheer);
    const halfWidth = pchip(curves.halfWidth);

    const rAt = (t) => (sheer.at(t) - keel.at(t)) / 2;
    const zAt = (t) => (sheer.at(t) + keel.at(t)) / 2;

    // The tip stations sit one tip-radius inside LOA so a pointed or flat-
    // capped hull's SURFACE reaches exactly +-LOA/2. A round cap's tangent
    // arc bulges roughly capWidth/2 beyond its tip station, so the curve
    // domain must pull back further or the boat outgrows its own LOA --
    // unnoticed, this made a "2.8 m" hull 3.19 m long. The insets ride on
    // the curves object (derive sets them) so every caller agrees.
    const xBow = loa / 2 - rAt(0) - (curves.insetBow || 0);
    const xStern = -loa / 2 + rAt(1) + (curves.insetStern || 0);
    const dxdt = xStern - xBow;

    /** Centreline point of the PORT side at parameter t. */
    const pointAt = (t) => [xBow + t * dxdt, halfWidth.at(t), zAt(t)];

    /** dC/dt of the port centreline. */
    const tangentAt = (t) => [
      dxdt,
      halfWidth.slopeAt(t),
      (sheer.slopeAt(t) + keel.slopeAt(t)) / 2,
    ];

    /** |dC/dt|, the speed used by every arc-length and Pappus integral. */
    const speedAt = (t) => {
      const d = tangentAt(t);
      return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    };

    return {
      keel, sheer, halfWidth, loa, xBow, xStern,
      rAt, zAt, pointAt, tangentAt, speedAt,
      halfWidthAt: (t) => halfWidth.at(t),
    };
  }

  /**
   * Dense sampling of one side's centreline. This is the input to joint
   * placement and to every integral over the hull.
   * @returns {Array<{t:number, p:number[], r:number, halfWidth:number, keel:number, sheer:number}>}
   */
  function sampleSide(hc, n) {
    const count = n || 240;
    const out = new Array(count + 1);
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      out[i] = {
        t,
        p: hc.pointAt(t),
        r: hc.rAt(t),
        halfWidth: hc.halfWidth.at(t),
        keel: hc.keel.at(t),
        sheer: hc.sheer.at(t),
      };
    }
    return out;
  }

  /**
   * The port HALF-RING: the full path the tube centreline actually travels,
   * from the bow apex (on the centreplane) around the bow turn, down the
   * side, and around the stern turn to the stern apex.
   *
   * WHY THIS EXISTS -- the model rethink. The side curves alone cannot turn
   * past vertical (x is monotone in t), so earlier revisions segmented the
   * sides with the optimiser and bolted fixed-chord caps onto the ends. The
   * result had uniform side segments and stingy little end chords -- nothing
   * like a real boat, whose seams fan tightly around the turns and stretch
   * long down the straights. Once the turn is part of ONE sampled path, the
   * min-max joint optimiser produces that layout on its own: curvature is
   * where deviation lives, so that is where it spends seams.
   *
   * The turn at each end is the tangent circle: centre on the centreplane,
   * tangent to the side curve at its endpoint, swept to the apex. Radius and
   * height are held at the endpoint values across the turn. capWidth = 0
   * degenerates to no turn at all -- the path IS the old side sampling, and
   * the pointed hull is bit-identical.
   *
   * @returns {{samples, bowTurnEnd, sternTurnStart}} samples as sampleSide,
   *          plus the indices where the side curve begins and ends.
   */
  function ringPath(hc, opts) {
    const n = (opts && opts.sideSamples) || 240;
    const side = sampleSide(hc, n);

    function turn(tEnd, end) {
      const p0 = hc.pointAt(tEnd);
      const y0 = p0[1];
      if (y0 <= 1e-9) return [];
      const d = hc.tangentAt(tEnd);
      if (Math.abs(d[0]) < 1e-9) return [];
      const xc = p0[0] + (y0 * d[1]) / d[0];
      const R = Math.hypot(p0[0] - xc, y0);
      const a0 = Math.atan2(y0, p0[0] - xc);
      // The apex must bulge outward; a path whose tubes diverge toward the
      // tip has no turn to make.
      if (end === 'bow' ? (xc + R <= p0[0]) : (xc - R >= p0[0])) return [];
      const r0 = hc.rAt(tEnd), z0 = p0[2];
      // Sample the arc about as densely (per mm) as the side curve.
      const sideLen = Math.hypot(hc.xStern - hc.xBow, 0) || 1;
      const arcLen = Math.abs(end === 'bow' ? a0 : Math.PI - a0) * R;
      const m = Math.max(8, Math.min(60, Math.round((arcLen / sideLen) * n)));
      const out = [];
      for (let k = 0; k < m; k++) {
        // Bow: apex (angle 0) -> a0 exclusive; the side sample at tEnd is the
        // arc's own endpoint. Stern: a0 -> PI, apex last.
        const f = end === 'bow' ? (k / m) : ((k + 1) / m);
        const ang = end === 'bow' ? f * a0 : a0 + f * (Math.PI - a0);
        out.push({
          t: tEnd,
          p: [xc + R * Math.cos(ang), R * Math.sin(ang), z0],
          r: r0, halfWidth: R * Math.sin(ang),
          keel: z0 - r0, sheer: z0 + r0,
          turn: end,
        });
      }
      return out;
    }

    // A BRIDGED end (panel-on-axis) has no wrap turn: the design curve stops
    // at the terminus and a straddling tube spans it. Only a wrapped end
    // curls the path around to the centreplane.
    const bowTurn = (opts && opts.wrapBow === false) ? [] : turn(0, 'bow');
    const sternTurn = (opts && opts.wrapStern === false) ? [] : turn(1, 'stern');
    const samples = bowTurn.concat(side, sternTurn);
    return {
      samples,
      bowTurnEnd: bowTurn.length,
      sternTurnStart: bowTurn.length + side.length - 1,
      turnBulgeBow: bowTurn.length ? (bowTurn[0].p[0] - side[0].p[0]) : 0,
      turnBulgeStern: sternTurn.length
        ? (side[side.length - 1].p[0] - sternTurn[sternTurn.length - 1].p[0]) : 0,
    };
  }

  const api = { pchip, hullCurves, sampleSide, ringPath };

  P.curves = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
