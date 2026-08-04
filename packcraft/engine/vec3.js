/**
 * engine/vec3.js -- 3D vector math for the weld-first engine.
 *
 * PORTED, by copy, from packraft-core/vec3.js (the "copy verbatim" row of the
 * architecture review's disposition table). The engine may not import
 * packraft-core: the old app must keep working untouched, and one global
 * namespace shared by two engines is silent last-writer-wins
 * (notes/plan-review-architecture.md finding 16). So this file duplicates the
 * proven primitives under the PackraftEngine namespace and adds the few
 * routines the weld kernel needs and the old one never did (rotAbout, planar
 * helpers, angle wrapping).
 *
 * Coordinate system (spec 2b): right-handed, all lengths mm.
 *   +x  aft -> forward (bow is +x)
 *   +y  centreplane -> port
 *   +z  up
 * Origin: LOA midpoint on the centreplane, at the midship keel datum.
 */
;(function (root) {
  'use strict';
  const E = root.PackraftEngine || (root.PackraftEngine = {});

  const EPS = 1e-12;

  // ---- ported verbatim from packraft-core/vec3.js ----
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.sqrt(dot(a, a));
  const dist = (a, b) => len(sub(a, b));

  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  function norm(a) {
    const l = len(a);
    if (l < EPS) throw new Error('vec3.norm: zero-length vector');
    return scale(a, 1 / l);
  }

  const lerp = (a, b, s) => [
    a[0] + (b[0] - a[0]) * s,
    a[1] + (b[1] - a[1]) * s,
    a[2] + (b[2] - a[2]) * s,
  ];

  /** THE mirror primitive: y -> -y (spec 2b, 3.4b). */
  const mirrorY = (a) => [a[0], -a[1], a[2]];

  /** Angle between two vectors, radians, numerically stable near 0 and pi. */
  function angleBetween(a, b) {
    const na = norm(a), nb = norm(b);
    return 2 * Math.atan2(len(sub(na, nb)), len(add(na, nb)));
  }

  /**
   * Orthonormal frame for an axis. u is "up-ish" (the component of +z
   * perpendicular to the axis), so theta = 0 is the top of the tube and the
   * clock angle convention of spec 3.7 has a deterministic zero everywhere.
   *
   * ADDED here over the packraft-core original: the geometry review
   * (notes/plan-review-geometry.md finding 12) requires the degenerate
   * fallback to be RECORDED, not silent, because a fully-raked weld plane has
   * n parallel to z and the parametrisation must stay reproducible.
   */
  function frame(axis) {
    const a = norm(axis);
    let up = [0, 0, 1];
    let degenerate = false;
    if (Math.abs(dot(a, up)) > 1 - 1e-9) { up = [1, 0, 0]; degenerate = true; }
    const u = norm(sub(up, scale(a, dot(up, a))));
    const v = cross(a, u);
    return { a, u, v, degenerate };
  }

  /** 3x3 determinant of three column vectors -- the torsality kernel. */
  function det3(a, b, c) {
    return a[0] * (b[1] * c[2] - b[2] * c[1])
         - a[1] * (b[0] * c[2] - b[2] * c[0])
         + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }

  /** Rodrigues rotation of v about a UNIT axis k by angle t. */
  function rotAbout(v, k, t) {
    const c = Math.cos(t), s = Math.sin(t);
    return add(add(scale(v, c), scale(cross(k, v), s)),
      scale(k, dot(k, v) * (1 - c)));
  }

  /** Component of a perpendicular to a unit vector n. */
  const reject = (a, n) => sub(a, scale(n, dot(a, n)));

  /** Wrap an angle to (-pi, pi]. */
  function wrapPi(x) {
    let a = x;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /** Wrap an angle to [0, 2pi). */
  function wrap2Pi(x) {
    let a = x % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a;
  }

  const api = {
    EPS, add, sub, scale, dot, cross, len, dist, norm, lerp,
    mirrorY, angleBetween, frame, det3, rotAbout, reject, wrapPi, wrap2Pi,
  };

  E.vec3 = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
