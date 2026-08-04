/**
 * engine/cone.js -- exact conical development, PORTED as a REFERENCE.
 *
 * This is packraft-core/develop.js's closed-form cone/cylinder machinery,
 * copied into the engine namespace with the frustum handed in explicitly
 * instead of coming from `skeleton.buildSkeleton`. It exists for two reasons
 * and no others:
 *
 * 1. It is the independent implementation the general ruling-correspondence
 *    kernel is CROSS-CHECKED against (architecture review 12: "without a
 *    crossover gate the general branch has no independent check at all -- and
 *    it is the one piece of new numerics in the whole plan").
 * 2. It gives the analytic cut-ellipse (`cutEllipse`) that turns a cone plus a
 *    cut plane into a weld record, so a cone-family boat can be written as a
 *    weld document without a numerical conic fit.
 *
 * It is NOT a fast path in the engine. The plan's "the circular case keeps
 * today's closed-form fast path and must stay bit-compatible" does not survive
 * contact with the document: welds are stored conics, the cone is recovered by
 * fitting, and fitting is not bit-exact (geometry review 15). The engine's
 * cone/cylinder branch is instead the closed-form CORRESPONDENCE (phi = theta
 * for parallel homothetic welds); the development is the same
 * geodesic-curvature quadrature every other branch uses. That keeps one
 * development path, so there is no crossover cliff for a drag to chatter
 * across.
 *
 * ---- from the original file, because the argument is worth carrying ----
 * For a cone of half-angle alpha with its apex at the origin, a surface point
 * at circumferential angle theta and slant distance l from the apex maps to
 * plane polar coordinates (rho, psi) = (l, theta*sin(alpha)), so the full cone
 * develops to a sector sweeping 2*pi*sin(alpha). A cylinder is the alpha -> 0
 * limit and is handled as its own branch.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') { require('./vec3.js'); require('./quad.js'); }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const Q = E.quad;

  const CYLINDER_EPS = 1e-12;

  /** A frustum from two centre/radius stations on a common axis. */
  function frustum(A, RA, B, RB) {
    const axis = V.norm(V.sub(B, A));
    return { A, B, RA, RB, axis, length: V.dist(A, B), frame: V.frame(axis) };
  }

  /** Apex, half-angle and the frame theta is measured in. */
  function conify(seg) {
    const { a, u, v } = seg.frame;
    const dR = seg.RA - seg.RB;
    if (Math.abs(dR) < CYLINDER_EPS) {
      return { kind: 'cylinder', axis: a, u, v, R: seg.RA, origin: seg.A };
    }
    const tanA = dR / seg.length;
    const sStar = seg.RA / tanA;
    const apex = V.add(seg.A, V.scale(a, sStar));
    const absAlpha = Math.abs(Math.atan(tanA));
    const outward = sStar > 0 ? V.scale(a, -1) : a;
    return {
      kind: 'cone', apex, outward, u, v, axis: a,
      alpha: absAlpha, sinAlpha: Math.sin(absAlpha), cosAlpha: Math.cos(absAlpha),
    };
  }

  /** Unit generator direction at circumferential angle theta. */
  function generator(cn, theta) {
    const radial = V.add(V.scale(cn.u, Math.cos(theta)), V.scale(cn.v, Math.sin(theta)));
    if (cn.kind === 'cylinder') return { dir: cn.axis, radial };
    return {
      dir: V.add(V.scale(cn.outward, cn.cosAlpha), V.scale(radial, cn.sinAlpha)),
      radial,
    };
  }

  /**
   * Where the generator at theta crosses a cut plane. Cone: slant distance
   * from the apex. Cylinder: axial distance from origin.
   *
   * The original throws here in three situations. This port returns NaN
   * instead: the interaction review (finding 4) is right that a throw inside
   * the geometry kernel is what freezes the boat mid-drag, and this module is
   * a reference implementation whose job is to be comparable, not to police.
   */
  function cutParam(cn, theta, plane) {
    const g = generator(cn, theta);
    if (cn.kind === 'cylinder') {
      const num = V.dot(V.sub(plane.point, cn.origin), plane.normal)
        - cn.R * V.dot(g.radial, plane.normal);
      const den = V.dot(cn.axis, plane.normal);
      if (Math.abs(den) < 1e-12) return NaN;
      return num / den;
    }
    const den = V.dot(g.dir, plane.normal);
    if (Math.abs(den) < 1e-12) return NaN;
    const l = V.dot(V.sub(plane.point, cn.apex), plane.normal) / den;
    // A negative slant distance means the generator meets the plane BEHIND the
    // apex, on the cone's other nappe -- a surface the fabric does not occupy.
    if (l < 0) return NaN;
    return l;
  }

  /** 3D point on the cut edge at angle theta. */
  function edgePoint3D(cn, theta, plane) {
    const g = generator(cn, theta);
    const p = cutParam(cn, theta, plane);
    if (cn.kind === 'cylinder') {
      return V.add(cn.origin, V.add(V.scale(cn.axis, p), V.scale(g.radial, cn.R)));
    }
    return V.add(cn.apex, V.scale(g.dir, p));
  }

  /** Developed (u, v) point on the cut edge at angle theta, in mm. */
  function edgePointDev(cn, theta, plane) {
    const p = cutParam(cn, theta, plane);
    if (cn.kind === 'cylinder') return [p, cn.R * theta];
    const psi = theta * cn.sinAlpha;
    return [p * Math.cos(psi), p * Math.sin(psi)];
  }

  /** Surface point at circumferential angle theta and cone parameter l. */
  function paramPoint3D(cn, theta, l) {
    const radial = V.add(V.scale(cn.u, Math.cos(theta)), V.scale(cn.v, Math.sin(theta)));
    if (cn.kind === 'cylinder') {
      return V.add(cn.origin, V.add(V.scale(cn.axis, l), V.scale(radial, cn.R)));
    }
    const dir = V.add(V.scale(cn.outward, cn.cosAlpha), V.scale(radial, cn.sinAlpha));
    return V.add(cn.apex, V.scale(dir, l));
  }

  /** The same point in the development. */
  function paramPointDev(cn, theta, l) {
    if (cn.kind === 'cylinder') return [l, cn.R * theta];
    const psi = theta * cn.sinAlpha;
    return [l * Math.cos(psi), l * Math.sin(psi)];
  }

  /**
   * Arc length of one cut edge, in 3D and in the development, by independent
   * quadrature of the two parametrisations. Equality of these two numbers is
   * the old engine's foundational invariant, and it is the number the new
   * engine is cross-checked against.
   */
  function edgeLengths(cn, plane, opts) {
    const t0 = (opts && opts.theta0) || 0;
    const t1 = t0 + 2 * Math.PI;
    return {
      length3D: Q.arcLength((th) => edgePoint3D(cn, th, plane), t0, t1, opts),
      lengthDev: Q.arcLength((th) => edgePointDev(cn, th, plane), t0, t1, opts),
    };
  }

  /**
   * The plane section of a cone, as a WELD RECORD -- analytically.
   *
   * The cut of a cone by a plane is an ellipse whose major axis lies in the
   * plane spanned by the cone axis and the plane normal (the configuration is
   * mirror-symmetric about it). Writing g(theta) for the unit generator and
   * h = n.(p0 - apex),
   *
   *     l(theta) = h / (A0 + K cos(theta - delta))
   *
   * with A0 = cos(alpha) (n.axis), K = sin(alpha)|n_perp|, delta the phase of
   * n's component in the (u, v) plane. The extreme generators are at
   * theta = delta and delta + pi, giving vertex distances l1, l2, hence
   *
     *   centre = (P1 + P2)/2,  a = |P1 - P2|/2,  b = sqrt(l1 l2) sin(alpha)
   *
   * (the last is the standard cone-section relation; the test asserts the
   * resulting ellipse reproduces `edgePoint3D` to 1e-9 mm, so the formula is
   * checked rather than trusted).
   *
   * @param {object} cn conified frustum
   * @param {{point:number[], normal:number[]}} plane
   * @param {number[]} traversal the ring direction the weld normal must face
   */
  function cutEllipse(cn, plane, traversal) {
    let n = V.norm(plane.normal);
    if (traversal && V.dot(n, traversal) < 0) n = V.scale(n, -1);
    let c, a, b, e1;
    if (cn.kind === 'cylinder') {
      const nu = V.dot(cn.u, n), nv = V.dot(cn.v, n);
      const delta = Math.atan2(nv, nu);
      const P1 = edgePoint3D(cn, delta, plane);
      const P2 = edgePoint3D(cn, delta + Math.PI, plane);
      c = V.scale(V.add(P1, P2), 0.5);
      a = V.dist(P1, P2) / 2;
      b = cn.R;
      e1 = a > 1e-12 ? V.norm(V.sub(P1, c)) : V.norm(V.reject(cn.axis, n));
    } else {
      const nu = V.dot(cn.u, n), nv = V.dot(cn.v, n);
      const delta = Math.atan2(nv, nu);
      const l1 = cutParam(cn, delta, plane);
      const l2 = cutParam(cn, delta + Math.PI, plane);
      const P1 = edgePoint3D(cn, delta, plane);
      const P2 = edgePoint3D(cn, delta + Math.PI, plane);
      c = V.scale(V.add(P1, P2), 0.5);
      a = V.dist(P1, P2) / 2;
      b = Math.sqrt(l1 * l2) * cn.sinAlpha;
      e1 = V.norm(V.sub(P1, c));
    }
    // `a` is the semi-axis along e1 and `b` along e2 = n x e1. The weld record
    // does not require a >= b, so no swap is needed -- `roll` carries the
    // orientation and the kernel reads whatever it is given.
    const f = V.frame(n);
    const roll = Math.atan2(V.dot(e1, f.v), V.dot(e1, f.u));
    return { c, n, a, b, roll, seam: Math.PI, onCentreplane: false, profile: null };
  }

  const api = {
    CYLINDER_EPS, frustum, conify, generator, cutParam,
    edgePoint3D, edgePointDev, paramPoint3D, paramPointDev, edgeLengths,
    cutEllipse,
  };

  E.cone = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
