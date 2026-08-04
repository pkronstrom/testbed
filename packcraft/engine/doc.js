/**
 * engine/doc.js -- THE BOAT DOCUMENT.
 *
 * The whole design is nine numbers per weld plus a floor block. Everything
 * else in the engine is derived: segments are not stored, panels are not
 * stored, the starboard side is not stored.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA
 *
 *   {
 *     schema: 'packraft.weld/1',
 *     nextId: 8,                       // monotonic; ids are never reused
 *     mirror: true,                    // welds[] is the PORT HALF of the ring
 *     welds: [                         // ordered, bow -> stern along the port side
 *       { id: 1,                       // STABLE. Assigned at creation, never
 *                                      // renumbered by addSeam/removeSeam.
 *         c: [x, y, z],                // weld plane centre, mm
 *         n: [nx, ny, nz],             // unit normal, pointing ALONG TRAVERSAL
 *         a: 160,                      // semi-axis along the rolled e1 axis
 *         b: 152,                      // semi-axis along the rolled e2 axis
 *         roll: 0.13,                  // in-plane rotation of (a,b) from (u,v)
 *         seam: 3.316,                 // longitudinal seam, GEOMETRIC clock
 *                                      // angle (rad) about the weld centre
 *         onCentreplane: false,        // true => self-mirroring, stored once
 *         profile: null },             // section deviation; null => plain ellipse
 *       ...
 *     ],
 *     floor: { clockAngle: 190,        // degrees, document default for weld.seam
 *              tabWidth: 120,          // mm of arc, spec 3.7
 *              wrapMaxAngle: 80 },     // degrees, spec 3.7 clamp
 *     locks: { uniformB: true, mirror: true, pairs: [] },
 *     meta: { name, note }
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHY EACH FIELD IS THE WAY IT IS -- every one of these is a review finding.
 *
 * `id` STABLE (architecture review 5, 26). skeleton.classify() names parts
 *   L1..Ln positionally; under addSeam that silently relabels a builder's
 *   half-cut pattern set. Ids are document fields, assigned at creation.
 *   Display labels (L1/R1/BOW) are recomputed per render, never stored.
 *
 * `b` PER WELD, and `roll` EXISTS (geometry review 2, 5; interaction review
 *   15). Measured on the existing boat, semi-minor axes run 84 .. 149 mm (a
 *   78% spread) and the major axis is rolled -15.7 .. +20.5 deg out of
 *   axis-alignment. Forcing axis-aligned {a, b} costs up to 35 mm of radial
 *   shape error at the bow bridge. Uniform-b is a LOCK, not a representation
 *   invariant.
 *
 * `n` POINTS ALONG TRAVERSAL. This fixes the in-plane frame -- u is the
 *   component of +z perpendicular to n ("up"), v = n x u -- and makes v point
 *   OUTBOARD on both sides of the hull, so a clock angle means the same thing
 *   to port and starboard. Recorded because the geometry review (12) is right
 *   that "vertical semi-axis b" is meaningless until the basis is written
 *   down.
 *
 * `seam` IS A GEOMETRIC CLOCK ANGLE, NOT AN ELLIPSE PARAMETER (geometry review
 *   14). On an a=2b ellipse the two differ by up to 19.5 deg. panels.js's
 *   registerSeams/solveSeamTheta exists precisely because a raw parameter
 *   angle stepped the landing line by 8.3 mm per joint. Storing the geometric
 *   angle and converting at use (`paramAtClock`) keeps that fix and deletes
 *   the 68-line solver: the seam point now lives on the WELD, which both
 *   adjacent segments share, so landing-line continuity is by construction.
 *
 * `mirror` + PORT HALF ONLY (user direction, "Constraint philosophy"):
 *   symmetry by representation, not by rule. An asymmetric weld is not
 *   something this document can say. Centreplane-crossing pieces are handled
 *   explicitly: a weld ON the plane is stored once and marked
 *   `onCentreplane`; a bridge span is the closing segment between the first
 *   stored weld and its own mirror.
 *
 * `locks` IN THE DOCUMENT (architecture review 7): otherwise toggling a lock
 *   is not undoable and a shared permalink opens with the recipient's
 *   defaults rather than the author's.
 *
 * ---------------------------------------------------------------------------
 * `profile` -- THE SECTION CURVE (B5), AS BASE + DEVIATION
 *
 *   profile: null                    the section IS the {a, b, roll} ellipse
 *   profile: { k: [d0 ... d(m-1)] }  the section is that ellipse, RADIALLY
 *                                    modulated by a periodic spline
 *
 * THE CURVE. With E(t) = a cos(t) e1 + b sin(t) e2 the stored ellipse offset
 * from the weld centre, the profiled weld curve is
 *
 *     P(t) = c + (1 + s(t)) * E(t)
 *
 * where s(t) is a DIMENSIONLESS radial deviation: s = 0.1 means "10% further
 * out from the weld centre than the ellipse, along the same ray". s is a
 * UNIFORM PERIODIC CUBIC B-SPLINE in the ELLIPSE PARAMETER t, with m equally
 * spaced knots at t_j = 2*pi*j/m and coefficients k[j]. The stored array IS the
 * coefficient vector; nothing else is stored, because nothing else is needed --
 * the knot vector is uniform and periodic by definition and therefore not data.
 *
 * WHY THIS REPRESENTATION, point by point against the brief:
 *
 * (a) IT REDUCES EXACTLY TO THE ELLIPSE. All-zero coefficients give s(t) = 0
 *     and s'(t) = 0 identically -- a sum of products with 0, not a small
 *     number -- so P(t) = c + 1 * E(t), and IEEE multiplication by exactly 1.0
 *     is exact. Every accessor returns bit-identical numbers to the unprofiled
 *     path. A `null` profile skips the machinery altogether, so the ellipse
 *     boat costs literally nothing.
 *
 * (b) IT IS C2. A uniform cubic B-spline is C2 across every knot, so P, P' and
 *     P'' are all continuous. That is not decoration: the ruling
 *     correspondence Newton-solves det[p', q', q-p] = 0 and needs a continuous
 *     dF/dphi to continue a branch, and the development integrates the geodesic
 *     curvature kappa_g = ((p' x p'') . n^)/|p'|^3, which reads P'' directly.
 *     A C1 (quadratic) or a Catmull-Rom-through-the-points spline would leave
 *     kappa_g with jumps at every knot, and the marcher would then be
 *     integrating a discontinuous integrand at exactly the nodes it is
 *     accurate at.
 *
 * (c) IT QUANTIZES WELL. The coefficients are DIMENSIONLESS ratios of order
 *     0.1, so one quantisation step serves every boat regardless of size --
 *     unlike control points in mm, which would need a step that is fine at a
 *     150 mm tube and wasteful at a 400 mm one. engine/encode.js rounds them to
 *     1e-4, which at the largest semi-axis any template carries (~420 mm) is
 *     0.042 mm -- the same budget the roll/seam angle step already buys.
 *
 * (d) IT ROUND-TRIPS BYTE-STABLY. The whole profile is a flat array of doubles
 *     under one fixed key. `toJSON` writes `{"k":[...]}` and `create` reads it
 *     back with `+x`; there is no derived field to recompute, no knot vector to
 *     regenerate and no normalisation step to bite twice (compare the `unitish`
 *     note above, which exists because normalising a normal is not idempotent).
 *
 * (e) THE CLOCK ANGLE STILL MEANS WHAT IT MEANT. This is the property that
 *     made the radial form win over "offset control points in the plane". The
 *     modulation is RADIAL about the weld centre, so as long as 1 + s(t) > 0
 *     the point at parameter t lies on the SAME ray from c as the ellipse point
 *     at t. Its geometric clock angle is therefore unchanged, and
 *     `paramAtClock` / `clockAtParam` -- which the seam point, the floor
 *     landing line and every mated-edge guarantee are built on -- need no
 *     change at all and keep working by identity rather than by rootfind.
 *
 * (f) SELF-INTERSECTION IS UNREPRESENTABLE, NOT POLICED. A curve given as
 *     r(theta) > 0 about a fixed centre is star-shaped, and a star-shaped
 *     closed curve cannot cross itself. So the ONE thing validation has to
 *     look at is whether 1 + s(t) stays positive; everything the brief calls
 *     "self-intersecting or non-star-shaped beyond recovery" is exactly the
 *     complement of that single scalar test. It is reported as a document
 *     WARNING (never an error, never a refusal): editing never blocks.
 *
 * WHAT THE DEVIATION SITS ON TOP OF. {a, b, roll} remain the base, so
 * `setWidth`/`setHeight` still scale the section under an unchanged profile and
 * the uniform-b lock still means what it says. A profile is a SHAPE, not a
 * SIZE: resizing the tube carries the moulded section with it.
 *
 * MIRRORING. `mirrorWeld` copies the coefficients unchanged, and that is
 * correct: the mirror is a linear isometry, so mirrorY(c + lambda*E(t)) =
 * mirrorY(c) + lambda*mirrorY(E(t)). A weld and its mirror therefore remain an
 * EXACT extrusion pair, and engine/loft.js keeps its closed-form branch for
 * them (the one fast path that survives profiles for free).
 *
 * WHAT IS DELIBERATELY NOT HERE. No per-weld knot vector, no rational weights,
 * no tangent handles, no "profile library". A radial deviation with m uniform
 * knots is the smallest thing that can say "this section is fuller under the
 * chine and flatter on top", which is the edit the plan asks for.
 * ---------------------------------------------------------------------------
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') { require('./vec3.js'); require('./quad.js'); }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;

  const SCHEMA = 'packraft.weld/1';
  const DEG = Math.PI / 180;
  const TAU = 2 * Math.PI;

  /**
   * PROFILE limits.
   *
   * MIN 4: a periodic cubic B-spline span reads four coefficients, and below
   *   four they start to alias onto each other -- the basis stops being a
   *   partition of unity over distinct control values and the "deviation at
   *   station j" solve below is no longer the tridiagonal system it looks like.
   *   Fewer than four is treated as no profile at all and reported.
   * DEFAULT 12: 30 degrees a knot. Enough to mould a chine or flatten a deck
   *   without being able to draw a sawtooth the loft would have to resolve.
   * MAX 64: not a law, a warning threshold -- past it the permalink grows for
   *   shape nobody can cut, and the correspondence has to chase wiggles finer
   *   than the ruling grid.
   * MIN_FACTOR 0.05: below 5% of the base radius the section has collapsed
   *   toward its own centre; the curve is still valid but the clock-angle
   *   identity is numerically worthless there, so say so.
   */
  const PROFILE_MIN_KNOTS = 4;
  const PROFILE_DEFAULT_KNOTS = 12;
  const PROFILE_MAX_KNOTS = 64;
  const PROFILE_MIN_FACTOR = 0.05;

  // A weld is "on the centreplane" when its centre sits on y = 0 and its
  // normal is athwartships. Tolerance is generous because it is a DECLARED
  // property (the flag), checked rather than inferred.
  const CENTREPLANE_TOL = 1e-9;

  // ------------------------------------------------------------------
  // Construction, validation, round-trip
  // ------------------------------------------------------------------

  /** Deep clone through JSON -- the document is plain data, by design. */
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function defaults() {
    return {
      schema: SCHEMA,
      nextId: 1,
      mirror: true,
      welds: [],
      floor: { clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      locks: { uniformB: true, mirror: true, pairs: [] },
      meta: { name: 'untitled', note: '' },
    };
  }

  /**
   * Build a document, assigning stable ids to any weld that lacks one and
   * normalising every field. Idempotent: create(create(x)) === create(x).
   */
  function create(spec) {
    const d = Object.assign(defaults(), spec ? clone(spec) : {});
    d.schema = SCHEMA;
    d.floor = Object.assign(defaults().floor, d.floor || {});
    d.locks = Object.assign(defaults().locks, d.locks || {});
    d.meta = Object.assign(defaults().meta, d.meta || {});
    d.welds = (d.welds || []).map((w) => normaliseWeld(w));
    let next = d.nextId || 1;
    for (const w of d.welds) {
      if (w.id == null) w.id = next++;
      else if (w.id >= next) next = w.id + 1;
    }
    d.nextId = next;
    return d;
  }

  /**
   * Normalise, but leave an already-unit vector ALONE.
   *
   * `V.norm(V.norm(x))` is not `V.norm(x)` in floating point -- the first
   * division leaves |n| at 1 +- a couple of ulps, and the second divides by
   * that. `create` is idempotent by contract and `toJSON` is byte-stable by
   * contract (both asserted in tests/engine.test.js E0.2), and both claims are
   * false without this guard: a document that has merely been through a
   * permalink comes back with normals differing in the last two digits, so undo
   * snapshots and shared links stop comparing equal. B1's template numbers
   * happened not to trip it; B2's do.
   *
   * The tolerance is 1e-14 on |n|^2, i.e. 5e-15 on |n| -- five orders tighter
   * than `validate`'s 1e-9 unit check, so nothing non-unit slips through.
   */
  function unitish(v) {
    const l2 = V.dot(v, v);
    return Math.abs(l2 - 1) <= 1e-14 ? v.slice() : V.norm(v);
  }

  function normaliseWeld(w) {
    const out = {
      id: w.id == null ? null : w.id,
      c: [+w.c[0], +w.c[1], +w.c[2]],
      n: unitish([+w.n[0], +w.n[1], +w.n[2]]),
      a: +w.a,
      b: +w.b,
      roll: w.roll == null ? 0 : +w.roll,
      seam: w.seam == null ? 190 * DEG : +w.seam,
      onCentreplane: !!w.onCentreplane,
      profile: normaliseProfile(w.profile),
    };
    return out;
  }

  // ------------------------------------------------------------------
  // Profiles: the section curve, as base ellipse + radial deviation
  // (read the header before touching any of this)
  // ------------------------------------------------------------------

  /**
   * Canonical stored form: `null`, or `{ k: [ ... ] }` with plain doubles.
   *
   * Accepts a bare array as shorthand, because "the profile IS its coefficient
   * vector" is how every caller thinks about it and wrapping it at the door is
   * cheaper than wrapping it at eleven call sites.
   *
   * A NON-FINITE COEFFICIENT IS NORMALISED TO ZERO, silently and deliberately.
   * NaN is not a shape, it is a bug upstream; and JSON has no NaN, so leaving
   * one in place would make the document fail its own byte-stability contract
   * (it would come back from a permalink as `null`, i.e. as a different
   * document). A SHORT array is left exactly as given -- `validate` reports it
   * and the kernel ignores it, which is more useful than silently padding a
   * shape the user did not ask for.
   */
  function normaliseProfile(p) {
    if (p == null) return null;
    const k = Array.isArray(p) ? p : (Array.isArray(p.k) ? p.k : []);
    return { k: k.map((x) => (isFinite(+x) ? +x : 0)) };
  }

  /** Deep equality of two stored profiles -- what the loft's fast paths ask. */
  function profilesEqual(p, q) {
    if (p == null || q == null) return p == null && q == null;
    if (p.k.length !== q.k.length) return false;
    for (let i = 0; i < p.k.length; i++) if (p.k[i] !== q.k[i]) return false;
    return true;
  }

  /** The knot parameters of an m-knot profile: t_j = 2*pi*j/m. */
  function profileStations(m) {
    const out = new Array(m);
    for (let j = 0; j < m; j++) out[j] = TAU * j / m;
    return out;
  }

  /**
   * A profile compiled for evaluation, or null when there is nothing to
   * evaluate (absent, or too few coefficients to be a cubic B-spline).
   *
   * `s`, `d1`, `d2` are s(t), ds/dt and d2s/dt2, valid for ANY real t: the
   * spline is periodic, and the development marches theta well outside
   * [0, 2pi) (see develop2's node set, which reaches a full turn plus the tab
   * band margin either side).
   *
   * `hullMin`/`hullMax` are the CONVEX HULL bounds min(k) and max(k). A
   * B-spline is contained in the convex hull of its coefficients, so these
   * bound s rigorously and for free -- which is what engine/checks.js wants
   * when it needs a conservative support radius without sampling anything.
   * `extent()` is the TRUE range, sampled, and costs 8 evaluations per span;
   * it is a function rather than a field so `weldFrame` stays O(m).
   */
  function profilePrepare(profile) {
    const p = normaliseProfile(profile);
    if (!p) return null;
    const k = p.k, m = k.length;
    if (m < PROFILE_MIN_KNOTS) return null;
    const span = TAU / m;
    const at = (j) => k[((j % m) + m) % m];

    // Uniform cubic B-spline on the span containing t. B0 multiplies k[i-1].
    const basis = (t) => {
      const u = t / span;
      const i = Math.floor(u);
      return { i, f: u - i };
    };
    const s = (t) => {
      const { i, f } = basis(t);
      const g = 1 - f, f2 = f * f, f3 = f2 * f;
      return (g * g * g * at(i - 1)
        + (3 * f3 - 6 * f2 + 4) * at(i)
        + (-3 * f3 + 3 * f2 + 3 * f + 1) * at(i + 1)
        + f3 * at(i + 2)) / 6;
    };
    const d1 = (t) => {
      const { i, f } = basis(t);
      const g = 1 - f, f2 = f * f;
      return (-3 * g * g * at(i - 1)
        + (9 * f2 - 12 * f) * at(i)
        + (-9 * f2 + 6 * f + 3) * at(i + 1)
        + 3 * f2 * at(i + 2)) / (6 * span);
    };
    const d2 = (t) => {
      const { i, f } = basis(t);
      return (6 * (1 - f) * at(i - 1)
        + (18 * f - 12) * at(i)
        + (-18 * f + 6) * at(i + 1)
        + 6 * f * at(i + 2)) / (6 * span * span);
    };

    let hullMin = k[0], hullMax = k[0];
    for (let i = 1; i < m; i++) {
      if (k[i] < hullMin) hullMin = k[i];
      if (k[i] > hullMax) hullMax = k[i];
    }
    let ext = null;
    const extent = () => {
      if (ext) return ext;
      let lo = Infinity, hi = -Infinity;
      const N = 8 * m;
      for (let i = 0; i < N; i++) {
        const v = s(TAU * i / N);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      ext = { sMin: lo, sMax: hi, rMin: 1 + lo, rMax: 1 + hi };
      return ext;
    };

    return { k: k.slice(), m, span, s, d1, d2, hullMin, hullMax, extent };
  }

  /** The deviation the curve actually takes AT each knot station. */
  function profileToStations(profile) {
    const p = normaliseProfile(profile);
    if (!p) return [];
    const k = p.k, m = k.length;
    const out = new Array(m);
    for (let j = 0; j < m; j++) {
      out[j] = (k[(j - 1 + m) % m] + 4 * k[j] + k[(j + 1) % m]) / 6;
    }
    return out;
  }

  /**
   * The inverse: coefficients whose spline passes THROUGH the given deviations
   * at the knot stations. This is what makes a dragged handle land where the
   * pointer put it instead of two thirds of the way there.
   *
   *   k[j-1] + 4 k[j] + k[j+1] = 6 * at[j],   indices mod m
   *
   * Solved densely. m is 4..64, so O(m^3) is a few thousand flops on an edit
   * that already costs a re-loft, and the cyclic-tridiagonal trick has a
   * special case at small m that would be a footgun for the sake of
   * microseconds nobody can measure. No pivoting: the matrix is strictly
   * diagonally dominant (4 > 1 + 1), which is exactly the condition that makes
   * plain Gaussian elimination unconditionally stable here.
   *
   * All-zero input gives all-zero output EXACTLY (every right-hand side is 0),
   * so "flatten this profile" is bit-identical to the plain ellipse.
   */
  function profileFromStations(at) {
    const m = at.length;
    if (m < PROFILE_MIN_KNOTS) return null;
    const A = [];
    for (let j = 0; j < m; j++) {
      const row = new Float64Array(m + 1);
      row[(j - 1 + m) % m] += 1;
      row[j] += 4;
      row[(j + 1) % m] += 1;
      row[m] = 6 * (+at[j] || 0);
      A.push(row);
    }
    for (let i = 0; i < m; i++) {
      const piv = A[i][i];
      for (let r = i + 1; r < m; r++) {
        const f = A[r][i] / piv;
        if (f === 0) continue;
        for (let c = i; c <= m; c++) A[r][c] -= f * A[i][c];
      }
    }
    const k = new Array(m);
    for (let i = m - 1; i >= 0; i--) {
      let acc = A[i][m];
      for (let c = i + 1; c < m; c++) acc -= A[i][c] * k[c];
      k[i] = acc / A[i][i];
    }
    return { k };
  }

  /**
   * Resolve an `editProfile` argument into a stored profile. Total: anything
   * unrecognisable clears the profile rather than throwing, because this sits
   * directly under a mouse gesture.
   *
   *   null | false            clear -- back to the plain ellipse
   *   [d0, d1, ...]           raw coefficients
   *   { k: [...] }            raw coefficients
   *   { at: [...] }           deviations AT the stations (interpolating)
   *   { knots: m }            an m-knot profile holding the CURRENT shape --
   *                           all zeros when there is no current profile, so
   *                           this is also "start editing at this resolution"
   */
  function profileSpec(spec, current) {
    if (spec == null || spec === false) return null;
    if (Array.isArray(spec)) return normaliseProfile(spec);
    if (Array.isArray(spec.k)) return normaliseProfile({ k: spec.k });
    if (Array.isArray(spec.at)) return normaliseProfile(profileFromStations(spec.at));
    if (spec.knots != null) {
      const m = Math.max(PROFILE_MIN_KNOTS, Math.round(+spec.knots) || 0);
      const prep = profilePrepare(current);
      const at = profileStations(m).map((t) => (prep ? prep.s(t) : 0));
      return normaliseProfile(profileFromStations(at));
    }
    return null;
  }

  /**
   * Structural validation. Returns an array of issues; never throws. Geometry
   * quality (developability, crossing rulings, cut consumption) is NOT here --
   * that is engine/checks.js, which needs the loft.
   */
  function validate(doc) {
    const issues = [];
    const bad = (id, message, extra) =>
      issues.push(Object.assign({ id, level: 'error', message }, extra || {}));
    const warn = (id, message, extra) =>
      issues.push(Object.assign({ id, level: 'warn', message }, extra || {}));

    if (!doc || doc.schema !== SCHEMA) {
      bad('schema', 'document schema is not ' + SCHEMA);
      return issues;
    }
    if (!Array.isArray(doc.welds) || doc.welds.length < 2) {
      bad('welds', 'a boat needs at least 2 welds; got '
        + (doc.welds ? doc.welds.length : 0));
      return issues;
    }
    const seen = new Set();
    doc.welds.forEach((w, i) => {
      const at = { weld: i, weldId: w.id };
      if (w.id == null) bad('weld.id', 'weld ' + i + ' has no stable id', at);
      else if (seen.has(w.id)) bad('weld.id', 'duplicate weld id ' + w.id, at);
      seen.add(w.id);
      if (!(w.a > 0) || !(w.b > 0)) {
        bad('weld.axes', 'weld ' + i + ' has a non-positive semi-axis', at);
      }
      const nl = V.len(w.n);
      if (Math.abs(nl - 1) > 1e-9) {
        bad('weld.n', 'weld ' + i + ' normal is not unit (|n| = ' + nl + ')', at);
      }
      if (w.onCentreplane) {
        if (Math.abs(w.c[1]) > CENTREPLANE_TOL) {
          bad('weld.centreplane',
            'weld ' + i + ' is marked onCentreplane but c.y = ' + w.c[1], at);
        }
        if (Math.abs(w.n[0]) > CENTREPLANE_TOL || Math.abs(w.n[2]) > CENTREPLANE_TOL) {
          bad('weld.centreplane',
            'weld ' + i + ' is marked onCentreplane but its normal is not '
            + 'athwartships', at);
        }
      } else if (doc.mirror && Math.abs(w.c[1]) < CENTREPLANE_TOL) {
        warn('weld.centreplane',
          'weld ' + i + ' sits on y = 0 but is not marked onCentreplane; the '
          + 'derived ring will contain a duplicate weld', at);
      }
      if (V.frame(w.n).degenerate) {
        warn('weld.frame', 'weld ' + i + ' normal is (anti)parallel to +z; the '
          + 'in-plane frame falls back to the +x construction', at);
      }
      // PROFILE. Every finding here is a WARNING, without exception: a profile
      // is edited under a live pointer and an edit is never refused (plan,
      // "advisories report, never block, everywhere"). The export gate is
      // engine/checks.js's business, and it gates on developability -- which is
      // measured on the surface these welds produce, not guessed at from the
      // coefficients.
      if (w.profile) {
        const m = w.profile.k.length;
        if (m < PROFILE_MIN_KNOTS) {
          warn('weld.profile.knots', 'weld ' + i + ' carries a profile with '
            + m + ' coefficient(s); a periodic cubic spline needs at least '
            + PROFILE_MIN_KNOTS + ', so this section is drawn as the plain '
            + 'ellipse', at);
        } else {
          if (m > PROFILE_MAX_KNOTS) {
            warn('weld.profile.knots', 'weld ' + i + ' carries ' + m
              + ' profile coefficients (over ' + PROFILE_MAX_KNOTS + '): finer '
              + 'than the ruling grid can resolve and it inflates the permalink',
              at);
          }
          const ex = profilePrepare(w.profile).extent();
          if (!(ex.rMin > 0)) {
            warn('weld.profile.starShape', 'weld ' + i + '\'s profile drives the '
              + 'section radius to ' + ex.rMin.toFixed(3) + ' of the base '
              + 'ellipse: the curve passes through its own centre and crosses '
              + 'itself, so it is not recoverable as a section', at);
          } else if (ex.rMin < PROFILE_MIN_FACTOR) {
            warn('weld.profile.collapse', 'weld ' + i + '\'s profile collapses '
              + 'the section to ' + (100 * ex.rMin).toFixed(1) + '% of the base '
              + 'ellipse somewhere round the clock', at);
          }
        }
      }
    });
    // Only the FIRST and LAST stored weld may be on the centreplane: an
    // interior centreplane weld would mean the port half crosses to starboard
    // and back, which the half-ring representation cannot express.
    doc.welds.forEach((w, i) => {
      if (w.onCentreplane && i !== 0 && i !== doc.welds.length - 1) {
        bad('weld.centreplane', 'weld ' + i + ' is on the centreplane but is '
          + 'neither the first nor the last stored weld', { weld: i, weldId: w.id });
      }
    });
    if (!(doc.floor.tabWidth >= 30)) {
      warn('floor.tabWidth', 'spec 3.7 sets a hard minimum of 30 mm for the '
        + 'floor tab (it IS the closing weld for the longitudinal seam); got '
        + doc.floor.tabWidth);
    }
    if (doc.floor.clockAngle < 180 || doc.floor.clockAngle > 200) {
      warn('floor.clockAngle', 'spec 3.7 gives 180-200 deg as the buildable '
        + 'range for the verified flat-table sequence; got ' + doc.floor.clockAngle);
    }
    if (doc.locks.uniformB) {
      const b0 = doc.welds[0].b;
      const spread = doc.welds.reduce((m, w) => Math.max(m, Math.abs(w.b - b0)), 0);
      if (spread > 1e-9) {
        warn('locks.uniformB', 'the uniform-b lock is engaged but the welds '
          + 'have a ' + spread.toFixed(2) + ' mm spread in b; the lock will '
          + 'flatten them on the next setHeight');
      }
    }
    return issues;
  }

  /**
   * JSON round-trip. `toJSON` is stable: same document in, byte-identical
   * string out, so a permalink or an undo snapshot can be compared directly.
   * Key order is fixed here rather than left to insertion order.
   */
  function toJSON(doc, space) {
    const ordered = {
      schema: doc.schema,
      nextId: doc.nextId,
      mirror: doc.mirror,
      welds: doc.welds.map((w) => ({
        id: w.id, c: w.c, n: w.n, a: w.a, b: w.b, roll: w.roll,
        seam: w.seam, onCentreplane: w.onCentreplane,
        // Rebuilt under one fixed key rather than emitted as-is: a caller may
        // have handed `create` a bare array, and key order (or its absence) is
        // exactly what a byte-stability contract is about.
        profile: w.profile ? { k: w.profile.k } : null,
      })),
      floor: {
        clockAngle: doc.floor.clockAngle,
        tabWidth: doc.floor.tabWidth,
        wrapMaxAngle: doc.floor.wrapMaxAngle,
      },
      locks: {
        uniformB: doc.locks.uniformB,
        mirror: doc.locks.mirror,
        pairs: doc.locks.pairs,
      },
      meta: { name: doc.meta.name, note: doc.meta.note },
    };
    return JSON.stringify(ordered, null, space);
  }

  function fromJSON(text) {
    return create(typeof text === 'string' ? JSON.parse(text) : text);
  }

  // ------------------------------------------------------------------
  // Weld curve maths
  // ------------------------------------------------------------------

  /**
   * The weld's orthonormal basis.
   *   n  the stored unit normal (traversal direction)
   *   u  "up": the component of +z perpendicular to n
   *   v  n x u -- OUTBOARD, on both sides of the hull
   *   e1 u rotated by `roll` in the plane: the `a` axis
   *   e2 v rotated by `roll` in the plane: the `b` axis
   */
  function weldFrame(w) {
    const f = V.frame(w.n);
    const c = Math.cos(w.roll), s = Math.sin(w.roll);
    const e1 = V.add(V.scale(f.u, c), V.scale(f.v, s));
    const e2 = V.add(V.scale(f.u, -s), V.scale(f.v, c));
    // The compiled profile rides in the frame, so every accessor that already
    // takes a cached frame gets it for nothing and no hot loop re-compiles it.
    return { n: f.a, u: f.u, v: f.v, e1, e2, degenerate: f.degenerate,
      profile: profilePrepare(w.profile) };
  }

  /**
   * The BASE ellipse offset from the weld centre at parameter t -- the profile
   * deliberately ignored. Exported because an editor draws it (the faint curve
   * a deviation is measured against) and because a test that wants to know
   * what the profile did needs the thing it did it to.
   */
  function weldBase(w, t, fr) {
    const f = fr || weldFrame(w);
    return V.add(V.scale(f.e1, w.a * Math.cos(t)), V.scale(f.e2, w.b * Math.sin(t)));
  }

  /** The radial factor 1 + s(t): 1 everywhere on an unprofiled weld. */
  function weldFactor(w, t, fr) {
    const f = fr || weldFrame(w);
    return f.profile ? 1 + f.profile.s(t) : 1;
  }

  /**
   * Point on the weld curve at ellipse parameter t.
   *
   * P = c + (1 + s(t)) E(t). With a zero profile the scale factor is exactly
   * 1.0 and IEEE multiplication by 1.0 is exact, so this is bit-identical to
   * the unprofiled path -- which is the whole point of a base+deviation form.
   */
  function weldPoint(w, t, fr) {
    const f = fr || weldFrame(w);
    const e = V.add(V.scale(f.e1, w.a * Math.cos(t)), V.scale(f.e2, w.b * Math.sin(t)));
    if (!f.profile) return V.add(w.c, e);
    return V.add(w.c, V.scale(e, 1 + f.profile.s(t)));
  }

  /** dP/dt = (1 + s) E' + s' E. */
  function weldTangent(w, t, fr) {
    const f = fr || weldFrame(w);
    const d = V.add(V.scale(f.e1, -w.a * Math.sin(t)), V.scale(f.e2, w.b * Math.cos(t)));
    if (!f.profile) return d;
    const e = V.add(V.scale(f.e1, w.a * Math.cos(t)), V.scale(f.e2, w.b * Math.sin(t)));
    return V.add(V.scale(d, 1 + f.profile.s(t)), V.scale(e, f.profile.d1(t)));
  }

  /**
   * d2P/dt2 -- analytic, so the geodesic curvature never needs a stencil.
   *
   * E'' = -E for an ellipse, so P'' = (1+s)E'' + 2 s' E' + s'' E collapses to
   *
   *     P'' = (s'' - 1 - s) E + 2 s' E'
   *
   * which costs one extra multiply-add over the unprofiled form and, at s = 0,
   * is (-1) * E: bit-identical again, because negating each term and summing is
   * exactly negating the sum in IEEE arithmetic.
   */
  function weldSecond(w, t, fr) {
    const f = fr || weldFrame(w);
    const e = V.add(V.scale(f.e1, w.a * Math.cos(t)), V.scale(f.e2, w.b * Math.sin(t)));
    if (!f.profile) return V.scale(e, -1);
    const d = V.add(V.scale(f.e1, -w.a * Math.sin(t)), V.scale(f.e2, w.b * Math.cos(t)));
    return V.add(V.scale(e, f.profile.d2(t) - 1 - f.profile.s(t)),
      V.scale(d, 2 * f.profile.d1(t)));
  }

  /**
   * Ellipse parameter t at a GEOMETRIC clock angle (rad, from u toward v).
   *
   * Closed form. In the (e1, e2) basis the geometric angle is `clock - roll`,
   * and (a cos t, b sin t) must be parallel to (cos psi, sin psi) with a
   * positive factor, so t = atan2(a sin psi, b cos psi).
   *
   * THE PROFILE DOES NOT ENTER, and that is a theorem rather than an
   * approximation: the deviation scales the point along its own ray from c by
   * 1 + s(t), which for 1 + s(t) > 0 leaves the direction -- hence the clock
   * angle -- untouched. So the seam point, the floor landing line and every
   * mated-edge guarantee built on this pair of functions carry over to a
   * profiled weld unchanged. Where 1 + s(t) <= 0 the point has been pushed
   * through the centre and the identity fails; `validate` warns about exactly
   * that case, and it is the only thing it has to warn about (see the header).
   */
  function paramAtClock(w, clock) {
    const psi = clock - w.roll;
    return Math.atan2(w.a * Math.sin(psi), w.b * Math.cos(psi));
  }

  /** The inverse: geometric clock angle of the point at parameter t. */
  function clockAtParam(w, t) {
    return w.roll + Math.atan2(w.b * Math.sin(t), w.a * Math.cos(t));
  }

  /** The seam point's ellipse parameter. */
  const seamParam = (w) => paramAtClock(w, w.seam);

  /** Exact perimeter of the weld ellipse, by Gauss-Legendre on |dP/dt|. */
  function weldPerimeter(w, subdivisions) {
    const Q = E.quad;
    const f = weldFrame(w);
    return Q.integrate((t) => V.len(weldTangent(w, t, f)), 0, 2 * Math.PI,
      subdivisions || 64);
  }

  /**
   * The mirror image of a weld across y = 0.
   *
   * The normal is mirrored AND negated: the mirror reverses the ring's
   * traversal sense, and `n` is defined as pointing along traversal. With
   * that convention (verified in tests/engine.test.js):
   *
   *   u' = mirrorY(u),  v' = mirrorY(v),  roll' = roll,  seam' = seam
   *
   * so the mirrored weld's point at parameter t is EXACTLY mirrorY of the
   * original's point at t -- and, for a self-mirroring span, the ruling
   * correspondence is the identity with the ruling parallel to y. That is the
   * closed-form extrusion the geometry review (finding 1b) asks for; it
   * appears there as phi = pi - theta only because that review parametrises
   * the mirrored weld with the opposite orientation.
   *
   * THE PROFILE CARRIES OVER UNCHANGED, and the extrusion stays exact with it:
   * the mirror is linear, so mirrorY(c + lambda*E(t)) = mirrorY(c) +
   * lambda*mirrorY(E(t)) for the radial factor lambda = 1 + s(t) exactly as for
   * lambda = 1. Copied rather than shared, so no consumer can reach a stored
   * weld's array through the derived ring.
   */
  function mirrorWeld(w) {
    return {
      id: w.id,
      c: V.mirrorY(w.c),
      n: V.scale(V.mirrorY(w.n), -1),
      a: w.a, b: w.b, roll: w.roll, seam: w.seam,
      onCentreplane: w.onCentreplane,
      profile: w.profile ? { k: w.profile.k.slice() } : null,
    };
  }

  // ------------------------------------------------------------------
  // The derived ring
  // ------------------------------------------------------------------

  /**
   * Derive the FULL weld ring and its segments from the stored (port) half.
   *
   * Deterministic, and the only place the mirror happens (spec 3.4b's
   * "exactly one place in the code performs the mirror").
   *
   *   stored:  W0 W1 W2 W3*                       (* = onCentreplane)
   *   ring:    W0 W1 W2 W3* M(W2) M(W1) M(W0)
   *   segs:    W0-W1  W1-W2  W2-W3   port
   *            W3-M(W2)  M(W2)-M(W1)  M(W1)-M(W0)  starboard (mirrors, reversed)
   *            M(W0)-W0                             span (self-mirroring bridge)
   *
   * A stored weld that is `onCentreplane` is emitted once (it is its own
   * mirror). If the FIRST stored weld is not on the centreplane the ring
   * closes through a bridge span; if it is, the ring closes at that weld and
   * there is no span. That single rule covers both spec 3.4 tip phases --
   * `seam-on-axis` (pointed: weld on the plane) and `panel-on-axis` (bridged:
   * span between a mirror pair) -- with no flags, which is the whole point of
   * the weld-first model.
   *
   * @returns {{welds: Array, segments: Array}} ring welds carry
   *   `{weld, sourceId, mirrored, ringIndex}`; segments carry
   *   `{index, id, role, A, B, sourceSegment, selfMirroring}`.
   */
  function ring(doc) {
    const stored = doc.welds;
    const n = stored.length;
    const welds = [];
    const push = (w, sourceId, mirrored) => {
      welds.push({ weld: w, sourceId, mirrored, ringIndex: welds.length });
    };
    for (let i = 0; i < n; i++) push(stored[i], stored[i].id, false);

    if (doc.mirror) {
      const first = stored[0].onCentreplane ? 1 : 0;
      const last = stored[n - 1].onCentreplane ? n - 2 : n - 1;
      for (let i = last; i >= first; i--) push(mirrorWeld(stored[i]), stored[i].id, true);
    }

    const N = welds.length;
    const segments = [];
    for (let i = 0; i < N; i++) {
      const A = welds[i], B = welds[(i + 1) % N];
      let role, selfMirroring = false;
      if (A.mirrored === B.mirrored) {
        // Both stored, or both mirrored: an ordinary port / starboard panel.
        role = A.mirrored ? 'starboard' : 'port';
      } else if (A.sourceId === B.sourceId) {
        // A weld and its own mirror bracket this segment: it is a BRIDGE SPAN
        // straddling the centreplane, self-mirroring, emitted once (spec 3.4
        // `panel-on-axis`). This is the only place the ring can produce one.
        role = 'span';
        selfMirroring = true;
      } else {
        // The turn AT a centreplane weld (spec 3.4 `seam-on-axis`): the ring
        // simply carries on to the mirrored half. An ordinary starboard panel.
        role = 'starboard';
      }
      segments.push({
        index: i, role, selfMirroring,
        A: A, B: B,
        id: segmentId(A, B, role),
        sourceSegment: null,
      });
    }
    // Wire every starboard segment to the port segment it mirrors. The port
    // list runs 0..P-1; starboard runs backwards from the tail.
    const portCount = segments.filter((s) => s.role === 'port').length;
    let k = portCount - 1;
    for (const s of segments) {
      if (s.role === 'starboard') { s.sourceSegment = k; k -= 1; }
    }
    return { welds, segments };
  }

  function segmentId(A, B, role) {
    if (role === 'span') return 'S' + A.sourceId + '~span';
    const base = 'S' + A.sourceId + '-' + B.sourceId;
    return role === 'starboard' ? base + '~m' : base;
  }

  /**
   * Display labels, spec 8.6: L1..Ln forward-to-aft on port, R1..Rn on
   * starboard, BOW/STERN for a self-mirroring span or a centreplane turn.
   * RECOMPUTED per render, never stored -- that is what makes the stable ids
   * above worth having.
   */
  function labels(doc, r) {
    const rg = r || ring(doc);
    const out = {};
    const portCount = rg.segments.filter((x) => x.role === 'port').length;
    let l = 0, s = 0;
    for (const seg of rg.segments) {
      if (seg.role === 'port') out[seg.id] = 'L' + (++l);
      else if (seg.role === 'starboard') out[seg.id] = 'R' + (portCount - (s++));
      else out[seg.id] = seg.A.weld.c[0] > 0 ? 'BOW' : 'STERN';
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Operations. Every op is total: it mutates a copy and returns it.
  // ------------------------------------------------------------------

  /**
   * addSeam: insert a weld interpolated between the stored welds bounding
   * stored segment `segIdx`, at fraction f.
   *
   * Stable ids: the new weld takes doc.nextId; EVERY EXISTING WELD KEEPS ITS
   * ID (architecture review 5). Only array positions shift.
   */
  function addSeam(doc, segIdx, f) {
    const d = clone(doc);
    const A = d.welds[segIdx], B = d.welds[segIdx + 1];
    if (!A || !B) throw new Error('addSeam: no stored segment ' + segIdx);
    const s = f == null ? 0.5 : f;
    const w = {
      id: d.nextId++,
      c: V.lerp(A.c, B.c, s),
      // Normals interpolate by normalised lerp. Both are unit and the turn per
      // joint is well under 90 deg on any buildable boat (spec 3.4), so slerp
      // buys nothing a test could see.
      n: V.norm(V.lerp(A.n, B.n, s)),
      a: A.a + (B.a - A.a) * s,
      b: A.b + (B.b - A.b) * s,
      roll: A.roll + V.wrapPi(B.roll - A.roll) * s,
      seam: A.seam + V.wrapPi(B.seam - A.seam) * s,
      onCentreplane: false,
      profile: null,
    };
    d.welds.splice(segIdx + 1, 0, normaliseWeld(w));
    d.welds[segIdx + 1].id = w.id;
    return d;
  }

  /** removeSeam: delete stored weld `idx`; its neighbours re-loft. */
  function removeSeam(doc, idx) {
    const d = clone(doc);
    if (d.welds.length <= 2) throw new Error('removeSeam: a boat needs 2 welds');
    d.welds.splice(idx, 1);
    return d;
  }

  const byId = (doc, id) => doc.welds.findIndex((w) => w.id === id);

  /** setWidth: the horizontal handle. Holds b, per geometry review 5. */
  function setWidth(doc, idx, a) {
    const d = clone(doc);
    d.welds[idx].a = a;
    return d;
  }

  /**
   * setHeight: the vertical handle. With the uniform-b LOCK engaged (default
   * ON, plan line 46) this edits every weld together; unlocked it edits one.
   * The lock lives in the document so it undoes and shares.
   */
  function setHeight(doc, idx, b) {
    const d = clone(doc);
    if (d.locks.uniformB) for (const w of d.welds) w.b = b;
    else d.welds[idx].b = b;
    return d;
  }

  /** dragSeam: move and/or tilt the weld plane. */
  function dragSeam(doc, idx, patch) {
    const d = clone(doc);
    const w = d.welds[idx];
    if (patch.c) w.c = [+patch.c[0], +patch.c[1], +patch.c[2]];
    if (patch.n) w.n = V.norm([+patch.n[0], +patch.n[1], +patch.n[2]]);
    if (w.onCentreplane) {
      // A centreplane weld may translate fore/aft and vertically but must not
      // leave y = 0, or the half-ring representation stops closing
      // (interaction review 16).
      w.c[1] = 0;
      w.n = V.norm([0, w.n[1] < 0 ? -1 : 1, 0]);
    }
    return d;
  }

  function setRoll(doc, idx, roll) {
    const d = clone(doc); d.welds[idx].roll = roll; return d;
  }

  function setSeamPoint(doc, idx, clock) {
    const d = clone(doc); d.welds[idx].seam = clock; return d;
  }

  function setFloor(doc, patch) {
    const d = clone(doc);
    d.floor = Object.assign({}, d.floor, patch);
    return d;
  }

  const api = {
    SCHEMA, DEG, TAU, CENTREPLANE_TOL,
    PROFILE_MIN_KNOTS, PROFILE_DEFAULT_KNOTS, PROFILE_MAX_KNOTS, PROFILE_MIN_FACTOR,
    defaults, create, validate, toJSON, fromJSON, clone, normaliseWeld, unitish,
    normaliseProfile, profilesEqual, profilePrepare, profileStations,
    profileToStations, profileFromStations, profileSpec,
    weldFrame, weldBase, weldFactor, weldPoint, weldTangent, weldSecond,
    paramAtClock, clockAtParam, seamParam, weldPerimeter, mirrorWeld,
    ring, labels, segmentId, byId,
    addSeam, removeSeam, setWidth, setHeight, dragSeam, setRoll,
    setSeamPoint, setFloor,
  };

  E.doc = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
