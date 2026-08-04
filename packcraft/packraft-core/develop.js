/**
 * Exact conical development (spec §2). This module is the project's
 * foundational invariant: every developed panel edge must match its 3D
 * counterpart to <= 1e-6 mm, and that is asserted, not assumed.
 *
 * For a cone of half-angle alpha with its apex at the origin, a surface point
 * at circumferential angle theta and slant distance l from the apex maps to
 * plane polar coordinates
 *
 *     (rho, psi) = (l, theta * sin(alpha))
 *
 * so the full cone develops to a sector sweeping 2*pi*sin(alpha). A cylinder
 * is the alpha -> 0 limit and is handled as its own branch: there the
 * development is (u, v) = (axial position, r * theta), and an oblique cut
 * develops to a sine wave.
 *
 * Why this is exact rather than approximate: the developed speed of an edge
 * curve parameterised by theta is
 *
 *     |d/dtheta (l cos psi, l sin psi)| = sqrt(l'^2 + l^2 sin^2 alpha)
 *
 * and the 3D speed of the same curve on the cone is
 *
 *     |d/dtheta (apex + l * g(theta))| = sqrt(l'^2 + l^2 |g'|^2),  |g'| = sin(alpha)
 *
 * -- the same function. The tests measure both by independent numerical paths
 * anyway, because a proof in a comment catches no typos.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js');
    require('./constants.js');
    require('./quad.js');
  }
  const P = root.Packraft || (root.Packraft = {});
  const V = P.vec3;
  const C = P.constants;
  const QUAD = P.quad;

  const CYLINDER_EPS = 1e-12;

  /**
   * Precompute the developable description of a frustum: apex, half-angle and
   * the frame that theta is measured in.
   */
  function conify(seg) {
    const { a, u, v } = seg.frame;
    const dR = seg.RA - seg.RB;
    if (Math.abs(dR) < CYLINDER_EPS) {
      return { kind: 'cylinder', axis: a, u, v, R: seg.RA, origin: seg.A };
    }
    const tanA = dR / seg.length;
    const sStar = seg.RA / tanA;              // axial coordinate where R = 0
    const apex = V.add(seg.A, V.scale(a, sStar));
    const absAlpha = Math.abs(Math.atan(tanA));
    // Unit vector from the apex toward the frustum.
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
   * Where the generator at theta crosses a cut plane.
   * Cone: slant distance from the apex. Cylinder: axial distance from origin.
   */
  function cutParam(cn, theta, plane) {
    const g = generator(cn, theta);
    if (cn.kind === 'cylinder') {
      const num = V.dot(V.sub(plane.point, cn.origin), plane.normal)
        - cn.R * V.dot(g.radial, plane.normal);
      const den = V.dot(cn.axis, plane.normal);
      if (Math.abs(den) < 1e-12) throw new Error('cutParam: cut plane is parallel to the cylinder axis');
      return num / den;
    }
    const den = V.dot(g.dir, plane.normal);
    if (Math.abs(den) < 1e-12) throw new Error('cutParam: cut plane contains the generator');
    const l = V.dot(V.sub(plane.point, cn.apex), plane.normal) / den;
    // A negative slant distance means the generator meets the plane BEHIND
    // the apex, i.e. on the cone's other nappe -- a surface the fabric does
    // not occupy. Developing it silently produces a plausible-looking panel
    // that is not the panel. (Cylinders are exempt: their parameter is an
    // axial coordinate measured from A and is legitimately signed.)
    if (l < 0) {
      throw new Error('cutParam: cut plane crosses the generator behind the apex '
        + '(opposite nappe) -- this segment tapers past its own cut');
    }
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

  /** Developed (u, v) point on the cut edge at angle theta, in mm. */
  function edgePointDev(cn, theta, plane) {
    const p = cutParam(cn, theta, plane);
    if (cn.kind === 'cylinder') return [p, cn.R * theta];
    const psi = theta * cn.sinAlpha;
    return [p * Math.cos(psi), p * Math.sin(psi)];
  }

  /**
   * Arc length of one cut edge, in 3D and in the development, measured by
   * independent quadrature of the two parametrisations. Equality of these two
   * numbers IS the project's foundational invariant (§2).
   */
  function edgeLengths(seg, which, opts) {
    const cn = conify(seg);
    const plane = which === 'start' ? seg.planeStart : seg.planeEnd;
    const t0 = (opts && opts.theta0) || 0;
    const t1 = t0 + 2 * Math.PI;
    return {
      length3D: QUAD.arcLength((th) => edgePoint3D(cn, th, plane), t0, t1, opts),
      lengthDev: QUAD.arcLength((th) => edgePointDev(cn, th, plane), t0, t1, opts),
    };
  }

  /**
   * Develop one frustum into a flat panel.
   *
   * The panel is the surface between the two cut planes, opened along the
   * generator at `seamAngle` (the §3.7 clock angle: 0 = top of the tube,
   * 180 deg = bottom, increasing toward inboard). The outline runs along the
   * start edge, down the seam, back along the end edge, and closes.
   *
   * @param {object} seg a frustum from skeleton.buildSkeleton
   * @param {{seamAngle?: number, samples?: number}} [opts] seamAngle in radians
   */
  function developSegment(seg, opts) {
    const o = opts || {};
    const base = o.seamAngle == null ? Math.PI : o.seamAngle;
    // The seam is opened at a possibly DIFFERENT angle at each end. At a girth
    // joint the two adjacent segments have different frames, so a single fixed
    // clock angle puts their seams at different points on the shared conic --
    // an 8 mm step in the landing line on the reference hull. `panels`
    // registers one seam point per joint and passes the two angles that hit
    // it, which makes the longitudinal seam a continuous surface curve rather
    // than ten disconnected rulings.
    const thetaStart = o.seamAngleStart == null ? base : o.seamAngleStart;
    const thetaEnd = o.seamAngleEnd == null ? base : o.seamAngleEnd;
    const samples = o.samples || C.PANEL_SAMPLES;
    const cn = conify(seg);

    const startEdge = new Array(samples + 1);
    const endEdge = new Array(samples + 1);
    const startEdge3D = new Array(samples + 1);
    const endEdge3D = new Array(samples + 1);
    for (let i = 0; i <= samples; i++) {
      const f = i / samples;
      const ths = thetaStart + 2 * Math.PI * f;
      const the = thetaEnd + 2 * Math.PI * f;
      startEdge[i] = edgePointDev(cn, ths, seg.planeStart);
      endEdge[i] = edgePointDev(cn, the, seg.planeEnd);
      startEdge3D[i] = edgePoint3D(cn, ths, seg.planeStart);
      endEdge3D[i] = edgePoint3D(cn, the, seg.planeEnd);
    }

    // The seam curve itself: theta sweeps from thetaStart to thetaEnd as the
    // surface parameter runs from the start cut to the end cut. This is the
    // line the tube's edge lands on, so the floor's landing zones measure it.
    const seamSamples = o.seamSamples || 64;
    const seamCurve = new Array(seamSamples + 1);
    const seamCurve3D = new Array(seamSamples + 1);
    for (let i = 0; i <= seamSamples; i++) {
      const f = i / seamSamples;
      const th = thetaStart + (thetaEnd - thetaStart) * f;
      const lStart = cutParam(cn, th, seg.planeStart);
      const lEnd = cutParam(cn, th, seg.planeEnd);
      const l = lStart + (lEnd - lStart) * f;
      seamCurve[i] = paramPointDev(cn, th, l);
      seamCurve3D[i] = paramPoint3D(cn, th, l);
    }

    // Closed outline: start edge forward, seam, end edge back, seam home.
    const outline = startEdge.concat(endEdge.slice().reverse());

    // The two quadratures below cost ~3.5 ms per segment and dominate a
    // regenerate. They are verification, not geometry: the outline above is
    // complete without them. Pass {measure:false} on a live redraw and run
    // matedEdges() on a debounce instead.
    const measure = o.measure !== false;
    const start = measure ? edgeLengths(seg, 'start', { theta0: thetaStart }) : { length3D: NaN, lengthDev: NaN };
    const end = measure ? edgeLengths(seg, 'end', { theta0: thetaEnd }) : { length3D: NaN, lengthDev: NaN };

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const pt of outline) {
      if (pt[0] < uMin) uMin = pt[0];
      if (pt[0] > uMax) uMax = pt[0];
      if (pt[1] < vMin) vMin = pt[1];
      if (pt[1] > vMax) vMax = pt[1];
    }

    return {
      id: seg.id,
      role: seg.role,
      selfMirroring: seg.selfMirroring,
      kind: cn.kind,
      alpha: cn.kind === 'cone' ? cn.alpha : 0,
      sectorAngle: cn.kind === 'cone' ? 2 * Math.PI * cn.sinAlpha : 0,
      seamAngle: base,
      seamAngleStart: thetaStart,
      seamAngleEnd: thetaEnd,
      outline, startEdge, endEdge, startEdge3D, endEdge3D,
      seamCurve, seamCurve3D,
      seamLength3D: polyLength3D(seamCurve3D),
      startEdgeLength3D: start.length3D,
      startEdgeLengthDev: start.lengthDev,
      endEdgeLength3D: end.length3D,
      endEdgeLengthDev: end.lengthDev,
      bbox: { uMin, uMax, vMin, vMax, width: uMax - uMin, height: vMax - vMin },
      // Ruling lines (§8.6): generators every N degrees, free from the geometry.
      rulings: rulingLines(cn, seg, thetaStart, o.rulingStepDeg || 15),
    };
  }

  /** Generator lines from the start edge to the end edge, every step degrees. */
  function rulingLines(cn, seg, theta0, stepDeg) {
    const step = (stepDeg * Math.PI) / 180;
    const out = [];
    for (let th = theta0; th < theta0 + 2 * Math.PI - 1e-9; th += step) {
      out.push([edgePointDev(cn, th, seg.planeStart), edgePointDev(cn, th, seg.planeEnd)]);
    }
    return out;
  }

  /**
   * Mated-edge report for a closed skeleton (§2b tolerance table, G0.6).
   * Every girth seam joins segment i's end edge to segment i+1's start edge;
   * both develop the same 3D conic, so their developed lengths must agree.
   */
  function matedEdges(skeleton, opts) {
    const segs = skeleton.segments;
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i];
      const b = segs[(i + 1) % segs.length];
      const ae = edgeLengths(a, 'end', opts);
      const bs = edgeLengths(b, 'start', opts);
      out.push({
        joint: a.endNode,
        a: a.id, b: b.id,
        lengthA: ae.lengthDev,
        lengthB: bs.lengthDev,
        mismatch: Math.abs(ae.lengthDev - bs.lengthDev),
        conservationA: Math.abs(ae.lengthDev - ae.length3D),
        conservationB: Math.abs(bs.lengthDev - bs.length3D),
      });
    }
    return out;
  }

  /**
   * Volume enclosed by the generated tube, in mm^3 (spec §5.1).
   *
   * The tube ring is topologically a torus, so the surface the panels
   * describe is already closed -- no caps, nothing to stitch. The divergence
   * theorem over its triangles therefore gives the EXACT volume of the solid
   * that actually gets built, faceting included.
   *
   * This is not what `params.tubeVolume()` computes. That one is the Pappus
   * integral 2*int(pi r^2 dl) over the smooth design centreline, which §5.1
   * specifies for sizing. The two differ by ~2% on the reference hull, and
   * Pappus is the high one: it double-counts where the port and starboard
   * tubes interpenetrate near the tips, and it does not see the volume
   * faceting cuts off. §5.1 attributes its own validity to the curvature
   * radius exceeding the tube radius; that condition is in fact satisfied
   * here (minimum ratio 2.36), so the spec's stated justification is not the
   * mechanism -- see notes/phase1-notes.md.
   *
   * Accuracy is set by the panels' circumferential sampling: 48 samples
   * (the live path) lands within ~0.2% of the converged value, 180 within
   * 0.02%.
   *
   * @param {Array} panels output of developSegment for every segment
   */
  function enclosedVolume(panels) {
    let v6 = 0;
    for (const panel of panels) {
      const A = panel.startEdge3D, B = panel.endEdge3D;
      for (let i = 0; i < A.length - 1; i++) {
        v6 += tripleProduct(A[i], B[i], B[i + 1]);
        v6 += tripleProduct(A[i], B[i + 1], A[i + 1]);
      }
    }
    // Absolute: the winding depends on traversal direction around the loop,
    // which tipPhase can flip. Volume is unsigned.
    return Math.abs(v6) / 6;
  }

  function tripleProduct(a, b, c) {
    return a[0] * (b[1] * c[2] - b[2] * c[1])
         - a[1] * (b[0] * c[2] - b[2] * c[0])
         + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }

  function polyLength3D(pts) {
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += V.dist(pts[i], pts[i - 1]);
    return t;
  }

  const api = {
    conify, generator, cutParam, edgePoint3D, edgePointDev,
    paramPoint3D, paramPointDev,
    edgeLengths, developSegment, matedEdges, rulingLines, enclosedVolume,
  };

  P.develop = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
