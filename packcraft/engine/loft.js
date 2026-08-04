/**
 * engine/loft.js -- the developable surface between two consecutive welds.
 *
 * A segment is not stored. It is the ruled surface
 *
 *     S(theta, s) = (1 - s) * p(theta) + s * q(phi(theta)),   s in [0, 1]
 *
 * where p is weld A's curve, q is weld B's, and phi is the RULING
 * CORRESPONDENCE. The surface is developable (torsal) iff every ruling has one
 * tangent plane along its whole length, i.e.
 *
 *     F(theta, phi) = det[ p'(theta), q'(phi), q(phi) - p(theta) ] = 0.
 *
 * ---------------------------------------------------------------------------
 * FOUR BRANCHES, THREE OF THEM CLOSED FORM. All from notes/plan-review-geometry.md.
 *
 * 1. MIRROR PAIR (finding 1b). If weld B is weld A reflected in y = 0 -- the
 *    bridge span at a `panel-on-axis` tip, and the oblong nose -- the exact
 *    surface is the y-EXTRUSION of the weld's xz-projection, a generalized
 *    cylinder. With this engine's mirror convention (engine/doc.js
 *    `mirrorWeld`) the correspondence is phi = theta and the ruling is
 *    parallel to y, EXACTLY. The review states this as phi = pi - theta
 *    because it parametrises the mirrored weld the other way round; the
 *    geometry is the same and the test pins ours to ~1e-11 relative.
 *
 *    This case matters far beyond tidiness: the mirror pair is the one place
 *    where the two curves are IDENTICALLY shaped, so a naive shape-similarity
 *    test fires and builds the wrong surface (review finding 1b), and a
 *    generic continuation tracker can return a non-equivariant branch, which
 *    silently breaks "one part, not an L/R pair" (finding 18).
 *
 * 2. PARALLEL PLANES (finding 6b). When n_A and n_B are parallel, everything
 *    reduces to p' parallel to q', which is closed form:
 *
 *        phi = atan2( a1*b2*sin(t)*cos(D) - b1*b2*cos(t)*sin(D),
 *                     a1*a2*sin(t)*sin(D) + a2*b1*cos(t)*cos(D) )
 *
 *    with D = roll_B - roll_A. For D = 0 this is the review's
 *    tan(phi) = (a1*b2)/(a2*b1) * tan(theta), branch fixed by
 *    sign(cos phi) = sign(cos theta). NO ROOTFIND, no branch ambiguity.
 *
 * 3. HOMOTHETIC + PARALLEL => generalized CONE or CYLINDER, a sub-case of (2)
 *    with phi = theta. Reported as `kind` and used by engine/cone.js for the
 *    closed-form cross-check.
 *
 *    NOTE the trap this replaces. "Two SIMILAR plane ellipses -> generalized
 *    cone" (the plan's original wording) is FALSE without plane parallelism:
 *    at 2.9 degrees of tilt the six rulings miss a common apex by 2.31 mm,
 *    230x TOL_MATED_EDGE. And the converse fails too -- the existing engine's
 *    weld pairs are exactly co-conical while having aspect ratios 2.03 and
 *    1.02, so a similarity test fires on NONE of them. Conicality is
 *    therefore detected A POSTERIORI, by fitting an apex to the solved
 *    rulings (`fitApex`), which is the only test that can fire correctly.
 *
 * 4. GENERAL: branch-continued Newton. There are at least TWO roots at every
 *    station and the determinant cannot tell them apart -- in the coaxial
 *    circular case F = R_A*R_B*L*sin(phi - theta), whose roots phi = theta and
 *    phi = theta + pi are both simple (interaction review 12). The antipodal
 *    branch is a chord through the axis: a surface that turns inside out.
 *    So: seed by geometry, then continue, then PROVE monotonicity and winding
 *    number 1 on the result. `quad.bisect` is not used -- at a fold the root is
 *    tangential and unbracketed, and bisection reports "no root" on a surface
 *    that has one (geometry review 6c).
 * ---------------------------------------------------------------------------
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js'); require('./quad.js'); require('./doc.js');
  }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const Q = E.quad;
  const D = E.doc;

  const TAU = 2 * Math.PI;
  /** Unit normals closer than this are "parallel planes". */
  const PARALLEL_EPS = 1e-12;
  /** Relative agreement required of a homothety ratio. */
  const HOMOTHETY_EPS = 1e-12;
  /** Mirror-pair detection, mm and radians. */
  const MIRROR_EPS = 1e-9;

  // ------------------------------------------------------------------
  // Branch detection
  // ------------------------------------------------------------------

  /**
   * Is weld B exactly the y-mirror of weld A (as engine/doc mirrors)?
   *
   * The PROFILES must match too, and exactly rather than to MIRROR_EPS: they
   * are dimensionless, so there is no length scale to set an epsilon from, and
   * a mirror pair is produced by `doc.mirrorWeld` copying the array -- it is
   * either the same shape or it is a different weld that happens to sit
   * opposite. When they do match the extrusion is still EXACT (see
   * doc.mirrorWeld): a radial deviation survives a reflection untouched, so
   * this is the one closed-form branch profiles cost nothing at all.
   */
  function isMirrorPair(A, B) {
    const M = D.mirrorWeld(A);
    return V.dist(M.c, B.c) < MIRROR_EPS
      && V.dist(M.n, B.n) < MIRROR_EPS
      && Math.abs(M.a - B.a) < MIRROR_EPS
      && Math.abs(M.b - B.b) < MIRROR_EPS
      && Math.abs(V.wrapPi(M.roll - B.roll)) < MIRROR_EPS
      && D.profilesEqual(M.profile, B.profile);
  }

  /**
   * Plane parallelism, tested on the UNIT NORMALS to 1e-12 BEFORE any shape
   * test (geometry review, amendment to finding 1).
   */
  function planesParallel(A, B) {
    return Math.abs(V.dot(A.n, B.n) - 1) < PARALLEL_EPS;
  }

  /**
   * Which closed form, if any, applies to this pair.
   *
   * ---------------------------------------------------------------------------
   * PROFILES AND THE FAST PATHS (B5). A closed form is a claim about the
   * SHAPES, so each branch has to be re-argued once the section stops being an
   * ellipse. Two survive and one does not:
   *
   *   extrusion  SURVIVES, for free, when the two profiles are identical --
   *              which for a genuine mirror pair they are by construction. The
   *              mirror is a linear isometry, so it commutes with the radial
   *              deviation; phi = theta stays exact for any section curve.
   *              (`isMirrorPair` above enforces the equality.)
   *
   *   cone /     SURVIVES when the two profiles are identical. A generalized
   *   cylinder   cone over ANY plane curve is developable with the rulings
   *              through the apex, i.e. phi = theta -- the ellipse was never
   *              what made that work, the HOMOTHETY was. With equal
   *              coefficients, equal roll and ka = kb = k, weld B's curve is
   *              exactly c_B + k*(p(t) - c_A), which is a homothety of weld A's
   *              curve whatever shape it has.
   *
   *   parallel   DECLINES. `phiParallel` is derived from p' || q' with p, q
   *              specifically ELLIPSES; the closed form has a, b and roll in it
   *              and nothing else. A radial deviation adds an s'(t) E(t) term
   *              to each tangent and the formula is simply the wrong function.
   *              So a profiled pair in parallel planes falls through to the
   *              general branch, which solves the real det = 0 and is gated on
   *              monotonicity and winding like everything else.
   *
   * MISMATCHED profiles (one weld moulded, its neighbour not; or two different
   * mouldings) decline every closed form and go general. That is the honest
   * answer: the surface between them genuinely is not a cone or an extrusion.
   * ---------------------------------------------------------------------------
   */
  function classify(A, B) {
    if (isMirrorPair(A, B)) return { kind: 'extrusion', exact: true };
    const sameProfile = D.profilesEqual(A.profile, B.profile);
    if (planesParallel(A, B)) {
      const dRoll = V.wrapPi(B.roll - A.roll);
      const ka = B.a / A.a, kb = B.b / A.b;
      const homothetic = Math.abs(dRoll) < HOMOTHETY_EPS
        && Math.abs(ka - kb) / Math.max(ka, kb) < HOMOTHETY_EPS;
      if (homothetic && sameProfile) {
        return { kind: Math.abs(ka - 1) < 1e-12 ? 'cylinder' : 'cone', exact: true, k: ka };
      }
      if (!A.profile && !B.profile) return { kind: 'parallel', exact: true, dRoll };
    }
    return { kind: 'general', exact: false };
  }

  // ------------------------------------------------------------------
  // The correspondence
  // ------------------------------------------------------------------

  /** F(theta, phi) = det[p', q', q - p]. */
  function torsal(A, B, fa, fb, theta, phi) {
    const p = D.weldPoint(A, theta, fa);
    const p1 = D.weldTangent(A, theta, fa);
    const q = D.weldPoint(B, phi, fb);
    const q1 = D.weldTangent(B, phi, fb);
    return V.det3(p1, q1, V.sub(q, p));
  }

  /** dF/dphi = det[p', q'', q - p]  (the det[p',q',q'] term vanishes). */
  function dTorsalDPhi(A, B, fa, fb, theta, phi) {
    const p = D.weldPoint(A, theta, fa);
    const p1 = D.weldTangent(A, theta, fa);
    const q = D.weldPoint(B, phi, fb);
    const q2 = D.weldSecond(B, phi, fb);
    return V.det3(p1, q2, V.sub(q, p));
  }

  /** dF/dtheta = det[p'', q', q - p]  (the det[p',q',-p'] term vanishes). */
  function dTorsalDTheta(A, B, fa, fb, theta, phi) {
    const p = D.weldPoint(A, theta, fa);
    const p2 = D.weldSecond(A, theta, fa);
    const q = D.weldPoint(B, phi, fb);
    const q1 = D.weldTangent(B, phi, fb);
    return V.det3(p2, q1, V.sub(q, p));
  }

  /**
   * Closed-form phi for the parallel-plane branch, continuous in theta.
   * `dRoll` = roll_B - roll_A.
   */
  function phiParallel(A, B, dRoll, theta) {
    const cD = Math.cos(dRoll), sD = Math.sin(dRoll);
    const st = Math.sin(theta), ct = Math.cos(theta);
    const num = A.a * B.b * st * cD - A.b * B.b * ct * sD;
    const den = A.a * B.a * st * sD + B.a * A.b * ct * cD;
    return Math.atan2(num, den);
  }

  /**
   * Seed the general branch at one station: scan phi for sign changes of F,
   * refine, and choose the geometrically correct root.
   *
   * The discriminator is CLOSEST APPROACH. Both roots are simple, so no
   * residual or conditioning test can separate them (interaction review 12);
   * what separates them is that the true ruling is the tube's generator and
   * the spurious one is a chord across the tube's interior, which is longer by
   * roughly the section width. Where even that is ambiguous, `correspondence`
   * walks the ranked list until the winding post-condition is met.
   *
   * THE SCAN IS CENTRED ON theta, over [theta-pi, theta+pi], and this is not
   * cosmetic. The interaction review measured a naive [0, 2pi) scan on the
   * exact cone case returning `NONE NONE -3.142 NONE -0.000 0.000 NONE ...` --
   * six outright failures and one silently-wrong antipodal branch out of
   * twelve stations -- because "the spurious roots sit EXACTLY at the bracket
   * endpoints phi = theta +- pi, where a prev*cur < 0 test cannot see them".
   * Centring puts the true root in the interior and the spurious pair on the
   * boundary, which inverts that failure into the correct answer. Measured
   * here on the perturbed DIY bridge: the [0,2pi) scan found ONE root, at
   * 180 degrees, and missed the real one at 0 entirely.
   */
  function seedPhi(A, B, fa, fb, theta, scan) {
    const M = scan || 96;
    const p = D.weldPoint(A, theta, fa);
    const F = new Array(M + 1);
    const PH = new Array(M + 1);
    let fMax = 0;
    const lo = theta - Math.PI;
    for (let i = 0; i <= M; i++) {
      PH[i] = lo + TAU * i / M;
      F[i] = torsal(A, B, fa, fb, theta, PH[i]);
      if (Math.abs(F[i]) > fMax) fMax = Math.abs(F[i]);
    }
    const roots = [];
    const push = (x) => {
      // Keep roots in the centred window so continuation starts near theta,
      // not a whole turn away.
      const w = theta + V.wrapPi(x - theta);
      for (const r of roots) if (Math.abs(V.wrapPi(r - w)) < 1e-7) return;
      roots.push(w);
    };
    // Sign changes -- the easy roots.
    for (let i = 1; i <= M; i++) {
      if (F[i - 1] === 0) push(PH[i - 1]);
      else if (F[i - 1] * F[i] < 0) {
        push(Q.bisect((x) => torsal(A, B, fa, fb, theta, x), PH[i - 1], PH[i], 1e-13, 200));
      }
    }
    if (F[M] === 0) push(PH[M]);
    // TANGENTIAL (double) roots -- where the determinant touches zero without
    // crossing. These are the parabolic points of the developable and they
    // appear as segments get short relative to the section (geometry review
    // 6c). Bisection cannot see them; a local minimum of |F| that is tiny
    // against the scan's own scale can. Missing them is how a continuation
    // tracker ends up on the wrong branch and stays there.
    const rel = 1e-6 * Math.max(fMax, 1e-300);
    for (let i = 1; i < M; i++) {
      const a0 = Math.abs(F[i - 1]), a1 = Math.abs(F[i]), a2 = Math.abs(F[i + 1]);
      if (a1 <= a0 && a1 <= a2 && a1 < rel) {
        const sol = Q.newton((x) => torsal(A, B, fa, fb, theta, x),
          (x) => dTorsalDPhi(A, B, fa, fb, theta, x), PH[i],
          { tol: rel, maxStep: TAU / M });
        push(sol.x);
      }
    }
    if (!roots.length) return { phi: null, roots, bracketed: false, ranked: [] };
    // Rank by closest approach; `correspondence` walks this list until the
    // winding post-condition is satisfied, because closest-approach alone
    // cannot always separate the true branch from the reversed one -- notably
    // on a NEAR-mirror pair, where the two curves are almost identically
    // shaped and a second, genuinely developable but twisted, surface exists
    // (geometry review 18).
    const ranked = roots.slice().sort((x, y) =>
      V.dist(D.weldPoint(B, x, fb), p) - V.dist(D.weldPoint(B, y, fb), p));
    return { phi: ranked[0], roots, ranked, bracketed: true };
  }

  /**
   * Build the correspondence over one full turn, on a uniform theta grid.
   *
   * Returns the grid AND a `phiAt(theta)` valid for any real theta (lifted:
   * phiAt(theta + 2pi) = phiAt(theta) + 2pi), plus the conditioning data the
   * checks need.
   */
  function correspondence(A, B, opts) {
    const o = opts || {};
    const N = o.stations || 128;
    const fa = D.weldFrame(A), fb = D.weldFrame(B);
    // `force: 'general'` denies a pair its closed form. Only tests use it, and
    // they must: it is the CROSSOVER GATE (architecture review 12) -- "without
    // it the general branch has no independent check at all, and it is the one
    // piece of new numerics in the whole plan".
    const cls = o.force === 'general' ? { kind: 'general', exact: false } : classify(A, B);

    const grid = new Array(N + 1);
    const report = {
      kind: cls.kind, exact: cls.exact,
      monotone: true, winding: 1, closureResidual: 0,
      minSlope: Infinity, maxTorsalResidual: 0, seeded: null, failures: [],
    };

    // ---- closed-form branches ----
    if (cls.kind === 'extrusion') {
      for (let i = 0; i <= N; i++) grid[i] = { theta: TAU * i / N, phi: TAU * i / N };
      report.phiAt = (t) => t;
      report.dPhiAt = () => 1;
    } else if (cls.kind === 'cone' || cls.kind === 'cylinder') {
      for (let i = 0; i <= N; i++) grid[i] = { theta: TAU * i / N, phi: TAU * i / N };
      report.phiAt = (t) => t;
      report.dPhiAt = () => 1;
    } else if (cls.kind === 'parallel') {
      // Lift the closed form: atan2 returns (-pi, pi], so accumulate the
      // winding as theta sweeps.
      const lift = (t) => {
        const turns = Math.floor(t / TAU);
        const base = t - turns * TAU;
        let phi = phiParallel(A, B, cls.dRoll, base);
        // Keep phi in the same "half turn" as base: the map is a monotone
        // degree-1 circle map, so |phi - base| < pi/2 + |dRoll|.
        while (phi - base > Math.PI) phi -= TAU;
        while (base - phi > Math.PI) phi += TAU;
        return phi + turns * TAU;
      };
      for (let i = 0; i <= N; i++) {
        const t = TAU * i / N;
        grid[i] = { theta: t, phi: lift(t) };
      }
      report.phiAt = lift;
      report.dPhiAt = (t) => {
        const h = 1e-6;
        return (lift(t + h) - lift(t - h)) / (2 * h);
      };
    } else {
      // ---- general: seed then continue ----
      const seed = seedPhi(A, B, fa, fb, 0, o.scan || 96);
      report.seeded = seed;
      if (!seed.bracketed) {
        report.failures.push({
          id: 'loft.noRoot',
          message: 'welds ' + A.id + ' and ' + B.id + ' admit no ruling '
            + 'correspondence at theta = 0: det[p\', q\', q-p] has no root',
        });
        // Total, not throwing (interaction review 4). Fall back to the
        // nearest-point pairing so the caller still gets a surface to draw,
        // and let checks.js report it.
        const fallback = (t) => nearestParam(A, B, fa, fb, t);
        for (let i = 0; i <= N; i++) {
          const t = TAU * i / N;
          grid[i] = { theta: t, phi: fallback(t) };
        }
        report.phiAt = fallback;
        report.dPhiAt = (t) => (fallback(t + 1e-5) - fallback(t - 1e-5)) / 2e-5;
        report.degraded = true;
      } else {
        // Track one branch from a seed. Continuation, not bracketing: at a
        // fold the root is tangential and unbracketed, so bisection would
        // report "no root" on a surface that has one (geometry review 6c).
        const track = (phi0) => {
          const g = new Array(N + 1);
          const fails = [];
          let minSlope = Infinity;
          g[0] = { theta: 0, phi: phi0 };
          for (let i = 1; i <= N; i++) {
            const t = TAU * i / N;
            const dt = TAU / N;
            const prev = g[i - 1];
            // Predict with the implicit derivative dphi/dtheta = -F_th/F_phi.
            const fp = dTorsalDPhi(A, B, fa, fb, prev.theta, prev.phi);
            const ft = dTorsalDTheta(A, B, fa, fb, prev.theta, prev.phi);
            if (Math.abs(fp) < minSlope) minSlope = Math.abs(fp);
            const guess = prev.phi + (Math.abs(fp) > 0 ? -(ft / fp) * dt : dt);
            const sol = Q.newton(
              (x) => torsal(A, B, fa, fb, t, x),
              (x) => dTorsalDPhi(A, B, fa, fb, t, x),
              guess, { tol: 1e-9 * scaleOf(A, B), maxStep: Math.PI / 6 });
            if (!sol.converged) {
              fails.push({
                id: 'loft.newton',
                message: 'ruling correspondence did not converge at theta = '
                  + t.toFixed(4) + ' (residual ' + sol.residual.toExponential(2)
                  + '); the conditioning margin |dF/dphi| is '
                  + minSlope.toExponential(2),
                theta: t,
              });
            }
            if (Math.abs(sol.x - prev.phi) > Math.PI / 2) {
              fails.push({
                id: 'loft.branchJump',
                message: 'ruling correspondence jumped '
                  + (sol.x - prev.phi).toFixed(3) + ' rad between adjacent '
                  + 'stations at theta = ' + t.toFixed(4)
                  + ' -- probably the antipodal branch',
                theta: t,
              });
            }
            g[i] = { theta: t, phi: sol.x };
          }
          const sweep = g[N].phi - g[0].phi;
          let mono = true;
          for (let i = 1; i <= N; i++) {
            if ((g[i].phi - g[i - 1].phi) * Math.sign(sweep || 1) <= 0) mono = false;
          }
          return { grid: g, fails, minSlope, winding: sweep / TAU, monotone: mono };
        };

        // Walk the ranked seeds until one satisfies the post-conditions.
        // Closest approach alone cannot always separate the true branch from
        // the reversed one; the winding number can, and it is the cheapest
        // thing that does.
        let attempt = null;
        for (const s of seed.ranked) {
          const a = track(s);
          if (!attempt) attempt = a;
          if (a.monotone && Math.abs(a.winding - 1) < 1e-6) { attempt = a; break; }
        }
        for (let i = 0; i <= N; i++) grid[i] = attempt.grid[i];
        report.minSlope = attempt.minSlope;
        report.failures.push(...attempt.fails);
        report.seedUsed = attempt.grid[0].phi;
        // A table + Newton polish gives phi at any theta. Lifted by winding.
        const table = grid;
        const polish = (t) => {
          const turns = Math.floor(t / TAU);
          const base = t - turns * TAU;
          const x = base / (TAU / N);
          const i = Math.min(N - 1, Math.max(0, Math.floor(x)));
          const f = x - i;
          const guess = table[i].phi + (table[i + 1].phi - table[i].phi) * f;
          const sol = Q.newton(
            (y) => torsal(A, B, fa, fb, base, y),
            (y) => dTorsalDPhi(A, B, fa, fb, base, y),
            guess, { tol: 1e-9 * scaleOf(A, B), maxStep: Math.PI / 12 });
          return sol.x + turns * TAU;
        };
        report.phiAt = polish;
        report.dPhiAt = (t) => {
          const phiT = polish(t);
          const fp = dTorsalDPhi(A, B, fa, fb, t, phiT);
          const ft = dTorsalDTheta(A, B, fa, fb, t, phiT);
          return fp === 0 ? 0 : -ft / fp;
        };
      }
    }

    // ---- post-conditions, on every branch ----
    // MONOTONICITY is the geometric post-condition (interaction review 12:
    // "that single test catches every failure mode above and is O(N)").
    // WINDING = +1 is a separate, orientation-convention post-condition: a
    // correspondence that is monotone but runs BACKWARDS means the two welds
    // are parametrised opposite ways round, which happens when a weld normal
    // does not point along ring traversal. Reporting them as one check
    // conflates a broken surface with a mis-signed normal.
    let minStep = Infinity, maxStep = -Infinity, minAbs = Infinity;
    for (let i = 1; i <= N; i++) {
      const d = grid[i].phi - grid[i - 1].phi;
      if (d < minStep) minStep = d;
      if (d > maxStep) maxStep = d;
      if (Math.abs(d) < minAbs) minAbs = Math.abs(d);
    }
    const dir = (grid[N].phi - grid[0].phi) >= 0 ? 1 : -1;
    report.monotone = dir > 0 ? minStep > 0 : maxStep < 0;
    report.monotoneMargin = report.monotone ? minAbs : 0;
    report.direction = dir;
    report.minStep = minStep;
    report.maxStep = maxStep;
    const sweep = grid[N].phi - grid[0].phi;
    report.winding = sweep / TAU;
    report.closureResidual = Math.abs(sweep - TAU);
    if (report.minSlope === Infinity) report.minSlope = NaN;

    // Torsality residual on UNIT vectors (geometry review 3, check 5): a
    // dimensionless number that says directly whether the surface is
    // developable, instead of inferring it from a downstream symptom.
    for (let i = 0; i <= N; i++) {
      const t = grid[i].theta, ph = grid[i].phi;
      const p = D.weldPoint(A, t, fa);
      const p1 = V.norm(D.weldTangent(A, t, fa));
      const q = D.weldPoint(B, ph, fb);
      const q1 = V.norm(D.weldTangent(B, ph, fb));
      const w = V.sub(q, p);
      const wl = V.len(w);
      if (wl < 1e-12) continue;
      const r = Math.abs(V.det3(p1, q1, V.scale(w, 1 / wl)));
      if (r > report.maxTorsalResidual) report.maxTorsalResidual = r;
    }

    report.grid = grid;
    report.frameA = fa;
    report.frameB = fb;
    return report;
  }

  /** Characteristic length of the pair -- sets the absolute Newton tolerance. */
  function scaleOf(A, B) {
    const s = Math.max(A.a, A.b, B.a, B.b, V.dist(A.c, B.c));
    return s * s * s;
  }

  /** Fallback pairing: the parameter on B closest to p(theta). Degraded only. */
  function nearestParam(A, B, fa, fb, theta) {
    const p = D.weldPoint(A, theta, fa);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 180; i++) {
      const ph = TAU * i / 180;
      const d = V.dist(D.weldPoint(B, ph, fb), p);
      if (d < bestD) { bestD = d; best = ph; }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // The loft object
  // ------------------------------------------------------------------

  /**
   * Loft weld A to weld B.
   *
   * @returns an object with the correspondence, pointwise surface evaluation
   *   and the local differential quantities the development and the checks
   *   both need. Nothing here is sampled: sampling is engine/develop2.js's
   *   business.
   */
  function loft(A, B, opts) {
    const co = correspondence(A, B, opts);
    const fa = co.frameA, fb = co.frameB;

    /**
     * Everything local at one station, in one pass. This is the hot function
     * of the whole engine; every consumer below shares it.
     *
     *   p, p1, p2   weld A curve, tangent, second derivative
     *   phi, dphi   the correspondence and its derivative
     *   q, qdot     weld B's point and d/dtheta of q(phi(theta))
     *   r, L, m     the ruling: vector, length, unit direction
     *   ns          UNIT SURFACE NORMAL, constant along the ruling
     *   w           ns x m: the in-tangent-plane direction across the ruling
     *   kappaG      geodesic curvature of weld A's curve on the surface
     *   torsion     |qdot . ns| -- the developability residual, in mm/rad
     */
    function station(theta) {
      const p = D.weldPoint(A, theta, fa);
      const p1 = D.weldTangent(A, theta, fa);
      const p2 = D.weldSecond(A, theta, fa);
      const phi = co.phiAt(theta);
      const dphi = co.dPhiAt(theta);
      const q = D.weldPoint(B, phi, fb);
      const q1 = D.weldTangent(B, phi, fb);
      const qdot = V.scale(q1, dphi);
      const r = V.sub(q, p);
      const L = V.len(r);
      const m = V.scale(r, 1 / L);
      const cr = V.cross(p1, m);
      const crl = V.len(cr);
      const ns = V.scale(cr, 1 / crl);
      const w = V.cross(ns, m);
      const sp = V.len(p1);
      // kappa_g = ((p' x p'') . ns) / |p'|^3   (geometry review finding 4)
      const kappaG = V.dot(V.cross(p1, p2), ns) / (sp * sp * sp);
      return {
        theta, p, p1, p2, phi, dphi, q, q1, qdot, r, L, m, ns, w, sp, kappaG,
        torsion: V.dot(qdot, ns),
      };
    }

    /** 3D point on the surface. s = 0 at weld A, s = 1 at weld B. */
    function point(theta, s) {
      const st = station(theta);
      return V.add(st.p, V.scale(st.r, s));
    }

    /**
     * Where the ruling at `theta` crosses a plane {point, normal}.
     * Returns null when the ruling is parallel to the plane -- TOTAL, never a
     * throw (interaction review 4: `cutParam` throwing is what freezes the
     * boat mid-drag).
     */
    function cutRuling(theta, plane, st0) {
      const st = st0 || station(theta);
      const den = V.dot(st.r, plane.normal);
      if (Math.abs(den) < 1e-12) return null;
      const s = V.dot(V.sub(plane.point, st.p), plane.normal) / den;
      return { s, point: V.add(st.p, V.scale(st.r, s)), onPatch: s >= 0 && s <= 1 };
    }

    /** The whole plane-cut edge, sampled around the ring. */
    function cutWithPlane(plane, samples) {
      const N = samples || 128;
      const pts = [], params = [];
      let offPatch = 0, missing = 0;
      for (let i = 0; i <= N; i++) {
        const t = TAU * i / N;
        const c = cutRuling(t, plane);
        if (!c) { missing++; pts.push(null); params.push(null); continue; }
        if (!c.onPatch) offPatch++;
        pts.push(c.point); params.push(c.s);
      }
      return { points: pts, s: params, offPatch, missing };
    }

    /**
     * A-posteriori conicality (geometry review, amendment to finding 1): fit
     * the apex the rulings would share, by least squares, and report the
     * residual. This is the ONLY conicality test that fires on the existing
     * engine's co-conical-but-dissimilar weld pairs, and it cannot fire
     * wrongly.
     *
     * Minimise sum |(x - p_i) - m_i (m_i . (x - p_i))|^2 over x -- the classic
     * line-intersection normal equations with M = sum (I - m m^T).
     */
    function fitApex(samples) {
      const N = samples || 48;
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const rhs = [0, 0, 0];
      const sts = [];
      for (let i = 0; i < N; i++) {
        const st = station(TAU * i / N);
        sts.push(st);
        const m = st.m, p = st.p;
        for (let r0 = 0; r0 < 3; r0++) {
          for (let c0 = 0; c0 < 3; c0++) {
            M[r0][c0] += (r0 === c0 ? 1 : 0) - m[r0] * m[c0];
          }
          rhs[r0] += ((p[r0]) - m[r0] * V.dot(m, p));
        }
      }
      const x = solve3(M, rhs);
      if (!x) return { apex: null, residual: Infinity };
      let resid = 0;
      for (const st of sts) {
        const d = V.sub(x, st.p);
        const perp = V.sub(d, V.scale(st.m, V.dot(st.m, d)));
        resid = Math.max(resid, V.len(perp));
      }
      return { apex: x, residual: resid };
    }

    /**
     * Invert the correspondence: the theta whose ruling lands at parameter
     * `phiTarget` on weld B. Needed because the panel's longitudinal seam is
     * pinned at BOTH welds -- weld A's seam parameter and weld B's -- and the
     * two are not the same theta.
     *
     * phi is monotone (post-condition above), so bisect the grid then polish.
     */
    function thetaAtPhi(phiTarget) {
      const g = co.grid;
      const N = g.length - 1;
      const lo = g[0].phi, hi = g[N].phi;
      // Lift the target into the grid's phi span.
      let target = phiTarget;
      while (target < lo) target += TAU;
      while (target > hi) target -= TAU;
      let i = 0;
      for (let k = 0; k < N; k++) if (g[k].phi <= target) i = k;
      const span = g[i + 1].phi - g[i].phi;
      const seedT = g[i].theta
        + (span === 0 ? 0 : (target - g[i].phi) / span) * (g[i + 1].theta - g[i].theta);
      // Polish, but NEVER leave the grid. On a degenerate correspondence
      // (non-monotone, winding 0) Newton here diverges -- measured at 3.2e15 --
      // and a caller lifting that by whole turns spins for ever. Total, not
      // throwing, and bounded: the interpolated seed is always a usable answer.
      const lo0 = g[0].theta, hi0 = g[N].theta;
      let t = seedT;
      for (let it = 0; it < 20; it++) {
        const f = co.phiAt(t) - target;
        const d = co.dPhiAt(t);
        if (!isFinite(d) || d === 0) break;
        const step = -f / d;
        const next = t + step;
        if (!isFinite(next) || next < lo0 - TAU || next > hi0 + TAU) return seedT;
        t = next;
        if (Math.abs(step) < 1e-14) break;
      }
      return isFinite(t) ? t : seedT;
    }

    return {
      A, B, frameA: fa, frameB: fb,
      kind: co.kind, exact: co.exact, correspondence: co,
      phiAt: co.phiAt, dPhiAt: co.dPhiAt, thetaAtPhi,
      station, point, cutRuling, cutWithPlane, fitApex,
    };
  }

  /** 3x3 solve by Cramer. Returns null on a singular system. */
  function solve3(M, b) {
    const a11 = M[0][0], a12 = M[0][1], a13 = M[0][2];
    const a21 = M[1][0], a22 = M[1][1], a23 = M[1][2];
    const a31 = M[2][0], a32 = M[2][1], a33 = M[2][2];
    const det = a11 * (a22 * a33 - a23 * a32) - a12 * (a21 * a33 - a23 * a31)
      + a13 * (a21 * a32 - a22 * a31);
    if (Math.abs(det) < 1e-9) return null;
    const dx = b[0] * (a22 * a33 - a23 * a32) - a12 * (b[1] * a33 - a23 * b[2])
      + a13 * (b[1] * a32 - a22 * b[2]);
    const dy = a11 * (b[1] * a33 - a23 * b[2]) - b[0] * (a21 * a33 - a23 * a31)
      + a13 * (a21 * b[2] - b[1] * a31);
    const dz = a11 * (a22 * b[2] - b[1] * a32) - a12 * (a21 * b[2] - b[1] * a31)
      + b[0] * (a21 * a32 - a22 * a31);
    return [dx / det, dy / det, dz / det];
  }

  const api = {
    TAU, PARALLEL_EPS, HOMOTHETY_EPS, MIRROR_EPS,
    isMirrorPair, planesParallel, classify,
    torsal, dTorsalDPhi, dTorsalDTheta, phiParallel, seedPhi,
    correspondence, loft, solve3,
  };

  E.loft = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
