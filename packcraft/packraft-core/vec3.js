/**
 * Minimal 3D vector math. Vectors are plain arrays [x, y, z].
 *
 * Coordinate system (spec §2b): right-handed, all lengths mm.
 *   +x  aft -> forward (bow is +x)
 *   +y  centreplane -> port
 *   +z  up
 * Origin: LOA midpoint on the centreplane, at the midship keel datum.
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

  const EPS = 1e-12;

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

  /** THE mirror primitive: y -> -y (spec §2b, §3.4b). */
  const mirrorY = (a) => [a[0], -a[1], a[2]];

  /** Angle between two vectors, radians, numerically stable near 0 and pi. */
  function angleBetween(a, b) {
    const na = norm(a), nb = norm(b);
    return 2 * Math.atan2(len(sub(na, nb)), len(add(na, nb)));
  }

  /** Perpendicular distance from point p to the segment ab. */
  function distToSegment(p, a, b) {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    if (l2 < EPS) return dist(p, a);
    let s = dot(sub(p, a), ab) / l2;
    if (s < 0) s = 0; else if (s > 1) s = 1;
    return dist(p, add(a, scale(ab, s)));
  }

  /**
   * Orthonormal frame for a tube axis. u is "up-ish" (the component of +z
   * perpendicular to the axis), so theta = 0 is the top of the tube and the
   * clock angle convention of spec §3.7 has a deterministic zero everywhere.
   * Axes in this model are never vertical, so the fallback is defensive only.
   */
  function frame(axis) {
    const a = norm(axis);
    let up = [0, 0, 1];
    if (Math.abs(dot(a, up)) > 1 - 1e-9) up = [1, 0, 0];
    const u = norm(sub(up, scale(a, dot(up, a))));
    const v = cross(a, u);
    return { a, u, v };
  }

  const api = {
    EPS, add, sub, scale, dot, cross, len, dist, norm, lerp,
    mirrorY, angleBetween, distToSegment, frame,
  };

  P.vec3 = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
