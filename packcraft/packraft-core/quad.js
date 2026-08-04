/**
 * Quadrature and numeric differentiation.
 *
 * Used by the arc-length conservation machinery (spec §2). Arc lengths are
 * computed from the analytic parametrisations by quadrature -- never by
 * summing polyline chords, which converges far too slowly to say anything
 * meaningful about a 1e-6 mm tolerance.
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

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
   * Five-point central derivative of a vector-valued function.
   * Truncation is O(h^4); h = 1e-5 of the parameter span keeps roundoff
   * (~eps/h) around 1e-11 relative, which is ample for 1e-6 mm on a
   * ~600 mm edge.
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
   * |f'(t)|. f may return 2- or 3-vectors, so the identical routine measures
   * a 3D surface curve and its 2D development -- that symmetry is the whole
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
    // Inset the endpoints by 2h so the stencil never steps outside the domain.
    const a = t0 + 2 * h, b = t1 - 2 * h;
    const interior = integrate(speed, a, b, o.subdivisions || 96);
    // The two 2h end slivers, at the endpoint speeds. Their length is ~4e-5
    // of the span, so a midpoint estimate there is far below tolerance.
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

  /** Bisection root find on a monotone-ish scalar function. */
  function bisect(f, lo, hi, tol, maxIter) {
    let flo = f(lo);
    let fhi = f(hi);
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
      if (flo * fm < 0) { b = m; fhi = fm; } else { a = m; flo = fm; }
    }
    return 0.5 * (a + b);
  }

  const api = { integrate, derivative, arcLength, polylineLength, bisect };

  P.quad = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
