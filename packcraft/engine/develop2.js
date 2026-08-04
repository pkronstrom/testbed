/**
 * engine/develop2.js -- numerical development, panels, floor, tab bands.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT UNROLLING
 *
 * The plan said "unroll rulings preserving lengths". Measured, that cannot
 * reach any useful gate: a polyline through the ruling endpoints carries the
 * chord deficit (kappa*ds)^2/24, which on the a=320/b=160 nose section costs
 * 1.11 mm at 48 rulings and still 4.9e-3 mm at 720 -- roughly 1500 rulings for
 * 0.01 mm and ~50 000 for 1e-6 mm, each one carrying a rootfind
 * (notes/plan-review-geometry.md finding 4). And quadrature does not rescue it:
 * `quad.arcLength` works in the old engine only because there is an ANALYTIC
 * developed parametrisation to differentiate; quadrature of a point cloud is
 * the chord sum again.
 *
 * So this module develops by GEODESIC CURVATURE. Bending preserves it, which
 * gives an analytic developed parametrisation and restores exactly the
 * property that makes the gate meaningful. With d(theta) = q(phi(theta)) - p:
 *
 *   n^(theta)   = (p' x d)/|p' x d|          surface normal, constant along the ruling
 *   kappa_g     = ((p' x p'') . n^)/|p'|^3   geodesic curvature of weld A's curve
 *   Psi(theta)  = Psi0 + INT kappa_g |p'| dt developed tangent direction
 *   P(theta)    = P0 + INT |p'|(cos,sin)Psi  developed weld A curve
 *   omega       = atan2(|p' x d|, p'.d)      angle from p' to the ruling
 *   Q(theta)    = P + |d| (cos,sin)(Psi+omega)   developed weld B curve
 *
 * Every integral is the composite 8-point Gauss-Legendre already ported into
 * engine/quad.js -- spectral on the smooth parts, no chord deficit at all.
 *
 * ---------------------------------------------------------------------------
 * ANCHOR EDGE vs DERIVED EDGE -- read this before writing a conservation test.
 *
 * |P'| == |p'| BY CONSTRUCTION, so conservation on weld A's edge is VACUOUS
 * and must never be reported as a passing gate (geometry review 4.1, 8c).
 * Weld A is this panel's ANCHOR edge; weld B is its DERIVED edge. The
 * non-trivial number is
 *
 *     INT |Q'| dtheta   vs   INT |q'(phi)| phi' dtheta
 *
 * which tests the correspondence, the ODE and the quadrature at once. The
 * seam edges are derived too (they cross the rulings) and are measured the
 * same way. engine/checks.js reports exactly these and marks the anchor edge
 * `vacuous: true` so nobody mistakes it for evidence.
 *
 * ---------------------------------------------------------------------------
 * PANEL CONTRACT (consumed by view3d, nest, export, enclosedVolume)
 *
 *   startEdge3D[i] and endEdge3D[i] are THE TWO ENDS OF RULING i.
 *
 * Not "the i-th sample of each edge". The old `enclosedVolume` pairs by index
 * and is correct only because a cone parametrisation makes index i the same
 * generator on both edges; with a non-identity phi that pairing twists and the
 * divergence sum silently returns the volume of a different solid (geometry
 * review 10). Emitting in ruling correspondence is what keeps it honest.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js'); require('./quad.js'); require('./doc.js'); require('./loft.js');
  }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const Q = E.quad;
  const D = E.doc;
  const LOFT = E.loft;

  const TAU = 2 * Math.PI;
  const DEG = Math.PI / 180;

  const DEFAULTS = {
    rulings: 96,      // outline resolution; cutting resolution, not gate resolution
    stations: 128,    // correspondence grid
    seamSamples: 48,  // longitudinal seam and tab band resolution
    quadPanels: 96,   // GL panels for the conservation integrals
  };

  // ------------------------------------------------------------------
  // The development marcher
  // ------------------------------------------------------------------

  /**
   * Develop the lofted surface over a sorted list of theta nodes.
   *
   * Marches Psi and P through the node list with one composite GL-8 panel per
   * interval, using `quad.integrateTo` so the nested Psi needed inside the P
   * integral costs one pass instead of one integration per node.
   *
   * @returns {{nodes, psi, P, at(theta), point(theta, s), frameAt(theta)}}
   */
  function makeDevelopment(lf, nodes) {
    const n = nodes.length;
    const psi = new Float64Array(n);
    const Px = new Float64Array(n);
    const Py = new Float64Array(n);

    // Psi' = kappa_g * |p'|. One station evaluation per quadrature node.
    const psiRate = (t) => {
      const st = lf.station(t);
      return st.kappaG * st.sp;
    };
    const posRate = (t, psiT) => {
      const st = lf.station(t);
      return [st.sp * Math.cos(psiT), st.sp * Math.sin(psiT)];
    };

    psi[0] = 0; Px[0] = 0; Py[0] = 0;
    for (let i = 1; i < n; i++) {
      const a = nodes[i - 1], b = nodes[i];
      const it = Q.integrateTo(psiRate, a, b);
      psi[i] = psi[i - 1] + it.total;
      let sx = 0, sy = 0;
      for (let k = 0; k < it.nodes.length; k++) {
        const pr = posRate(it.nodes[k], psi[i - 1] + it.partial[k]);
        sx += it.weights[k] * pr[0];
        sy += it.weights[k] * pr[1];
      }
      Px[i] = Px[i - 1] + sx;
      Py[i] = Py[i - 1] + sy;
    }

    /** Locate the node at or below theta. */
    function locate(t) {
      let lo = 0, hi = n - 1;
      if (t <= nodes[0]) return 0;
      if (t >= nodes[n - 1]) return n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (nodes[m] <= t) lo = m; else hi = m;
      }
      return lo;
    }

    /**
     * The full developed frame at any theta: developed position of weld A's
     * curve, the developed ruling direction, its length, and the developed
     * position of weld B's curve.
     */
    function at(t) {
      const i = locate(t);
      const a = nodes[i];
      let ps = psi[i], px = Px[i], py = Py[i];
      if (t !== a) {
        const it = Q.integrateTo(psiRate, a, t);
        ps += it.total;
        let sx = 0, sy = 0;
        for (let k = 0; k < it.nodes.length; k++) {
          const pr = posRate(it.nodes[k], psi[i] + it.partial[k]);
          sx += it.weights[k] * pr[0];
          sy += it.weights[k] * pr[1];
        }
        px += sx; py += sy;
      }
      const st = lf.station(t);
      // omega: the angle from p' to the ruling, measured in the tangent plane.
      const omega = Math.atan2(V.len(V.cross(st.p1, st.r)), V.dot(st.p1, st.r));
      const g = ps + omega;
      const ux = Math.cos(g), uy = Math.sin(g);
      return {
        theta: t, psi: ps, omega, gamma: g,
        P: [px, py],
        U: [ux, uy],
        L: st.L,
        Qd: [px + st.L * ux, py + st.L * uy],
        station: st,
      };
    }

    /** Developed image of the surface point (theta, s). */
    function point(t, s, fr) {
      const f = fr || at(t);
      return [f.P[0] + s * f.L * f.U[0], f.P[1] + s * f.L * f.U[1]];
    }

    /** The precomputed frame at node index i (no extra quadrature). */
    function atNode(i) {
      const t = nodes[i];
      const st = lf.station(t);
      const omega = Math.atan2(V.len(V.cross(st.p1, st.r)), V.dot(st.p1, st.r));
      const g = psi[i] + omega;
      const ux = Math.cos(g), uy = Math.sin(g);
      return {
        theta: t, psi: psi[i], omega, gamma: g,
        P: [Px[i], Py[i]], U: [ux, uy], L: st.L,
        Qd: [Px[i] + st.L * ux, Py[i] + st.L * uy],
        station: st,
      };
    }

    return { nodes, psi, Px, Py, at, atNode, point, locate };
  }

  // ------------------------------------------------------------------
  // Conservation: measured on the DERIVED edge, analytically
  // ------------------------------------------------------------------

  /**
   * |Q'| in closed form, from local quantities only.
   *
   * Decomposing q-dot in the tangent-plane basis (m, w) -- and the development
   * being the rigid rolling of that plane -- gives
   *
   *     |Q'|^2 = (qdot . m)^2 + (qdot . w)^2 = |qdot|^2 - (qdot . n^)^2
   *
   * so the developed speed differs from the 3D speed by exactly the component
   * of q-dot off the tangent plane. That component IS the developability
   * residual, which is why this single integral tests the correspondence, the
   * ODE and the quadrature together.
   */
  function derivedEdgeLengths(lf, opts) {
    const o = opts || {};
    const panels = o.quadPanels || DEFAULTS.quadPanels;
    const dev = Q.integrate((t) => {
      const st = lf.station(t);
      const dm = V.dot(st.qdot, st.m), dw = V.dot(st.qdot, st.w);
      return Math.sqrt(dm * dm + dw * dw);
    }, 0, TAU, panels);
    const three = Q.integrate((t) => V.len(lf.station(t).qdot), 0, TAU, panels);
    return { lengthDev: dev, length3D: three, mismatch: Math.abs(dev - three) };
  }

  /** Anchor edge: |P'| == |p'| exactly. Reported, but flagged vacuous. */
  function anchorEdgeLengths(lf, opts) {
    const o = opts || {};
    const panels = o.quadPanels || DEFAULTS.quadPanels;
    const three = Q.integrate((t) => lf.station(t).sp, 0, TAU, panels);
    return { lengthDev: three, length3D: three, mismatch: 0, vacuous: true };
  }

  // ------------------------------------------------------------------
  // One panel
  // ------------------------------------------------------------------

  /**
   * Develop one segment into a flat panel.
   *
   * The panel is the surface between the two welds, opened along the
   * LONGITUDINAL SEAM -- the surface curve joining weld A's seam point to weld
   * B's seam point. Because the seam point lives on the WELD, and both
   * adjacent segments read the same weld, the landing line is continuous
   * across every girth joint BY CONSTRUCTION. That deletes
   * `panels.registerSeams` outright: 68 lines plus a 720-step scan-and-bisect
   * per joint whose only job was to make one global clock angle agree on both
   * sides (architecture review 20).
   */
  function developSegment(seg, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const A = seg.A.weld, B = seg.B.weld;
    const lf = LOFT.loft(A, B, { stations: o.stations, scan: o.scan });

    // Where the seam crosses each weld, as a theta on weld A's parameter.
    const thetaA0 = D.seamParam(A);
    const phiB0 = D.seamParam(B);
    // Choose the lift of thetaB0 nearest thetaA0: the seam runs roughly
    // straight down the tube, so a whole-turn offset would be a different (and
    // wrong) panel. Modular, not a while loop -- a degenerate correspondence
    // can hand back a huge theta and a loop would never come back.
    const rawB0 = lf.thetaAtPhi(phiB0);
    const thetaB0 = isFinite(rawB0) ? thetaA0 + V.wrapPi(rawB0 - thetaA0) : thetaA0;

    // Development nodes: weld A's ruling grid, weld B's ruling grid, and a
    // margin below for the floor tab band (which walks outboard from the seam
    // by up to wrapMaxAngle).
    const R = o.rulings;
    const step = TAU / R;
    const margin = (o.wrapMaxAngle == null ? 80 : o.wrapMaxAngle) * DEG + 2 * step;
    const lo = Math.min(thetaA0, thetaB0) - margin;
    const hi = Math.max(thetaA0, thetaB0) + TAU + step;
    const nodeSet = [];
    for (let i = 0; i <= R; i++) nodeSet.push(thetaA0 + i * step);
    for (let i = 0; i <= R; i++) nodeSet.push(thetaB0 + i * step);
    for (let t = Math.min(thetaA0, thetaB0) - step; t > lo; t -= step) nodeSet.push(t);
    for (let t = Math.max(thetaA0, thetaB0) + TAU + step; t < hi + 1e-12; t += step) nodeSet.push(t);
    nodeSet.sort((x, y) => x - y);
    // Deduplicate, and map EVERY requested value -- including the near-duplicates
    // that get dropped -- to the node that survives.
    //
    // Building `indexOf` from `nodes` instead is a latent crash, and B2 hit it:
    // whenever the two welds' seam parameters coincide to within the dedup
    // epsilon (which they do exactly whenever a segment's two welds are
    // fore/aft reflections of each other -- an entirely ordinary boat), one of
    // thetaA0 / thetaB0 is dropped from `nodes` while the ruling loop still
    // looks it up by exact value. `indexOf.get(t)` then returns undefined,
    // `nodes[undefined]` is undefined, and the correspondence is evaluated at
    // NaN, which surfaces 200 lines away as a TypeError inside loft.phiAt.
    const nodes = [nodeSet[0]];
    const indexOf = new Map([[nodeSet[0], 0]]);
    for (let i = 1; i < nodeSet.length; i++) {
      if (nodeSet[i] - nodes[nodes.length - 1] > 1e-12) nodes.push(nodeSet[i]);
      indexOf.set(nodeSet[i], nodes.length - 1);
    }
    const dev = makeDevelopment(lf, nodes);

    // --- the ruling mesh: startEdge3D[i] and endEdge3D[i] are THE TWO ENDS OF
    // RULING i, both sampled on weld A's theta grid. This is the contract the
    // volume integral and the 3D strip renderer read (geometry review 10).
    const startEdge = new Array(R + 1), endEdge = new Array(R + 1);
    const startEdge3D = new Array(R + 1), endEdge3D = new Array(R + 1);
    const rulings = [];
    for (let i = 0; i <= R; i++) {
      const t = thetaA0 + i * step;
      const fr = dev.atNode(indexOf.get(t));
      startEdge[i] = fr.P.slice();
      endEdge[i] = fr.Qd.slice();
      startEdge3D[i] = fr.station.p;
      endEdge3D[i] = fr.station.q;
      if (i % Math.max(1, Math.round(R / 24)) === 0) rulings.push([fr.P.slice(), fr.Qd.slice()]);
    }

    // --- the panel BOUNDARY edges, which are a different sampling ---
    // Edge A runs from weld A's seam point round to itself; edge B runs from
    // weld B's OWN seam point round to itself. They are not the same theta
    // range, because the seam is a surface curve joining two seam points that
    // the ring's welds each own -- not a ruling. Using the ruling mesh as the
    // outline would silently cut the panel along a ruling instead, moving the
    // landing line off the stored seam of weld B.
    const edgeA = startEdge, edgeA3D = startEdge3D;
    const edgeB = new Array(R + 1), edgeB3D = new Array(R + 1);
    for (let i = 0; i <= R; i++) {
      const t = thetaB0 + i * step;
      const fr = dev.atNode(indexOf.get(t));
      edgeB[i] = fr.Qd.slice();
      edgeB3D[i] = fr.station.q;
    }

    // --- the longitudinal seam ---
    // theta(f) sweeps from weld A's seam to the theta whose ruling lands on
    // weld B's seam, while s sweeps 0 -> 1. Both endpoints are exactly the
    // stored welds' seam points.
    const S = o.seamSamples;
    const seamCurve = new Array(S + 1), seamCurve3D = new Array(S + 1);
    const seamTheta = new Array(S + 1);
    const seamCurveFar = new Array(S + 1);
    for (let i = 0; i <= S; i++) {
      const f = i / S;
      const t = thetaA0 + (thetaB0 - thetaA0) * f;
      seamTheta[i] = t;
      const fr = dev.at(t);
      seamCurve[i] = dev.point(t, f, fr);
      seamCurve3D[i] = V.add(fr.station.p, V.scale(fr.station.r, f));
      const frFar = dev.at(t + TAU);
      seamCurveFar[i] = dev.point(t + TAU, f, frFar);
    }
    // Pin the two ends to the STORED weld seam points rather than to their
    // computed images. They are facts of the document, shared by both adjacent
    // panels, so the landing line closes bit-exactly instead of to a rootfind
    // tolerance -- which is what "mated edges exact by construction" has to
    // mean if it means anything (geometry review 8).
    seamCurve3D[0] = D.weldPoint(A, thetaA0);
    seamCurve3D[S] = D.weldPoint(B, phiB0);

    // --- closed outline ---
    // Edge A forward, seam down at the far end, edge B back, seam up at home.
    const outline = [];
    for (let i = 0; i <= R; i++) outline.push(edgeA[i]);
    for (let i = 1; i <= S; i++) outline.push(seamCurveFar[i]);
    for (let i = R; i >= 0; i--) outline.push(edgeB[i]);
    for (let i = S - 1; i >= 1; i--) outline.push(seamCurve[i]);

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const pt of outline) {
      if (pt[0] < uMin) uMin = pt[0];
      if (pt[0] > uMax) uMax = pt[0];
      if (pt[1] < vMin) vMin = pt[1];
      if (pt[1] > vMax) vMax = pt[1];
    }

    const measure = o.measure !== false;
    const anchor = measure ? anchorEdgeLengths(lf, o) : null;
    const derived = measure ? derivedEdgeLengths(lf, o) : null;

    return {
      id: seg.id,
      index: seg.index,
      role: seg.role,
      selfMirroring: seg.selfMirroring,
      weldA: A.id, weldB: B.id,
      kind: lf.kind, exact: lf.exact,
      loft: lf, dev,
      thetaA0, thetaB0,
      outline, startEdge, endEdge, startEdge3D, endEdge3D, rulings,
      edgeA, edgeA3D, edgeB, edgeB3D,
      seamCurve, seamCurve3D, seamCurveFar, seamTheta,
      seamLength3D: polyLength3D(seamCurve3D),
      seamLengthDev: Q.polylineLength(seamCurve),
      anchorEdge: anchor, derivedEdge: derived,
      bbox: { uMin, uMax, vMin, vMax, width: uMax - uMin, height: vMax - vMin },
    };
  }

  /**
   * The starboard panel of a port panel: reflect in y = 0 and swap start for
   * end, because the ring traverses the starboard side aft-to-fore.
   *
   * THIS IS THE MIRROR (spec 3.4b: "exactly one place in the code performs
   * the mirror" -- the other is doc.mirrorWeld, which produces the welds this
   * consumes). Congruence is EXACT BY CONSTRUCTION: every starboard number is
   * a port number with a sign flipped, so there is no tolerance to blow. A
   * reflection of an isometric development is an isometric development of the
   * reflected surface, so the 2D outline is reflected in v.
   */
  function mirrorPanel(panel, seg) {
    const rv = (p) => [p[0], -p[1]];
    const rev = (arr) => arr.slice().reverse();
    // Ruling mesh: mirroring swaps which end of ruling i is "start", and the
    // pairing survives untouched.
    const startEdge = panel.endEdge.map(rv);
    const endEdge = panel.startEdge.map(rv);
    const startEdge3D = panel.endEdge3D.map(V.mirrorY);
    const endEdge3D = panel.startEdge3D.map(V.mirrorY);
    // Boundary edges: the starboard panel's weld A is M(port's weld B), and
    // both are parametrised identically (doc.mirrorWeld keeps a, b, roll and
    // seam), so the index order carries straight over.
    const edgeA = panel.edgeB.map(rv), edgeA3D = panel.edgeB3D.map(V.mirrorY);
    const edgeB = panel.edgeA.map(rv), edgeB3D = panel.edgeA3D.map(V.mirrorY);
    const seamCurve = rev(panel.seamCurve).map(rv);
    const seamCurve3D = rev(panel.seamCurve3D).map(V.mirrorY);
    const outline = rev(panel.outline).map(rv);
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const pt of outline) {
      if (pt[0] < uMin) uMin = pt[0];
      if (pt[0] > uMax) uMax = pt[0];
      if (pt[1] < vMin) vMin = pt[1];
      if (pt[1] > vMax) vMax = pt[1];
    }
    return {
      id: seg.id,
      index: seg.index,
      role: 'starboard',
      selfMirroring: false,
      mirrorOf: panel.id,
      weldA: seg.A.sourceId, weldB: seg.B.sourceId,
      kind: panel.kind, exact: panel.exact,
      loft: panel.loft, dev: panel.dev,
      thetaA0: panel.thetaB0, thetaB0: panel.thetaA0,
      outline, startEdge, endEdge, startEdge3D, endEdge3D,
      edgeA, edgeA3D, edgeB, edgeB3D,
      rulings: panel.rulings.map((r) => [rv(r[1]), rv(r[0])]),
      seamCurve, seamCurve3D,
      seamCurveFar: rev(panel.seamCurveFar).map(rv),
      seamTheta: panel.seamTheta,
      seamLength3D: panel.seamLength3D,
      seamLengthDev: panel.seamLengthDev,
      anchorEdge: panel.derivedEdge, derivedEdge: panel.anchorEdge,
      bbox: { uMin, uMax, vMin, vMax, width: uMax - uMin, height: vMax - vMin },
    };
  }

  // ------------------------------------------------------------------
  // The floor (spec 3.7, 7.4d)
  // ------------------------------------------------------------------

  /**
   * The floor tab band for one segment: the strip of tube surface running from
   * the landing generator through an arc length `width`, DEVELOPED.
   *
   * Ported in spirit from packraft-core/panels.js `tabBand`, with the one
   * change the general loft forces. Spec 3.7 says to specify arc length and
   * clamp the angle, because a fixed arc converts to very different angles as
   * the radius tapers -- 150 mm is 57 deg amidships and 115 deg near a tip,
   * past the outboard equator where the fabric would have to shrink-wrap.
   *
   * The old code converted arc to angle with `dTheta = width / (l * sinAlpha)`
   * -- a cone-only formula, and first-order besides. There is no `sinAlpha`
   * in the general case (geometry review 31, interaction review's B2 risk),
   * so this solves the arc length properly: the surface speed across the tube
   * at fixed s is |(1-s) p' + s q-dot|, and dTheta is found by Newton on its
   * integral. That is strictly better than the offset AND better than the
   * first-order conversion, and it reduces to the old behaviour on a cone.
   */
  function tabBand(panel, width, maxAngleDeg, samples) {
    const dev = panel.dev, lf = panel.loft;
    const n = samples || panel.seamCurve.length - 1;
    const maxAngle = maxAngleDeg * DEG;
    const inner = [], outer = [], inner3D = [], outer3D = [];
    let minA = Infinity, maxA = -Infinity, clamped = false;

    const speed = (t, s) => {
      const st = lf.station(t);
      return V.len(V.add(V.scale(st.p1, 1 - s), V.scale(st.qdot, s)));
    };

    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const t = panel.thetaA0 + (panel.thetaB0 - panel.thetaA0) * f;
      // Newton on INT_{t-dt}^{t} speed = width.
      let dt = width / Math.max(1e-9, speed(t, f));
      for (let k = 0; k < 4; k++) {
        const got = Q.integrate((x) => speed(x, f), t - dt, t, 8);
        const err = got - width;
        if (Math.abs(err) < 1e-9) break;
        dt -= err / Math.max(1e-9, speed(t - dt, f));
      }
      if (dt > maxAngle) { dt = maxAngle; clamped = true; }
      if (dt < minA) minA = dt;
      if (dt > maxA) maxA = dt;
      // Toward the tube's outboard face: theta decreasing (v points outboard
      // on both sides of the hull -- see engine/doc.js `n` convention).
      const t2 = t - dt;
      inner.push(dev.point(t, f));
      outer.push(dev.point(t2, f));
      const s1 = lf.station(t), s2 = lf.station(t2);
      inner3D.push(V.add(s1.p, V.scale(s1.r, f)));
      outer3D.push(V.add(s2.p, V.scale(s2.r, f)));
    }

    return {
      segmentId: panel.id,
      inner, outer, inner3D, outer3D,
      outline: inner.concat(outer.slice().reverse()),
      minAngleDeg: minA / DEG, maxAngleDeg: maxA / DEG, clamped,
      innerLength3D: polyLength3D(inner3D),
      innerLengthDev: Q.polylineLength(inner),
      outerLength3D: polyLength3D(outer3D),
      outerLengthDev: Q.polylineLength(outer),
    };
  }

  /**
   * The floor panel.
   *
   * The tube lands on the floor along the longitudinal seam, one zone per
   * segment (spec 7.4d). Those zones are 3D and, wherever the hull rises, are
   * LONGER than their plan projections. The floor cannot be cut to the 3D
   * lengths: a flat sheet that keeps the plan-view turning but lengthens every
   * edge does not close. So the floor is cut FLAT -- the plan projection of
   * the landing loop, which closes exactly -- and the surplus becomes EASE,
   * reported per zone for the builder to distribute inside that zone.
   *
   * Landing-line continuity is free here in a way it was not before: the seam
   * point is a property of the WELD, so both adjacent segments land on
   * literally the same 3D point (asserted to 0, not to a tolerance).
   */
  function buildFloor(doc, panels, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const landing3D = [];
    const zones = [];
    for (const panel of panels) {
      const curve = panel.seamCurve3D;
      const a = curve[0], b = curve[curve.length - 1];
      if (!landing3D.length) landing3D.push(a);
      landing3D.push(b);
      zones.push({ segmentId: panel.id, length3D: panel.seamLength3D, chord3D: V.dist(a, b) });
    }
    const outlinePts = landing3D.slice(0, -1).map((q) => [q[0], q[1]]);

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      z.id = 'Z' + (i + 1);
      z.from = outlinePts[i];
      z.to = outlinePts[(i + 1) % outlinePts.length];
      z.lengthFlat = Math.hypot(z.to[0] - z.from[0], z.to[1] - z.from[1]);
      z.ease = z.length3D - z.lengthFlat;
      z.easePercent = (100 * z.ease) / z.lengthFlat;
      // At the tips the landing zones converge to the centreplane, so these
      // are triangular rather than quadrilateral -- where a naive quad-strip
      // generator breaks (spec 7.4d).
      z.triangular = Math.abs(z.from[1]) < 1e-6 || Math.abs(z.to[1]) < 1e-6;
    }

    const bands = panels.map((p) => tabBand(p, doc.floor.tabWidth,
      doc.floor.wrapMaxAngle, o.seamSamples));

    // Closure of the landing loop, in 3D. Zero by construction: consecutive
    // panels read the same weld's seam point.
    let landingStep = 0;
    for (let i = 0; i < panels.length; i++) {
      const a = panels[i].seamCurve3D[panels[i].seamCurve3D.length - 1];
      const b = panels[(i + 1) % panels.length].seamCurve3D[0];
      landingStep = Math.max(landingStep, V.dist(a, b));
    }

    return {
      id: 'FLOOR', role: 'floor',
      outline: outlinePts, landing3D, zones, bands,
      clockAngle: doc.floor.clockAngle,
      tabWidth: doc.floor.tabWidth,
      landingStep,
      perimeter3D: zones.reduce((t, z) => t + z.length3D, 0),
      perimeterFlat: zones.reduce((t, z) => t + z.lengthFlat, 0),
      totalEase: zones.reduce((t, z) => t + z.ease, 0),
      maxZoneEase: zones.reduce((m, z) => Math.max(m, z.ease), 0),
      netArea: Math.abs(signedArea(outlinePts)),
      anyBandClamped: bands.some((b) => b.clamped),
    };
  }

  // ------------------------------------------------------------------
  // Whole boat
  // ------------------------------------------------------------------

  /**
   * Develop the entire document.
   *
   * Only the PORT segments and any self-mirroring SPAN are lofted. Starboard
   * panels are reflections of their port sources, so port/starboard congruence
   * is exact by construction rather than by tolerance -- and the loft cost is
   * halved, which is the same dividend spec 3.4b claims for the old engine.
   */
  function build(doc, opts) {
    const o = Object.assign({ wrapMaxAngle: doc.floor.wrapMaxAngle }, DEFAULTS, opts || {});
    const r = D.ring(doc);
    const panels = new Array(r.segments.length);
    for (const seg of r.segments) {
      if (seg.role === 'port' || seg.role === 'span') {
        panels[seg.index] = developSegment(seg, o);
      }
    }
    const portPanels = r.segments.filter((s) => s.role === 'port')
      .map((s) => panels[s.index]);
    for (const seg of r.segments) {
      if (seg.role === 'starboard') {
        panels[seg.index] = mirrorPanel(portPanels[seg.sourceSegment], seg);
      }
    }
    const floor = buildFloor(doc, panels, o);
    return {
      doc, ring: r, panels, floor,
      labels: D.labels(doc, r),
      volume: enclosedVolume(panels),
    };
  }

  /**
   * Volume enclosed by the tube ring, mm^3 (spec 5.1), by the divergence
   * theorem over the ruling quads. The ring is topologically a torus, so the
   * surface is already closed -- no caps, nothing to stitch, and the sum is
   * the EXACT volume of the faceted solid that actually gets built.
   *
   * Pairs by RULING, not by sample index: see the panel contract at the top.
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

  function signedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  const api = {
    DEFAULTS, makeDevelopment, developSegment, mirrorPanel,
    anchorEdgeLengths, derivedEdgeLengths,
    tabBand, buildFloor, build, enclosedVolume, signedArea, polyLength3D,
  };

  E.develop2 = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
