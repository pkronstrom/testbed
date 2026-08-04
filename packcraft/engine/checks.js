/**
 * engine/checks.js -- gates as data.
 *
 * ---------------------------------------------------------------------------
 * POLICY: EDITING NEVER BLOCKS. EXPORT DOES.
 *
 * The plan said "report, never block" everywhere, and then said B5's
 * developability check "gates the mouse". Both cannot be true, and neither is
 * quite right (geometry review 3):
 *
 *   - Blocking an EDIT is wrong. A half-finished boat is a legitimate document;
 *     the handle turns red and explains, the pointer keeps moving.
 *   - Blocking an EXPORT is mandatory. If the developability check fails, the
 *     surface is not developable, the "pattern" is not an isometric image of
 *     anything, and the export is a lie that looks like a cutting pattern.
 *     That is the one promise this whole project makes.
 *
 * So every issue carries `blocksExport`. `exportGate()` collects the ones that
 * do. Nothing here ever throws and nothing here ever refuses an edit.
 *
 * ---------------------------------------------------------------------------
 * TWO TIERS OF TOLERANCE, and they have different jobs (user direction, and
 * docs/engine-plan-sections-and-manual-mode.md "Tolerance philosophy").
 *
 *   tier: 'math'    Catches BUGS, not fabric. Kept as tight as the method
 *                   makes CHEAP. Closed-form branches stay at 1e-6 relative
 *                   because it is free. Numerical lofts and the
 *                   geodesic-curvature development gate at 0.02 mm -- 50-100x
 *                   below anything a builder can hold.
 *
 *   tier: 'fabric'  Speaks to the builder. A packraft is printed on a home
 *                   printer, taped, traced, cut with scissors and welded with
 *                   an iron: ±1-5 mm. A 2 mm seam-length mismatch is gathered
 *                   in without comment; 5 mm shows as wrinkles.
 *
 * DO NOT "fix" a 0.02 mm math gate down to 1e-6. That precision is meaningless
 * for scissors-and-iron construction and buying it back through a numerical
 * path costs ~50 000 rulings per panel (geometry review finding 4's measured
 * table). The measured margins are recorded in tests/engine.test.js so the
 * headroom is visible rather than folklore.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js'); require('./quad.js'); require('./doc.js');
    require('./loft.js'); require('./develop2.js');
  }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const Q = E.quad;
  const D = E.doc;
  const DV = E.develop2;

  const TAU = 2 * Math.PI;

  const TOL = {
    /** Closed-form branches: relative. Free, so keep it. */
    CONSERVATION_EXACT_REL: 1e-6,
    /** Numerical branches: absolute mm. 50-100x below the fabric floor. */
    CONSERVATION_MM: 0.02,
    /** Development quadrature, by Richardson between two node densities, mm. */
    REFINEMENT_MM: 0.02,
    /** Mated developed lengths, kernel gate, mm. */
    MATED_MM: 0.02,
    /** Mated seam length, fabric tiers, mm. */
    MATED_FABRIC_ADVISORY_MM: 2,
    MATED_FABRIC_WARN_MM: 5,
    /** Torsality residual on UNIT vectors -- dimensionless. */
    TORSALITY: 1e-6,
    /** Ruling obliquity: |d^ . n^_weld| must clear this. */
    OBLIQUITY: 0.02,
    /** Closure/holonomy residual, mm. */
    CLOSURE_MM: 0.02,
  };

  const issue = (o) => Object.assign({
    level: 'ok', tier: 'math', blocksExport: false,
    value: null, tolerance: null, where: null,
  }, o);

  /**
   * A rigorous UPPER bound on how far a weld's section reaches from its centre,
   * as a multiple of the base ellipse's reach in the same direction.
   *
   * Two checks below -- `interleave` and `cutConsumption` -- measure a weld's
   * SUPPORT in one direction from `a`, `b` and the rolled axes. That is exact
   * for an ellipse and wrong for a profiled section, so both scale it by this.
   * A B-spline lies inside the convex hull of its coefficients, so
   * 1 + max(k) bounds 1 + s(t) everywhere with no sampling and no error term;
   * the bound is tight when the profile's peak sits at a knot and slightly
   * generous otherwise, which is the direction a buildability check should err
   * in. When the profile SHRINKS the section (max(k) < 0) the smaller support
   * is not a relaxation, it is the truth -- a smaller curve really is easier to
   * clear.
   */
  function radialBound(fr) {
    return fr.profile ? Math.max(0, 1 + fr.profile.hullMax) : 1;
  }

  // ------------------------------------------------------------------
  // 1. Conservation -- on the DERIVED edge only
  // ------------------------------------------------------------------

  /**
   * The anchor edge is VACUOUS and is reported as such.
   *
   * Under the geodesic-curvature development |P'| == |p'| identically, so
   * "the developed anchor edge has the same length as the 3D anchor edge" is
   * a statement about arithmetic, not about the engine. The geometry review
   * (4.1) is explicit that reporting it as a passing gate turns G0.6b into a
   * tautology. The real number is the DERIVED edge -- and it tests the
   * correspondence, the ODE and the quadrature at once, because
   *
   *     |Q'|^2 = |qdot|^2 - (qdot . n^)^2
   *
   * so the whole discrepancy is the component of qdot off the tangent plane.
   */
  function conservation(panel) {
    const out = [];
    const exact = panel.exact;
    if (panel.anchorEdge) {
      out.push(issue({
        id: 'conservation.anchor',
        level: 'ok', vacuous: true,
        message: 'anchor edge conservation is exact by construction '
          + '(|P\'| == |p\'|) and is NOT evidence',
        value: 0, where: { panel: panel.id, weld: panel.weldA },
      }));
    }
    if (panel.derivedEdge) {
      const m = panel.derivedEdge.mismatch;
      const rel = m / Math.max(1e-12, panel.derivedEdge.length3D);
      const pass = exact
        ? rel <= TOL.CONSERVATION_EXACT_REL
        : m <= TOL.CONSERVATION_MM;
      out.push(issue({
        id: 'conservation.derived',
        level: pass ? 'ok' : 'error',
        blocksExport: !pass,
        message: pass
          ? 'derived edge conserves arc length'
          : 'derived edge loses ' + m.toFixed(6) + ' mm of arc length in the '
            + 'development -- the surface is not an isometry of the pattern',
        value: m, relative: rel,
        tolerance: exact ? TOL.CONSERVATION_EXACT_REL : TOL.CONSERVATION_MM,
        toleranceKind: exact ? 'relative' : 'mm',
        branch: panel.kind,
        where: { panel: panel.id, weld: panel.weldB },
      }));
    }
    return out;
  }

  /**
   * Development quadrature error, by Richardson: march the same loft at two
   * node densities and compare the developed positions.
   *
   * This is the one measurement that tests the MARCHER rather than the local
   * algebra -- exactly what the geometry review asks for ("refined until two
   * resolutions agree by Richardson at the observed order"). The composite
   * GL-8 is spectral on these integrands, so the observed order is "converged
   * at 48 nodes"; the gate exists to notice if that ever stops being true.
   */
  function refinement(panel, opts) {
    const o = opts || {};
    const coarse = o.coarse || 48;
    const lf = panel.loft;
    const t0 = panel.thetaA0;
    const mk = (R) => {
      const nodes = [];
      for (let i = 0; i <= R; i++) nodes.push(t0 + TAU * i / R);
      return DV.makeDevelopment(lf, nodes);
    };
    const A = mk(coarse), B = mk(2 * coarse);
    let worst = 0;
    for (let i = 0; i <= coarse; i++) {
      const a = A.atNode(i), b = B.atNode(2 * i);
      worst = Math.max(worst,
        Math.hypot(a.P[0] - b.P[0], a.P[1] - b.P[1]),
        Math.hypot(a.Qd[0] - b.Qd[0], a.Qd[1] - b.Qd[1]));
    }
    const pass = worst <= TOL.REFINEMENT_MM;
    return issue({
      id: 'development.refinement',
      level: pass ? 'ok' : 'error',
      blocksExport: !pass,
      message: pass
        ? 'development converged'
        : 'development moves ' + worst.toFixed(4) + ' mm between node densities '
          + coarse + ' and ' + (2 * coarse),
      value: worst, tolerance: TOL.REFINEMENT_MM, toleranceKind: 'mm',
      where: { panel: panel.id },
    });
  }

  // ------------------------------------------------------------------
  // 2. Developability
  // ------------------------------------------------------------------

  /**
   * Torsality residual on UNIT vectors: max |det[p^', q^', w^]|.
   *
   * The geometry review's check 5. A dimensionless statement that the surface
   * IS developable, caught directly rather than inferred from a downstream
   * symptom. This is the gate that blocks export.
   */
  function torsality(panel) {
    const r = panel.loft.correspondence.maxTorsalResidual;
    const pass = r <= TOL.TORSALITY;
    return issue({
      id: 'developability.torsality',
      level: pass ? 'ok' : 'error',
      blocksExport: !pass,
      message: pass
        ? 'surface is torsal (developable)'
        : 'ruling correspondence leaves a torsality residual of '
          + r.toExponential(2) + ' -- this surface is not developable and its '
          + '"pattern" is not an isometry of anything',
      value: r, tolerance: TOL.TORSALITY, toleranceKind: 'unit',
      where: { panel: panel.id },
    });
  }

  /**
   * Crossing rulings, exactly (geometry review 7).
   *
   * With w^ the unit ruling and m^ = n^ x w^ the in-tangent-plane direction
   * across it,
   *
   *     aPerp = p' . m^,   bPerp = phi' q'(phi) . m^,
   *     t*    = aPerp / (aPerp - bPerp)
   *
   * and the edge of regression falls on the patch iff t* is in [0, 1]. So
   *
   *     NO CROSSING  <=>  aPerp * bPerp > 0
   *
   * with t* -> +-inf the cylindrical case, which is fine. `margin` is
   * min_theta dist(t*, [0,1]) -- one scalar, degrading continuously as the
   * design gets worse, which is what a handle-painting advisory needs.
   *
   * The old spec 3.4 rule L > r(tan(phi1/2) + tan(phi2/2)) does NOT port:
   * there is no r and no scalar turn angle in the weld-first model. See
   * `cutConsumption` for its restatement.
   */
  function crossingRulings(panel, samples) {
    const N = samples || 360;
    const lf = panel.loft;
    let margin = Infinity, worstTheta = 0, crossings = 0;
    for (let i = 0; i < N; i++) {
      const t = panel.thetaA0 + TAU * i / N;
      const st = lf.station(t);
      const aPerp = V.dot(st.p1, st.w);
      const bPerp = V.dot(st.qdot, st.w);
      const den = aPerp - bPerp;
      let dist;
      if (Math.abs(den) < 1e-15) dist = Infinity;          // cylindrical
      else {
        const tStar = aPerp / den;
        dist = tStar < 0 ? -tStar : (tStar > 1 ? tStar - 1 : 0);
        if (dist === 0) crossings++;
      }
      if (dist < margin) { margin = dist; worstTheta = t; }
    }
    const pass = crossings === 0;
    return issue({
      id: 'developability.crossing',
      level: pass ? (margin < 0.05 ? 'warn' : 'ok') : 'error',
      blocksExport: !pass,
      message: pass
        ? (margin < 0.05
          ? 'rulings nearly cross (regression margin ' + margin.toFixed(4) + ')'
          : 'rulings do not cross')
        : 'rulings cross on ' + crossings + ' of ' + N + ' stations -- the '
          + 'surface folds and the panel would crease',
      value: margin, tolerance: 0, toleranceKind: 'margin',
      where: { panel: panel.id, theta: worstTheta },
    });
  }

  /**
   * Ruling obliquity at each weld: min |d^ . n^_weld|, and of consistent sign
   * around the whole weld. "The tube must actually leave the weld" -- what
   * spec 3.4's cut-consumption becomes locally, and what fails first at
   * strongly raked welds (geometry review 7).
   */
  function obliquity(panel, samples) {
    const N = samples || 180;
    const lf = panel.loft;
    let minA = Infinity, minB = Infinity, signA = 0, signB = 0, flipped = false;
    for (let i = 0; i < N; i++) {
      const t = panel.thetaA0 + TAU * i / N;
      const st = lf.station(t);
      const da = V.dot(st.m, lf.A.n), db = V.dot(st.m, lf.B.n);
      if (i === 0) { signA = Math.sign(da); signB = Math.sign(db); }
      if (Math.sign(da) !== signA || Math.sign(db) !== signB) flipped = true;
      minA = Math.min(minA, Math.abs(da));
      minB = Math.min(minB, Math.abs(db));
    }
    const worst = Math.min(minA, minB);
    const pass = worst >= TOL.OBLIQUITY && !flipped;
    return issue({
      id: 'developability.obliquity',
      level: pass ? 'ok' : 'warn',
      message: pass
        ? 'rulings leave both welds cleanly'
        : (flipped
          ? 'the rulings leave one weld on both sides of its plane -- the '
            + 'segment tapers past its own cut'
          : 'rulings graze a weld plane (min |d.n| = ' + worst.toFixed(4) + ')'),
      value: worst, tolerance: TOL.OBLIQUITY, toleranceKind: 'unit',
      where: { panel: panel.id, weldA: panel.weldA, weldB: panel.weldB },
    });
  }

  /**
   * Weld planes must not interleave: the line where the two weld planes meet
   * must lie strictly OUTSIDE both weld curves. If it passes through either
   * ellipse, no non-self-intersecting developable connects them at all
   * (geometry review 7). This is the exact form of spec 3.4's buildability
   * constraint, and it is a two-line test.
   */
  function interleave(panel) {
    const A = panel.loft.A, B = panel.loft.B;
    const dir = V.cross(A.n, B.n);
    const dl = V.len(dir);
    if (dl < 1e-12) {
      return issue({ id: 'developability.interleave', level: 'ok',
        message: 'weld planes are parallel; they cannot interleave',
        value: Infinity, where: { panel: panel.id } });
    }
    const d = V.scale(dir, 1 / dl);
    // A point on the intersection line: solve the 2x2 system in the plane
    // spanned by nA, nB.
    const nAB = V.dot(A.n, B.n);
    const dA = V.dot(A.n, A.c), dB = V.dot(B.n, B.c);
    const det = 1 - nAB * nAB;
    const cA = (dA - dB * nAB) / det, cB = (dB - dA * nAB) / det;
    const p0 = V.add(V.scale(A.n, cA), V.scale(B.n, cB));

    const clear = (W) => {
      const f = D.weldFrame(W);
      // In W's plane the line runs along the projection of d; the ellipse's
      // support perpendicular to it is sqrt((a e1.u^)^2 + (b e2.u^)^2).
      const inPlane = V.norm(V.reject(d, W.n));
      const perp = V.cross(W.n, inPlane);
      const h = radialBound(f)
        * Math.hypot(W.a * V.dot(f.e1, perp), W.b * V.dot(f.e2, perp));
      const off = Math.abs(V.dot(V.sub(p0, W.c), perp));
      return off - h;
    };
    const m = Math.min(clear(A), clear(B));
    const pass = m > 0;
    return issue({
      id: 'developability.interleave',
      level: pass ? 'ok' : 'error',
      blocksExport: !pass,
      message: pass
        ? 'weld planes meet outside both weld curves'
        : 'the weld planes intersect INSIDE a weld curve (' + m.toFixed(2)
          + ' mm) -- no non-self-intersecting developable connects them',
      value: m, tolerance: 0, toleranceKind: 'mm',
      where: { panel: panel.id },
    });
  }

  /** Correspondence conditioning: monotone, winding 1, Newton slope margin. */
  function conditioning(panel) {
    const co = panel.loft.correspondence;
    const out = [];
    out.push(issue({
      id: 'correspondence.monotone',
      level: co.monotone ? 'ok' : 'error',
      blocksExport: !co.monotone,
      message: co.monotone
        ? 'phi(theta) is monotone'
        : 'phi(theta) is NOT monotone (min step ' + co.minStep.toExponential(2)
          + ') -- the branch tracker crossed onto the antipodal root',
      value: co.monotoneMargin, tolerance: 0, toleranceKind: 'rad',
      where: { panel: panel.id },
    }));
    const windOK = Math.abs(co.winding - 1) < 1e-6;
    out.push(issue({
      id: 'correspondence.winding',
      level: windOK ? 'ok' : 'error',
      blocksExport: !windOK,
      message: windOK ? 'winding number is 1'
        : 'winding number is ' + co.winding.toFixed(6) + ', not 1 -- the two '
          + 'welds are parametrised opposite ways round, so a weld normal is '
          + 'not pointing along ring traversal',
      value: co.winding, tolerance: 1, toleranceKind: 'turns',
      where: { panel: panel.id },
    }));
    for (const f of co.failures) {
      out.push(issue({
        id: f.id, level: 'error', blocksExport: true,
        message: f.message, where: { panel: panel.id, theta: f.theta },
      }));
    }
    return out;
  }

  /**
   * Closure / holonomy (geometry review 9).
   *
   * The seam curve appears TWICE in the developed outline -- once at theta0,
   * once at theta0 + 2pi -- and the two are images of the same 3D curve under
   * the same isometry. They must therefore be congruent plane curves. Fitting
   * the rigid motion between them and measuring the residual tests the
   * correspondence, the ODE integration, the quadrature and the node placement
   * simultaneously. It is the only check in the suite that would catch a
   * globally-consistent-but-wrong development.
   */
  function closure(panel) {
    const a = panel.seamCurve, b = panel.seamCurveFar;
    const r = fitRigid2(a, b);
    const pass = r.residual <= TOL.CLOSURE_MM;
    return issue({
      id: 'closure.holonomy',
      level: pass ? 'ok' : 'error',
      blocksExport: !pass,
      message: pass
        ? 'the seam develops congruently at both ends of the sweep'
        : 'the two developed images of the seam differ by '
          + r.residual.toFixed(4) + ' mm after a best-fit rigid motion',
      value: r.residual, tolerance: TOL.CLOSURE_MM, toleranceKind: 'mm',
      rotation: r.angle,
      where: { panel: panel.id },
    });
  }

  /** 2D Procrustes without scaling: the rigid motion taking P onto Qp. */
  function fitRigid2(P, Qp) {
    const n = Math.min(P.length, Qp.length);
    let cx = 0, cy = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      cx += P[i][0]; cy += P[i][1]; dx += Qp[i][0]; dy += Qp[i][1];
    }
    cx /= n; cy /= n; dx /= n; dy /= n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const ax = P[i][0] - cx, ay = P[i][1] - cy;
      const bx = Qp[i][0] - dx, by = Qp[i][1] - dy;
      sxx += ax * bx + ay * by;
      sxy += ax * by - ay * bx;
    }
    const ang = Math.atan2(sxy, sxx);
    const c = Math.cos(ang), s = Math.sin(ang);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const ax = P[i][0] - cx, ay = P[i][1] - cy;
      const rx = c * ax - s * ay + dx, ry = s * ax + c * ay + dy;
      worst = Math.max(worst, Math.hypot(rx - Qp[i][0], ry - Qp[i][1]));
    }
    return { angle: ang, residual: worst };
  }

  // ------------------------------------------------------------------
  // 3. Mated edges
  // ------------------------------------------------------------------

  /**
   * Mated edges (geometry review 8).
   *
   * (a) EXACT BY CONSTRUCTION, and this really is exact: both panels bound the
   *     same stored weld record, so the 3D curve is bit-identical and the
   *     landing point they share is bit-identical. Asserted against 0, not
   *     against a tolerance.
   * (b) DEVELOPED LENGTHS are two different numerical objects. Each shared
   *     weld is the ANCHOR edge of exactly one of its two panels and the
   *     DERIVED edge of the other, so the reported number is one-sided and
   *     informative rather than order-dependent noise.
   * (c) FABRIC TIER: a mismatch a builder could not hold is not the same event
   *     as a mismatch that means the kernel is broken. Both are reported, with
   *     their tier.
   */
  function matedEdges(built) {
    const panels = built.panels;
    const out = [];
    const n = panels.length;
    for (let i = 0; i < n; i++) {
      const a = panels[i], b = panels[(i + 1) % n];
      // (a) the shared landing point, exactly.
      const pa = a.seamCurve3D[a.seamCurve3D.length - 1];
      const pb = b.seamCurve3D[0];
      const step = V.dist(pa, pb);
      out.push(issue({
        id: 'mated.identity',
        level: step === 0 ? 'ok' : (step < 1e-9 ? 'warn' : 'error'),
        blocksExport: step >= 1e-9,
        message: step === 0
          ? 'both panels land on literally the same weld seam point'
          : 'the landing line steps ' + step.toExponential(2) + ' mm at this joint',
        value: step, tolerance: 0, toleranceKind: 'mm',
        where: { a: a.id, b: b.id, weld: a.weldB },
      }));
      // (b) developed lengths of the shared weld curve.
      const la = a.derivedEdge ? a.derivedEdge.lengthDev : null;
      const lb = b.anchorEdge ? b.anchorEdge.lengthDev : null;
      if (la != null && lb != null) {
        const m = Math.abs(la - lb);
        const pass = m <= TOL.MATED_MM;
        out.push(issue({
          id: 'mated.length',
          level: pass ? 'ok' : 'error',
          blocksExport: false,
          message: pass
            ? 'mated developed lengths agree'
            : 'mated developed lengths differ by ' + m.toFixed(5) + ' mm',
          value: m, tolerance: TOL.MATED_MM, toleranceKind: 'mm',
          where: { a: a.id, b: b.id, weld: a.weldB },
        }));
        // (c) fabric tier.
        let lvl = 'ok', msg = 'mating seams are the same length to the fabric';
        if (m > TOL.MATED_FABRIC_WARN_MM) {
          lvl = 'warn';
          msg = 'mating seams differ by ' + m.toFixed(1) + ' mm -- visible wrinkles';
        } else if (m > TOL.MATED_FABRIC_ADVISORY_MM) {
          lvl = 'advisory';
          msg = 'mating seams differ by ' + m.toFixed(1) + ' mm -- gather it in';
        }
        out.push(issue({
          id: 'mated.fabric', tier: 'fabric', level: lvl, message: msg,
          value: m, tolerance: TOL.MATED_FABRIC_ADVISORY_MM, toleranceKind: 'mm',
          where: { a: a.id, b: b.id, weld: a.weldB },
        }));
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 4. Spec 3.4 cut consumption, restated weld-first
  // ------------------------------------------------------------------

  /**
   * Spec 3.4's buildability constraint, re-derived for welds.
   *
   * The spec form is `L_segment > r*(tan(phi1/2) + tan(phi2/2))`, which
   * presumes a circular tube of radius r turning by a scalar angle phi. In the
   * weld-first model there is no r and no turn angle, so the check does not
   * port -- it must be restated (geometry review 7).
   *
   * The general statement: each weld's cut ellipse REACHES along the segment
   * axis by
   *
   *     reach = sqrt( (a * e1.axis)^2 + (b * e2.axis)^2 )
   *
   * and the two ends must not eat the segment:
   *
   *     |c_B - c_A| > reach_A + reach_B
   *
   * This reduces to the spec form exactly. For a circular tube of radius r
   * mitred at half-turn rho, the template sets a = r/cos(rho) with e1 along
   * the projected axis, so e1.axis = sin(rho), e2.axis = 0, and
   * reach = r tan(rho) = r tan(phi/2). Same rule, no circular assumption.
   */
  function cutConsumption(built) {
    const out = [];
    for (const seg of built.ring.segments) {
      const A = seg.A.weld, B = seg.B.weld;
      const axis = V.norm(V.sub(B.c, A.c));
      const L = V.dist(A.c, B.c);
      const reach = (W) => {
        const f = D.weldFrame(W);
        return radialBound(f)
          * Math.hypot(W.a * V.dot(f.e1, axis), W.b * V.dot(f.e2, axis));
      };
      const rA = reach(A), rB = reach(B);
      const need = rA + rB;
      const slack = L - need;
      const pass = slack > 0;
      out.push(issue({
        id: 'spec3.4.cutConsumption',
        level: pass ? (slack < 0.15 * need ? 'advisory' : 'ok') : 'error',
        tier: pass && slack < 0.15 * need ? 'fabric' : 'math',
        blocksExport: false,
        message: pass
          ? (slack < 0.15 * need
            ? 'segment is only ' + slack.toFixed(0) + ' mm longer than its own '
              + 'two mitre cuts consume -- tight to build'
            : 'segment survives its own cuts')
          : 'segment is ' + (-slack).toFixed(0) + ' mm SHORTER than its two '
            + 'mitre cuts consume (spec 3.4): the cuts overlap',
        value: slack, tolerance: 0, toleranceKind: 'mm',
        segmentLength: L, consumed: need,
        where: { panel: seg.id, weldA: A.id, weldB: B.id },
      }));
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 5. Symmetry, and the whole report
  // ------------------------------------------------------------------

  /**
   * Port/starboard congruence. Exact by REPRESENTATION: the document stores
   * the port half only and starboard panels are reflections of their port
   * sources, so there is no tolerance to blow. Measured anyway, because "by
   * construction" claims are how silent bugs hide.
   */
  function symmetry(built) {
    const out = [];
    for (const p of built.panels) {
      if (p.role !== 'starboard') continue;
      const src = built.panels.find((x) => x.id !== p.id && x.role === 'port'
        && x.id === p.mirrorOf);
      if (!src) continue;
      let worst = 0;
      const n = Math.min(p.outline.length, src.outline.length);
      for (let i = 0; i < n; i++) {
        const a = src.outline[n - 1 - i], b = p.outline[i];
        worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] + b[1]));
      }
      out.push(issue({
        id: 'symmetry.congruence',
        level: worst === 0 ? 'ok' : 'error',
        blocksExport: worst !== 0,
        message: worst === 0
          ? 'starboard panel is the exact reflection of its port source'
          : 'starboard panel deviates from its port source by ' + worst,
        value: worst, tolerance: 0, toleranceKind: 'mm',
        where: { panel: p.id, mirrorOf: p.mirrorOf },
      }));
    }
    return out;
  }

  /**
   * The whole report, as data.
   *
   * @param {object} built output of develop2.build
   * @param {{refine?:boolean}} [opts] `refine` runs the Richardson check,
   *   which costs a second development per panel -- verify pass, not live.
   */
  function report(built, opts) {
    const o = opts || {};
    const issues = [];
    for (const i of D.validate(built.doc)) {
      issues.push(issue({ id: 'doc.' + i.id, level: i.level, message: i.message,
        where: { weld: i.weldId } }));
    }
    for (const p of built.panels) {
      if (p.role === 'starboard') continue;  // exact reflections; see symmetry()
      issues.push(...conservation(p));
      issues.push(torsality(p));
      issues.push(crossingRulings(p));
      issues.push(obliquity(p));
      issues.push(interleave(p));
      issues.push(...conditioning(p));
      issues.push(closure(p));
      if (o.refine !== false) issues.push(refinement(p, o));
    }
    issues.push(...matedEdges(built));
    issues.push(...cutConsumption(built));
    issues.push(...symmetry(built));

    const by = (lvl) => issues.filter((i) => i.level === lvl);
    const blockers = issues.filter((i) => i.blocksExport && i.level === 'error');
    return {
      issues,
      summary: {
        ok: by('ok').length, advisory: by('advisory').length,
        warn: by('warn').length, error: by('error').length,
      },
      exportAllowed: blockers.length === 0,
      blockers,
    };
  }

  /**
   * The export gate. Editing never blocks; export does.
   *
   * A failing document can be saved, shared, undone and edited. It cannot emit
   * a cutting pattern, because a non-developable "pattern" is not an isometry
   * of anything and the whole promise of this project is that it is.
   */
  function exportGate(rep) {
    return {
      allowed: rep.exportAllowed,
      blockers: rep.blockers,
      message: rep.exportAllowed
        ? 'patterns are exact developments of the as-designed surface'
        : 'export refused: ' + rep.blockers.length + ' developability gate(s) '
          + 'failed -- the panels would not be an isometry of this boat',
    };
  }

  const api = {
    TOL, issue, radialBound, conservation, refinement, torsality, crossingRulings,
    obliquity, interleave, conditioning, closure, fitRigid2,
    matedEdges, cutConsumption, symmetry, report, exportGate,
  };

  E.checks = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
