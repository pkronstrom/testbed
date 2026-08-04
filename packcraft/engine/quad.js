/**
 * engine/quad.js -- quadrature and root finding for the weld-first engine.
 *
 * PORTED, by copy, from packraft-core/quad.js (Gauss-Legendre nodes/weights,
 * `integrate`, `derivative`, `arcLength`, `polylineLength`). See engine/vec3.js
 * for why the engine copies rather than imports.
 *
 * Two deliberate ADDITIONS, both demanded by notes/plan-review-geometry.md:
 *
 * - `integrateTo` -- the composite GL rule evaluated at every GL node of the
 *   OUTER interval, so a nested integral (the developed tangent direction
 *   Psi(theta) inside the developed-position integral, finding 4) costs one
 *   pass instead of one integration per node.
 * - `newton` -- finding 6 is explicit that `bisect` CANNOT be used for the
 *   ruling correspondence: at a fold the root is tangential and unbracketed,
 *   so bisection reports "no root" on a surface that has one. Newton with a
 *   damped step and an explicit convergence flag replaces it. `bisect` is kept
 *   for the seed scan, where brackets do exist.
 */
;(function (root) {
  'use strict';
  const E = root.PackraftEngine || (root.PackraftEngine = {});

  // 8-point Gauss-Legendre nodes/weights on [-1, 1].
  const GL_X = [
    -0.9602898564975363, -0.7966664774136267, -0.5255324099163290,
    -0.1834346424956498, 0.1834346424956498, 0.5255324099163290,
    0.7966664774136267, 0.9602898564975363,
  ];
  const GL_W = [
    0.1012285362903763, 0.2223810344533745, 0.3137066458778873,
    0.3626837833783620, 0.3626837833783620, 0.3137066458778873,
    0.2223810344533745, 0.1012285362903763,
  ];

  /** Composite 8-point Gauss-Legendre integration of a scalar function. */
  function integrate(f, a, b, subdivisions) {
    const n = subdivisions || 64;
    const step = (b - a) / n;
    let total = 0;
    for (let k = 0; k < n; k++) {
      const lo = a + k * step;
      const mid = lo + step / 2;
      const half = step / 2;
      let sum = 0;
      for (let i = 0; i < GL_X.length; i++) {
        sum += GL_W[i] * f(mid + half * GL_X[i]);
      }
      total += sum * half;
    }
    return total;
  }

  /**
   * The GL nodes of [a, b], and the running integral of f from a to each node.
   *
   * This is what makes the geodesic-curvature development affordable: the
   * developed position integral needs Psi (itself an integral) AT each of its
   * own quadrature nodes. Computing the partial integrals in one sweep turns
   * an O(k^2) nested quadrature into O(k^2) *arithmetic* with k function
   * evaluations, and keeps the same spectral accuracy on smooth integrands.
   *
   * @returns {{nodes:number[], weights:number[], partial:number[], total:number}}
   *   `partial[i]` is the integral from a to nodes[i]; `total` from a to b.
   */
  function integrateTo(f, a, b) {
    const half = (b - a) / 2;
    const mid = (a + b) / 2;
    const k = GL_X.length;
    const nodes = new Array(k);
    const vals = new Array(k);
    for (let i = 0; i < k; i++) {
      nodes[i] = mid + half * GL_X[i];
      vals[i] = f(nodes[i]);
    }
    let total = 0;
    for (let i = 0; i < k; i++) total += GL_W[i] * vals[i];
    total *= half;
    // Partial integrals: re-integrate f from a to nodes[i] with its own GL
    // panel. Cheap (k extra evaluations each) and keeps every partial the same
    // order as the total, which a naive cumulative-weight sum does not.
    const partial = new Array(k);
    for (let i = 0; i < k; i++) {
      const hi = nodes[i];
      const h2 = (hi - a) / 2, m2 = (hi + a) / 2;
      let s = 0;
      for (let j = 0; j < k; j++) s += GL_W[j] * f(m2 + h2 * GL_X[j]);
      partial[i] = s * h2;
    }
    return { nodes, weights: GL_W.map((w) => w * half), partial, total };
  }

  /**
   * Five-point central derivative of a vector-valued function.
   * Truncation is O(h^4); h = 1e-5 of the parameter span keeps roundoff
   * (~eps/h) around 1e-11 relative.
   */
  function derivative(f, t, h) {
    const m2 = f(t - 2 * h), m1 = f(t - h), p1 = f(t + h), p2 = f(t + 2 * h);
    const n = m1.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = (m2[i] - 8 * m1[i] + 8 * p1[i] - p2[i]) / (12 * h);
    }
    return out;
  }

  /**
   * Arc length of a parametric curve f: [t0, t1] -> R^n, by quadrature of
   * |f'(t)|. f may return 2- or 3-vectors, so the identical routine measures a
   * 3D surface curve and its 2D development -- that symmetry is the whole
   * point of the conservation tests.
   */
  function arcLength(f, t0, t1, opts) {
    const o = opts || {};
    const h = o.h || (t1 - t0) * 1e-5;
    const speed = (t) => {
      const d = derivative(f, t, h);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s);
    };
    const a = t0 + 2 * h, b = t1 - 2 * h;
    const interior = integrate(speed, a, b, o.subdivisions || 96);
    const endBits = 2 * h * speed(a) + 2 * h * speed(b);
    return interior + endBits;
  }

  /** Length of a polyline given as an array of points. Diagnostics only. */
  function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      let s = 0;
      for (let k = 0; k < points[i].length; k++) {
        const d = points[i][k] - points[i - 1][k];
        s += d * d;
      }
      total += Math.sqrt(s);
    }
    return total;
  }

  /** Bisection root find on a bracketed scalar function. Seed scan only. */
  function bisect(f, lo, hi, tol, maxIter) {
    let flo = f(lo);
    const fhi = f(hi);
    if (flo === 0) return lo;
    if (fhi === 0) return hi;
    if (flo * fhi > 0) throw new Error('bisect: root not bracketed');
    const eps = tol || 1e-9;
    const iters = maxIter || 200;
    let a = lo, b = hi;
    for (let i = 0; i < iters; i++) {
      const m = 0.5 * (a + b);
      const fm = f(m);
      if (fm === 0 || (b - a) / 2 < eps) return m;
      if (flo * fm < 0) { b = m; } else { a = m; flo = fm; }
    }
    return 0.5 * (a + b);
  }

  /**
   * Damped Newton on a scalar function with an analytic derivative.
   *
   * ADDED for the ruling correspondence. Returns a RESULT, never a throw:
   * finding 6(c) shows tangential double roots exist on short segments, where
   * Newton loses quadratic convergence, and the caller must be able to report
   * "conditioning margin small" rather than crash a live drag.
   *
   * @param {(x:number)=>number} f
   * @param {(x:number)=>number} df
   * @param {number} x0 seed
   * @param {{tol?:number, maxIter?:number, maxStep?:number}} [opts]
   * @returns {{x:number, converged:boolean, residual:number, iters:number,
   *            slope:number}}
   */
  function newton(f, df, x0, opts) {
    const o = opts || {};
    const tol = o.tol == null ? 1e-13 : o.tol;
    const maxIter = o.maxIter || 40;
    const maxStep = o.maxStep == null ? Math.PI / 4 : o.maxStep;
    let x = x0, fx = f(x), i = 0, slope = df(x);
    for (; i < maxIter; i++) {
      if (Math.abs(fx) <= tol) break;
      slope = df(x);
      if (!isFinite(slope) || slope === 0) break;
      let step = -fx / slope;
      if (step > maxStep) step = maxStep;
      else if (step < -maxStep) step = -maxStep;
      const xn = x + step;
      const fn = f(xn);
      x = xn; fx = fn;
      if (Math.abs(step) < 1e-15) break;
    }
    return { x, converged: Math.abs(fx) <= tol, residual: Math.abs(fx), iters: i, slope };
  }

  const api = {
    GL_X, GL_W, integrate, integrateTo, derivative, arcLength,
    polylineLength, bisect, newton,
  };

  E.quad = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
