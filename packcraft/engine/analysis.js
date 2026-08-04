/**
 * engine/analysis.js -- THE OBSERVERS. They read the boat; they never own it.
 *
 * ---------------------------------------------------------------------------
 * THE CARDINAL RULE (plan, "The expansions"): analysis READS the geometry, it
 * never OWNS it.
 *
 * Nothing in this file mutates a document, nothing in it is stored in one, and
 * nothing it produces reaches the permalink or the cutting pattern. A pattern
 * carries no hydrostatics: a builder traces an outline, and the outline must
 * not depend on how heavy the paddler said they were. The load and the pressure
 * are UI state, passed in per call.
 *
 * Its outputs are ADVISORIES. Every issue this file emits carries
 * `blocksExport: false` and `tier: 'analysis'`, and `checks.exportGate` never
 * sees them -- export blocks on developability alone, exactly as it did before
 * this file existed. If a boat is un-buildable the gates say so; if a boat is a
 * poor boat, this file says so, and the user is still allowed to build it.
 *
 * ---------------------------------------------------------------------------
 * 1. FLOTATION -- THE BOAT IS ONE HULL, NOT TWO TUBES
 *
 * The single most important thing carried over from the old engine's analysis
 * (packraft-core/analysis.js, ported in SPIRIT only -- engine/ may not resolve
 * packraft-core, and tests/engine.test.js E7.1 enforces it):
 *
 *   THE FLOOR IS A DISPLACING SURFACE. The watertight floor spans between the
 *   tubes at the landing line, so the "bathtub" above it and below the
 *   waterline displaces water exactly as a canoe's hull does. Counting only
 *   the immersed tubes floated the old reference boat at 119 mm when it should
 *   have sat near 65 mm, because the bathtub was carrying more than half the
 *   displacement. The measured share on this engine's kit preset is reported
 *   by tests/engine-analysis.test.js and is of the same order.
 *
 * Three consequences follow from the same fact, and all three are here:
 *   - the wetted area EXCLUDES the tube's inboard face above the floor: that
 *     surface is inside the boat and dry;
 *   - the floor's underside is fully wetted, and it is a big flat area;
 *   - RESERVE buoyancy stays TUBE-ONLY. That is the right definition: it asks
 *     what still floats you once the bathtub is full.
 *
 * HOW IT IS COMPUTED HERE. The weld engine hands us an exact faceted solid --
 * `develop2.build` emits `startEdge3D[i]`/`endEdge3D[i]` as the two ends of
 * ruling i, so the ruling quads tile a closed torus (the panel contract). So:
 *
 *   IMMERSED TUBE VOLUME, by the divergence theorem with F = (0, 0, z - wl):
 *
 *       div F = 1, so  V = INT_dOmega F . n dA
 *
 *     and F VANISHES ON THE WATERPLANE, so the free-surface cap contributes
 *     nothing and there is no cap to triangulate. Clip each ruling triangle to
 *     z <= wl and sum (zbar - wl) * (outward area vector)_z. Exact for the
 *     faceted solid -- the same solid `develop2.enclosedVolume` measures.
 *
 *     At a waterline above the whole boat the two integrals must agree, and
 *     they agree to ~1e-4 RELATIVE rather than to machine precision. That gap
 *     is real and it is not this file's: adjacent panels sample their SHARED
 *     weld on different theta grids (each panel's ruling grid starts at its own
 *     weld A's seam parameter), so the ruling mesh has hairline T-junctions at
 *     every girth joint. Two different divergence fields see a different flux
 *     through them. On the kit preset it is 34 mL on a 393 L boat -- three
 *     hundredths of a litre, four orders below anything a builder could
 *     measure -- so it is REPORTED (`flotation().residual`) rather than fixed:
 *     re-sampling both panels onto a common grid would change the cutting
 *     patterns, and the patterns are the product.
 *
 *   BATHTUB VOLUME, by transverse stations. At station x the channel between
 *     the tubes has half-width `channelHalf(z)` = the distance from the
 *     centreplane to the FIRST tube surface met walking outboard, or zero when
 *     the centreplane is itself inside a tube (which is exactly what happens at
 *     a bridged bow or a pointed stern, where the two tubes merge and the
 *     bathtub correctly stops existing). The floor level at that station is the
 *     landing line's own height there. Then
 *
 *       A_bathtub(x, wl) = INT_{zFloor(x)}^{min(wl, sheer(x))} 2*channelHalf dz
 *
 *     tabulated once per build as a cumulative integral, so the waterline
 *     rootfind costs one binary search per station per iteration.
 *
 * NUMERICAL HYGIENE, and read the plan's tolerance philosophy before tightening
 * anything here. This is a FABRIC-tier number for a DIY builder. The waterline
 * is bisected to 0.01 mm -- a hundred times finer than anyone can measure a
 * boat sitting in a river, and cheap because displacement is monotone in z.
 * The station count (160) and the channel z-grid (64) are chosen so that
 * doubling either moves the answer by well under a millimetre of waterline;
 * `flotation` reports `refine` so that claim is a number rather than a comment.
 * Do NOT spend quadrature getting micrometres: the boat is welded with an iron.
 *
 * ---------------------------------------------------------------------------
 * 2. HOOP -- R_max = a^2/b, AND WHY IT IS A BAND
 *
 * For an ellipse x = a cos t, y = b sin t the curvature radius is largest at
 * the MINOR-axis vertex (crown and keel) and equals max(a,b)^2 / min(a,b)
 * exactly (notes/plan-review-geometry.md finding 11 verifies it at a = 320,
 * b = 160: R = 640.00 mm at the crown, 80.00 mm at the widest point). Laplace
 * for a long tube gives hoop tension N = p * R_local, so
 *
 *       N_max = p * max(a,b)^2 / min(a,b),     N_max / (p*b) = (a/b)^2
 *
 * -- the rise is QUADRATIC in aspect. Widening a weld at constant height by 2x
 * does not "raise" the skin load, it QUADRUPLES it. That is the number the plan
 * asks this observer to say out loud.
 *
 * BUT IT IS AN UPPER BOUND, not the design load, and reporting it alone is
 * misleading in both directions (same review, amendment (b)). An oblong section
 * is not a membrane equilibrium: the fabric cannot hold it, so mid-segment the
 * tube relaxes toward a circle of the same DEVELOPED PERIMETER, radius P/2pi.
 * So this observer reports a BAND -- `tensionRelaxed` (mid-segment, relaxed) to
 * `tensionHeld` (at the weld, where the seam holds the section open) -- and
 * grades on the held value, because that is where the weld is.
 *
 * WHERE THE LOAD LANDS (amendment (c)): R_max is at the crown and the KEEL, and
 * spec 3.7 puts the longitudinal seam at the floor line, ~10 deg off the keel.
 * So on an oblong section the most loaded seam sits essentially at the most
 * loaded point. The advisory says so when the seam is within 30 deg of the
 * minor-axis vertex, because it is an argument for clocking the seam away --
 * which conflicts with 3.7's derivation of the seam from the floor tab, and a
 * conflict flagged is worth more than a conflict silently inherited.
 *
 * THE THRESHOLDS, and why they are a fraction of FABRIC strength rather than of
 * weld strength. 210D TPU-coated nylon runs ~50 N/mm warp (2500 N / 50 mm,
 * verified). A packraft at 0.15 psi with a 150 mm tube pulls 0.155 N/mm: the
 * fabric is thirty times over-strength and it is NOT the failure mode. The weld
 * is: a measured RF bond is 3.57 N/mm at 3.2 mm bond width, and an iron weld is
 * unverified. So the advisory fires at 10% of fabric warp -- 5 N/mm, which is
 * already 1.4x the measured bond, i.e. the point past which the SEAM is
 * certainly the limit whatever the fabric does -- and warns at 20%. Both are
 * reported alongside the raw bond factor so a builder can see which number is
 * biting. Neither ever blocks anything.
 *
 * ---------------------------------------------------------------------------
 * 3. suggestSeams -- A PROPOSAL, NEVER A MUTATION
 *
 * "Suggest seams: the min-max DP becomes a button -- place my N seams
 * optimally -- writing welds like any other edit." (plan, "The expansions".)
 * The cardinal rule applies at full strength: this function RETURNS a proposal.
 * It does not edit the document. `applySuggestion` replays the proposal through
 * `ops.addSeam` / `ops.dragSeam` / `ops.setWidth` ONE AT A TIME, so every step
 * carries its own inverse and the undo stack means what it always meant.
 *
 * WHAT IT PROPOSES, and the lesson it encodes: NO SINGLE MITRE OVER ~55 DEG
 * EXCEPT AT A TIP. Every template in the library grew a corner weld for exactly
 * this reason -- "without it the ~81 deg plan turn from side tube to span sat on
 * one mitre and all four corners of the raft read as a rectangle from above"
 * (templates.js), and the kit's bow splits its turn 64/25 over two welds. A
 * corner is split by ROUNDING it: the two (or more) welds sit on a fillet arc
 * across the corner, each taking its share of the plan turn. The fillet radius
 * is not a taste parameter -- it is the smallest radius that still satisfies
 * spec 3.4, in closed form:
 *
 *     chord between consecutive stations  2 R sin(phi/2)
 *     the two mitres consume              2 b tan(phi/2)
 *     so spec 3.4 needs                   R > b / cos(phi/2)
 *
 * with a margin on top, and capped by the length of the legs it has to fit
 * between. Tips are exempt: a centreplane weld IS the turn, and rounding it
 * would delete the pointed end the user asked for.
 * ---------------------------------------------------------------------------
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js'); require('./quad.js'); require('./doc.js');
    require('./loft.js'); require('./develop2.js'); require('./checks.js');
    require('./ops.js');
  }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const D = E.doc;
  const DV = E.develop2;
  const CK = E.checks;
  const OPS = E.ops;

  const TAU = 2 * Math.PI;
  const DEG = Math.PI / 180;

  const CONST = {
    /** Standard gravity, m/s^2. Only used to talk about kilograms. */
    G: 9.80665,
    /** Fresh water, kg/mm^3. 1000 kg/m^3. Salt water is 1.025e-6. */
    RHO_FRESH: 1e-6,
    RHO_SALT: 1.025e-6,
    /** Paddler + gear, kg. The default load a packraft is designed around. */
    DEFAULT_LOAD_KG: 100,
    /**
     * Operating pressure, Pa. 0.15 psi = 1034 Pa is where a packraft actually
     * runs: hand-pumped through an inflation bag, firm to the thumb, nowhere
     * near a whitewater raft's 2-3 psi. Stored in Pa (= N/m^2); the membrane
     * formulas want N/mm^2, hence the 1e-6.
     */
    DEFAULT_PRESSURE_PA: 1034,
    PA_TO_N_PER_MM2: 1e-6,
    /** 210D TPU-coated nylon, warp tensile, N/mm (2500 N / 50 mm). */
    FABRIC_TENSILE: 50,
    /** Measured RF weld bond, N/mm, from a 3.2 mm wide weld. */
    WELD_BOND: 3.57,
    /** Hoop advisory bands, as a fraction of fabric warp tensile. */
    HOOP_ADVISORY_FRACTION: 0.10,
    HOOP_WARN_FRACTION: 0.20,
    /** Seam-at-crown proximity that earns a mention, radians. */
    SEAM_AT_CROWN_RAD: 30 * DEG,
    /** Reserve-ratio band a packraft is usually sized into (spec 5.1). */
    RESERVE_MIN: 2.5,
    RESERVE_MAX: 4.5,
    /** Freeboard advisory: fraction of tube height wanted amidships. */
    FREEBOARD_FRACTION: 0.45,
  };

  const MODEL_DEFAULTS = {
    /** Transverse stations for the bathtub integral. */
    stations: 160,
    /** Samples up the channel per station, for the cumulative area table. */
    channelSamples: 64,
    /** Waterline bisection tolerance, mm. Fabric wants 1; this is free. */
    waterlineTolMm: 0.01,
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

  // ==================================================================
  // The hull model: everything the flotation integrals read, once
  // ==================================================================

  /**
   * Flatten the ruling quads of every panel into OUTWARD-oriented triangles.
   *
   * Orientation is MEASURED, not assumed: sum the signed volume with one fixed
   * vertex order and flip if it came out negative. (It does: the ring's
   * traversal winds the quads inward. `develop2.enclosedVolume` takes an
   * absolute value and never has to care; an integral over the surface does.)
   *
   * `outboard` marks the triangles on the OUTBOARD side of the longitudinal
   * seam. Ruling index 0 is the seam itself and theta increases INBOARD (the
   * clock angle grows from the seam toward the boat's interior -- the same
   * convention that makes develop2's tab band walk theta DOWNWARD to reach the
   * outboard face), so indices past the half-turn are the outboard band: the
   * fabric that is actually in the water. Everything inboard of the seam is the
   * bathtub's wall, and it is dry.
   */
  function triangulate(built) {
    const tris = [];
    for (const panel of built.panels) {
      const A = panel.startEdge3D, B = panel.endEdge3D;
      const R = A.length - 1;
      for (let i = 0; i < R; i++) {
        const outboard = (i + 0.5) > R / 2;
        tris.push({ p: [A[i], B[i], B[i + 1]], outboard });
        tris.push({ p: [A[i], B[i + 1], A[i + 1]], outboard });
      }
    }
    let v6 = 0;
    for (const t of tris) v6 += tripleProduct(t.p[0], t.p[1], t.p[2]);
    const sign = v6 < 0 ? -1 : 1;
    return { tris, sign, volume: Math.abs(v6) / 6 };
  }

  function tripleProduct(a, b, c) {
    return a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }

  /** Sutherland-Hodgman against the half-space z <= zc. */
  function clipBelow(poly, zc) {
    const out = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const da = a[2] - zc, db = b[2] - zc;
      if (da <= 0) out.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, zc]);
      }
    }
    return out;
  }

  /**
   * The two numbers a clipped face contributes: its z-flux (which integrates to
   * volume) and its area (which integrates to wetted surface).
   *
   * For a PLANAR polygon and a LINEAR integrand, INT (z - zc) n_z dA is exactly
   * (zbar - zc) * (area vector)_z, so a fan triangulation gives the exact answer
   * with no quadrature at all.
   */
  function faceBelow(poly, zc, sign) {
    const p = clipBelow(poly, zc);
    if (p.length < 3) return { flux: 0, area: 0 };
    let flux = 0, area = 0;
    for (let i = 1; i < p.length - 1; i++) {
      const a = p[0], b = p[i], c = p[i + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = 0.5 * (uy * vz - uz * vy);
      const ny = 0.5 * (uz * vx - ux * vz);
      const nz = 0.5 * (ux * vy - uy * vx);
      flux += ((a[2] + b[2] + c[2]) / 3 - zc) * nz * sign;
      area += Math.hypot(nx, ny, nz);
    }
    return { flux, area };
  }

  /**
   * The landing line, as functions of x: where the floor sits and how wide it
   * is at each station.
   *
   * The floor's edge IS the landing line (develop2.buildFloor), so its height
   * and its half-width both come straight off `floor.landing3D`. The port half
   * is taken and sorted by x: on every document the engine can express, the
   * stored welds run bow to stern down one side, so that ordering is monotone.
   * A pathological centreline that doubles back would sort oddly here -- and
   * this is a readout, not a gate, so it says so rather than refusing.
   */
  function landingProfile(built) {
    const pts = [];
    for (const q of built.floor.landing3D) {
      if (q[1] >= -1e-9) pts.push([q[0], Math.max(0, q[1]), q[2]]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    const xs = [], ys = [], zs = [];
    for (const q of pts) {
      if (xs.length && Math.abs(q[0] - xs[xs.length - 1]) < 1e-9) continue;
      xs.push(q[0]); ys.push(q[1]); zs.push(q[2]);
    }
    const at = (x) => {
      if (xs.length < 2 || x < xs[0] || x > xs[xs.length - 1]) return null;
      let i = 0;
      while (i < xs.length - 2 && xs[i + 1] < x) i++;
      const f = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return { z: zs[i] + (zs[i + 1] - zs[i]) * f, y: ys[i] + (ys[i + 1] - ys[i]) * f };
    };
    return { at, x0: xs.length ? xs[0] : 0, x1: xs.length ? xs[xs.length - 1] : 0,
      count: xs.length };
  }

  /**
   * The transverse section of the tube mesh at x = X, as (y, z) segments.
   *
   * Not assembled into loops: the only questions asked of it are "how many
   * times does a horizontal ray from the centreplane cross the surface" and
   * "where first", and both are answered from loose segments. Loop assembly
   * would be more code and would have to cope with a mesh that meets itself at
   * the tips.
   */
  function sectionSegments(tris, X) {
    const segs = [];
    for (const t of tris) {
      const p = t.p;
      const d0 = p[0][0] - X, d1 = p[1][0] - X, d2 = p[2][0] - X;
      if ((d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0)) continue;
      const hit = [];
      const edge = (a, b, da, db) => {
        if ((da <= 0 && db > 0) || (da > 0 && db <= 0)) {
          const f = da / (da - db);
          hit.push([a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
        }
      };
      edge(p[0], p[1], d0, d1);
      edge(p[1], p[2], d1, d2);
      edge(p[2], p[0], d2, d0);
      if (hit.length >= 2) segs.push([hit[0][0], hit[0][1], hit[1][0], hit[1][1]]);
    }
    return segs;
  }

  /**
   * Half-width of the DRY CHANNEL between the tubes at height z, and the top of
   * the hull there.
   *
   * Walk outboard from the centreplane and count crossings: an ODD count means
   * the centreplane itself is inside a tube -- the two tubes have merged, which
   * is exactly what a bridged bow and a pointed stern do -- and the channel does
   * not exist there. An EVEN, non-zero count puts the first crossing at the
   * tube's inboard face, and that is the channel's half-width.
   */
  function channelHalfAt(segs, z) {
    let count = 0, best = Infinity;
    for (const s of segs) {
      const z0 = s[1], z1 = s[3];
      if ((z0 <= z) === (z1 <= z)) continue;
      const f = (z - z0) / (z1 - z0);
      const y = s[0] + (s[2] - s[0]) * f;
      if (y > 0) { count++; if (y < best) best = y; }
    }
    if (count === 0 || (count & 1)) return 0;
    return best;
  }

  /**
   * Everything the waterline rootfind needs, computed ONCE per build.
   *
   * The expensive part -- sectioning the mesh and tabulating the channel -- does
   * not depend on the waterline, so it happens here and the rootfind reads
   * tables. `cum[k]` is the bathtub AREA of station i accumulated from the floor
   * up to `zGrid[k]`, so the area at any waterline is one interpolation.
   */
  function hullModel(built, opts) {
    const o = Object.assign({}, MODEL_DEFAULTS, opts || {});
    const t0 = triangulate(built);
    const land = landingProfile(built);

    let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (const t of t0.tris) {
      for (const q of t.p) {
        if (q[0] < xMin) xMin = q[0];
        if (q[0] > xMax) xMax = q[0];
        if (q[2] < zMin) zMin = q[2];
        if (q[2] > zMax) zMax = q[2];
      }
    }

    const N = o.stations;
    const dx = (xMax - xMin) / N;
    const stations = [];
    for (let i = 0; i < N; i++) {
      const x = xMin + (i + 0.5) * dx;
      const segs = sectionSegments(t0.tris, x);
      if (!segs.length) continue;
      let sTop = -Infinity, sBot = Infinity;
      for (const s of segs) {
        sTop = Math.max(sTop, s[1], s[3]);
        sBot = Math.min(sBot, s[1], s[3]);
      }
      const st = { x, dx, segs, sheer: sTop, keel: sBot, floor: null, floorHalf: 0,
        zGrid: null, cum: null };
      const lf = land.at(x);
      if (lf && lf.z < sTop) {
        // The bathtub runs from the floor to the sheer. Above the sheer there
        // is no boat left to hold water in, and that height is where the
        // swamping load is defined.
        const M = o.channelSamples;
        const z0 = lf.z, z1 = sTop;
        const h = (z1 - z0) / M;
        const zGrid = new Float64Array(M + 1);
        const cum = new Float64Array(M + 1);
        let prev = 2 * channelHalfAt(segs, z0);
        zGrid[0] = z0; cum[0] = 0;
        for (let k = 1; k <= M; k++) {
          const z = z0 + k * h;
          const wNow = 2 * channelHalfAt(segs, z);
          cum[k] = cum[k - 1] + 0.5 * (prev + wNow) * h;
          zGrid[k] = z;
          prev = wNow;
        }
        st.floor = z0;
        st.floorHalf = lf.y;
        st.zGrid = zGrid;
        st.cum = cum;
      }
      stations.push(st);
    }

    let sheerMin = Infinity, sheerMinX = 0;
    for (const st of stations) {
      if (st.sheer < sheerMin) { sheerMin = st.sheer; sheerMinX = st.x; }
    }
    // The midbody sheer -- over the floor, where the paddler and the cockpit
    // opening are. Reported separately because at the tips the hull tapers to a
    // wedge and its "sheer" is the tip itself, which reads alarmingly low on a
    // perfectly sound boat (the same trap the old analysis fell into).
    let sheerMidMin = Infinity, sheerMidX = 0;
    for (const st of stations) {
      if (st.floor == null) continue;
      if (st.sheer < sheerMidMin) { sheerMidMin = st.sheer; sheerMidX = st.x; }
    }

    return {
      built, tris: t0.tris, sign: t0.sign, airVolume: t0.volume,
      stations, landing: land,
      bounds: { xMin, xMax, zMin, zMax },
      sheerMin, sheerMinX,
      sheerMidMin: isFinite(sheerMidMin) ? sheerMidMin : sheerMin,
      sheerMidX,
      floorArea: built.floor.netArea,
      opts: o,
    };
  }

  /** Bathtub area of one station at a waterline, from its cumulative table. */
  function bathtubArea(st, wl) {
    if (st.floor == null || wl <= st.floor) return 0;
    const g = st.zGrid, cum = st.cum, n = g.length - 1;
    if (wl >= g[n]) return cum[n];
    const h = g[1] - g[0];
    const k = Math.min(n - 1, Math.max(0, Math.floor((wl - g[0]) / h)));
    const f = (wl - g[k]) / h;
    return cum[k] + (cum[k + 1] - cum[k]) * f;
  }

  /**
   * The whole immersion at one waterline.
   *
   * Tube volume is exact for the faceted solid (divergence, no cap). Bathtub
   * volume is the station sum. Wetted area is the OUTBOARD tube band below the
   * waterline plus the floor's underside -- the tube's inboard face above the
   * floor is interior and dry, which is the correction the old model had to
   * make and this one is built around.
   */
  function immersedAt(model, wl) {
    let tube = 0, wettedTube = 0;
    for (const t of model.tris) {
      const f = faceBelow(t.p, wl, model.sign);
      tube += f.flux;
      if (t.outboard) wettedTube += f.area;
    }
    let bath = 0, wettedFloor = 0, beam = 0;
    for (const st of model.stations) {
      bath += bathtubArea(st, wl) * st.dx;
      if (st.floor != null && wl > st.floor) wettedFloor += 2 * st.floorHalf * st.dx;
      if (wl > st.keel && wl < st.sheer) {
        beam = Math.max(beam, 2 * halfBeamAt(model, st, wl));
      }
    }
    return {
      tube: Math.max(0, tube), bathtub: bath, total: Math.max(0, tube) + bath,
      wettedTube, wettedFloor, wetted: wettedTube + wettedFloor, maxBeam: beam,
    };
  }

  /**
   * Waterplane half-beam at a station: the OUTERMOST crossing, because the
   * waterplane is the boat's full section at the surface and not two narrow
   * strips (the bathtub between the tubes is inside the hull).
   *
   * Reads the station's CACHED segments. Re-sectioning the mesh here is what a
   * first draft did, and it cost more than the rest of the rootfind put
   * together: 160 stations x 672 triangles, fifteen times over, for a number
   * nobody reads until the bisection has finished.
   */
  function halfBeamAt(model, st, wl) {
    const segs = st.segs;
    let best = 0;
    for (const s of segs) {
      const z0 = s[1], z1 = s[3];
      if ((z0 <= wl) === (z1 <= wl)) continue;
      const f = (wl - z0) / (z1 - z0);
      const y = Math.abs(s[0] + (s[2] - s[0]) * f);
      if (y > best) best = y;
    }
    return best;
  }

  /**
   * The waterline that floats `displacement` mm^3, by bisection.
   *
   * Displacement is monotone in z (more water, more boat under it), so
   * bisection is unconditionally safe and needs no seed. Returns null when the
   * boat cannot float the load below its own lowest sheer point -- which is not
   * an error, it is the answer: the boat swamps.
   */
  function waterlineFor(model, displacement, opts) {
    const o = Object.assign({}, model.opts, opts || {});
    const lo0 = model.bounds.zMin, hi0 = model.sheerMin;
    if (!(displacement > 0)) return { z: lo0, floats: true, immersed: immersedAt(model, lo0) };
    const top = immersedAt(model, hi0);
    if (top.total < displacement) {
      return { z: null, floats: false, immersed: top, capacity: top.total };
    }
    let lo = lo0, hi = hi0;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (immersedAt(model, mid).total < displacement) lo = mid; else hi = mid;
      if (hi - lo < o.waterlineTolMm) break;
    }
    const z = 0.5 * (lo + hi);
    return { z, floats: true, immersed: immersedAt(model, z) };
  }

  // ==================================================================
  // FLOTATION -- the observer
  // ==================================================================

  /**
   * Float the boat and report what a builder would want to know.
   *
   * @param {object} built  output of develop2.build
   * @param {{loadKg?:number, rho?:number, model?:object, stations?:number,
   *          channelSamples?:number, refine?:boolean}} [opts]
   *   `model` reuses a hull model across calls (the load slider does exactly
   *   that: the geometry has not changed, only the number of kilograms).
   *   `refine` re-runs the whole thing at double resolution and reports how far
   *   the waterline moved -- the honest form of "this is converged".
   * @returns {object} a plain readout. NOTHING here is written to any document.
   */
  function flotation(built, opts) {
    const o = opts || {};
    const model = o.model || hullModel(built, o);
    const loadKg = o.loadKg == null ? CONST.DEFAULT_LOAD_KG : +o.loadKg;
    const rho = o.rho == null ? CONST.RHO_FRESH : +o.rho;
    const displacement = loadKg / rho;                   // mm^3

    const sol = waterlineFor(model, displacement, o);
    const im = sol.immersed;
    const wl = sol.z;

    // Freeboard is measured to the LOWEST point of the hull's upper outline --
    // where water gets in first. On a boat with a wedge tip that point is the
    // tip, so the midbody number (over the floor, where the paddler is) is
    // reported beside it rather than instead of it.
    const freeboard = wl == null ? 0 : model.sheerMin - wl;
    const freeboardMid = wl == null ? 0 : model.sheerMidMin - wl;

    // The load at which the water reaches that lowest sheer point: the boat is
    // not "sunk" (the tubes still float), it is SWAMPED, and from there on the
    // reserve ratio is all there is.
    const capacity = immersedAt(model, model.sheerMin).total;
    const swampLoadKg = capacity * rho;

    const share = im.total > 0 ? im.bathtub / im.total : 0;
    const reserveRatio = displacement > 0 ? model.airVolume / displacement : Infinity;

    const out = {
      loadKg, rho, displacement,
      waterline: wl,
      floats: sol.floats,
      freeboard, freeboardMid,
      sheerMin: model.sheerMin, sheerMinX: model.sheerMinX,
      sheerMidMin: model.sheerMidMin, sheerMidX: model.sheerMidX,
      immersed: {
        tube: im.tube, bathtub: im.bathtub, total: im.total,
        bathtubShare: share, tubeShare: 1 - share,
      },
      wettedArea: im.wetted,
      wettedTube: im.wettedTube,
      wettedFloor: im.wettedFloor,
      maxBeam: im.maxBeam,
      airVolume: model.airVolume,
      reserveRatio,
      swampLoadKg,
      floorArea: model.floorArea,
      model,
    };
    // Closure of the whole model, as a number rather than as a claim: at a
    // waterline above every part of the boat the divergence integral must
    // reproduce the enclosed volume. It does, to the T-junction gap described
    // in the header -- ~1e-4 relative, and worth watching rather than ignoring.
    out.residual = Math.abs(immersedAt(model, model.bounds.zMax + 1).tube
      - model.airVolume) / Math.max(1, model.airVolume);

    if (o.refine) {
      const fine = flotation(built, Object.assign({}, o, {
        model: null,
        stations: model.opts.stations * 2,
        channelSamples: model.opts.channelSamples * 2,
        refine: false,
      }));
      out.refine = {
        waterline: fine.waterline,
        deltaMm: (wl == null || fine.waterline == null) ? null
          : Math.abs(fine.waterline - wl),
        deltaVolume: Math.abs(fine.immersed.total - im.total),
      };
    }

    out.issues = flotationIssues(out);
    return out;
  }

  /**
   * The advisories. Every one of them: tier 'analysis', blocksExport FALSE.
   * A tender boat is still a boat, and the pattern is still an exact
   * development of it.
   */
  function flotationIssues(f) {
    const out = [];
    const at = { analysis: 'flotation' };
    if (!f.floats) {
      out.push(CK.issue({
        id: 'analysis.flotation.swamped', tier: 'analysis', level: 'warn',
        blocksExport: false,
        message: 'at ' + f.loadKg.toFixed(0) + ' kg the water reaches the lowest '
          + 'sheer point before the boat displaces its load: it swamps. The most '
          + 'this hull carries with the sheer dry is '
          + f.swampLoadKg.toFixed(0) + ' kg.',
        value: f.loadKg, tolerance: f.swampLoadKg, toleranceKind: 'kg', where: at,
      }));
      return out;
    }
    out.push(CK.issue({
      id: 'analysis.flotation.waterline', tier: 'analysis', level: 'ok',
      message: 'floats ' + f.loadKg.toFixed(0) + ' kg at z = '
        + f.waterline.toFixed(1) + ' mm; ' + (100 * f.immersed.bathtubShare).toFixed(0)
        + '% of the displacement is the floor bathtub, not the tubes',
      value: f.waterline, toleranceKind: 'mm', where: at,
    }));
    out.push(CK.issue({
      id: 'analysis.flotation.freeboard', tier: 'analysis',
      level: f.freeboard <= 0 ? 'warn' : (f.freeboardMid < 60 ? 'advisory' : 'ok'),
      message: f.freeboard <= 0
        ? 'no freeboard: the sheer is under water at this load'
        : 'freeboard ' + f.freeboard.toFixed(0) + ' mm at the lowest sheer point (x = '
          + f.sheerMinX.toFixed(0) + '), ' + f.freeboardMid.toFixed(0)
          + ' mm over the floor',
      value: f.freeboard, tolerance: 60, toleranceKind: 'mm', where: at,
    }));
    let lvl = 'ok', msg = 'reserve buoyancy ' + f.reserveRatio.toFixed(2)
      + ' (tube air volume over displaced volume)';
    if (f.reserveRatio < CONST.RESERVE_MIN) {
      lvl = 'advisory';
      msg = 'reserve buoyancy ' + f.reserveRatio.toFixed(2) + ' is under '
        + CONST.RESERVE_MIN + ': the boat sits deep and swamps easily. Bigger tube.';
    } else if (f.reserveRatio > CONST.RESERVE_MAX) {
      lvl = 'advisory';
      msg = 'reserve buoyancy ' + f.reserveRatio.toFixed(2) + ' is over '
        + CONST.RESERVE_MAX + ': fabric, weight and seam length spent on volume '
        + 'this load does not need.';
    }
    out.push(CK.issue({
      id: 'analysis.flotation.reserve', tier: 'analysis', level: lvl, message: msg,
      value: f.reserveRatio, tolerance: CONST.RESERVE_MIN, toleranceKind: 'ratio',
      where: at,
    }));
    return out;
  }

  // ==================================================================
  // HOOP -- R_max = a^2/b, and the band around it
  // ==================================================================

  /**
   * The largest curvature radius of a weld's section curve.
   *
   * CLOSED FORM for a plain ellipse: the curvature of (a cos t, b sin t) is
   * ab / (a^2 sin^2 t + b^2 cos^2 t)^{3/2}, smallest at the MINOR-axis vertex,
   * so R_max = max(a,b)^2 / min(a,b) exactly. No sampling, no error term, and
   * it is the number the plan names.
   *
   * NUMERICAL for a profiled section, because a radially modulated ellipse is
   * not a conic and has no such formula: sample kappa = |P' x P''| / |P'|^3 on
   * the curve (doc.js hands back BOTH derivatives analytically, so there is no
   * finite difference anywhere in this) and take the largest radius.
   *
   * THEN POLISH, and the polish is not optional. A uniform cubic B-spline's
   * SECOND derivative is only piecewise linear, so kappa has a kink at every
   * knot -- and on a moulded section the flattest point lands on one. A plain
   * scan of a kinked maximum converges at O(h): measured, the sampled answer
   * was still moving in the third significant figure at 2887 samples, halving
   * per doubling for ever. A golden-section search on the bracket either side
   * of the best sample converges to a kink just as happily as to a smooth peak
   * and gets there in fifty function evaluations, so 360 samples plus a polish
   * beats 23 000 samples without one.
   */
  function maxCurvatureRadius(w, samples) {
    if (!w.profile) {
      const hi = Math.max(w.a, w.b), lo = Math.min(w.a, w.b);
      // The minor-axis vertex: t = pi/2 when a is the major axis, t = 0 when b
      // is. Reported so a UI can draw the point the load lands on.
      return { r: (hi * hi) / lo, t: w.a >= w.b ? Math.PI / 2 : 0, exact: true };
    }
    const N = samples || 360;
    const fr = D.weldFrame(w);
    const kappa = (t) => {
      const p1 = D.weldTangent(w, t, fr);
      const p2 = D.weldSecond(w, t, fr);
      const sp = V.len(p1);
      return V.len(V.cross(p1, p2)) / (sp * sp * sp);
    };
    const step = TAU / N;
    let bestK = Infinity, bestT = 0;
    for (let i = 0; i < N; i++) {
      const t = i * step;
      const k = kappa(t);
      if (k < bestK) { bestK = k; bestT = t; }
    }
    // Golden section on [bestT - step, bestT + step]; the curve is periodic so
    // the bracket may run off either end and it does not matter.
    const G = (Math.sqrt(5) - 1) / 2;
    let lo = bestT - step, hi = bestT + step;
    let c = hi - G * (hi - lo), d = lo + G * (hi - lo);
    let fc = kappa(c), fd = kappa(d);
    for (let i = 0; i < 60 && hi - lo > 1e-12; i++) {
      if (fc < fd) { hi = d; d = c; fd = fc; c = hi - G * (hi - lo); fc = kappa(c); }
      else { lo = c; c = d; fc = fd; d = lo + G * (hi - lo); fd = kappa(d); }
    }
    const t = 0.5 * (lo + hi);
    const k = Math.min(bestK, kappa(t));
    return { r: k > 1e-12 ? 1 / k : Infinity, t: k === bestK ? bestT : t,
      exact: false };
  }

  /**
   * The hoop observer: one reading per stored weld.
   *
   * Starboard is not walked. It is the mirror of port, and a reflection has the
   * same curvature -- reporting it would double every row for no information.
   *
   * @param {object} docOrBuilt  a document, or a build (its `doc` is read)
   * @param {{pressurePa?:number, fabric?:number, bond?:number, samples?:number}} [opts]
   */
  function hoop(docOrBuilt, opts) {
    const o = opts || {};
    const doc = docOrBuilt && docOrBuilt.welds ? docOrBuilt : docOrBuilt.doc;
    const pPa = o.pressurePa == null ? CONST.DEFAULT_PRESSURE_PA : +o.pressurePa;
    const p = pPa * CONST.PA_TO_N_PER_MM2;               // N/mm^2
    const fabric = o.fabric == null ? CONST.FABRIC_TENSILE : +o.fabric;
    const bond = o.bond == null ? CONST.WELD_BOND : +o.bond;

    const welds = doc.welds.map((w) => {
      const rm = maxCurvatureRadius(w, o.samples);
      const perim = D.weldPerimeter(w, o.perimeterPanels || 64);
      const rRelaxed = perim / TAU;
      const held = p * rm.r;
      const relaxed = p * rRelaxed;
      const aspect = Math.max(w.a, w.b) / Math.min(w.a, w.b);
      // Where the load lands, versus where the seam is. The crown/keel of the
      // section is the minor-axis vertex; `clockAtParam` puts both on the same
      // geometric dial so the comparison is meaningful on a rolled weld.
      // A CIRCLE HAS NO CROWN. Curvature is uniform on a=b, so "the seam sits
      // at the R_max point" is true of every clock angle and worth saying about
      // none of them; the flag stays off until the section is actually oblong.
      const crown = D.clockAtParam(w, rm.t);
      const gap = Math.abs(V.wrapPi(w.seam - crown));
      const seamAtCrown = aspect > 1.05
        && Math.min(gap, Math.abs(Math.PI - gap)) <= CONST.SEAM_AT_CROWN_RAD;
      return {
        id: w.id, a: w.a, b: w.b, aspect,
        profiled: !!w.profile, exact: rm.exact,
        rMax: rm.r, rMaxParam: rm.t, rRelaxed, perimeter: perim,
        tensionHeld: held, tensionRelaxed: relaxed,
        utilisation: held / fabric,
        bondFactor: held > 0 ? bond / held : Infinity,
        seamAtCrown,
      };
    });

    const issues = [];
    for (const r of welds) {
      let level = 'ok';
      if (r.utilisation >= CONST.HOOP_WARN_FRACTION) level = 'warn';
      else if (r.utilisation >= CONST.HOOP_ADVISORY_FRACTION) level = 'advisory';
      const band = r.tensionRelaxed.toFixed(2) + '–' + r.tensionHeld.toFixed(2)
        + ' N/mm';
      const msg = level === 'ok'
        ? 'hoop ' + band + ' at ' + (pPa / 6894.76).toFixed(2) + ' psi (R_max '
          + r.rMax.toFixed(0) + ' mm, aspect ' + r.aspect.toFixed(2) + ')'
        : 'weld W' + r.id + ' is ' + r.aspect.toFixed(2) + ':1, so R_max is '
          + r.rMax.toFixed(0) + ' mm and the held hoop load is '
          + r.tensionHeld.toFixed(2) + ' N/mm — '
          + (100 * r.utilisation).toFixed(0) + '% of 210D warp tensile, and '
          + (r.bondFactor < 1 ? 'BEYOND' : 'only ' + r.bondFactor.toFixed(1) + 'x')
          + ' the measured ' + bond + ' N/mm weld bond. Hoop load rises with the '
          + 'SQUARE of the aspect ratio: narrow this weld or raise b.'
          + (r.seamAtCrown ? ' The longitudinal seam sits at the R_max point '
            + '(crown/keel), so the most loaded seam is at the most loaded '
            + 'place — consider clocking it away.' : '');
      issues.push(CK.issue({
        id: 'analysis.hoop', tier: 'analysis', level, blocksExport: false,
        message: msg,
        value: r.tensionHeld, tolerance: CONST.HOOP_ADVISORY_FRACTION * fabric,
        toleranceKind: 'N/mm',
        where: { weld: r.id, analysis: 'hoop' },
      }));
    }
    let worst = null;
    for (const r of welds) if (!worst || r.utilisation > worst.utilisation) worst = r;
    return { pressurePa: pPa, pressurePsi: pPa / 6894.76, fabric, bond, welds,
      worst, issues };
  }

  // ==================================================================
  // suggestSeams -- a PROPOSAL. It returns steps; it never edits.
  // ==================================================================

  const SUGGEST_DEFAULTS = {
    /** No single mitre over this, except at a tip. The corner-split lesson. */
    maxTurnDeg: 55,
    /** How much longer than its own two mitre cuts a new segment must be. */
    slack: 1.6,
    /** Fraction of the shorter adjacent leg the fillet may eat. */
    legFraction: 0.4,
    /**
     * Spec 3.4 slack a proposed segment must keep, as a fraction of what its
     * own two cuts consume. Zero is not the bar: `checks.cutConsumption` calls
     * anything under 0.15 "tight to build", and measured, a segment at 8% slack
     * fails `developability.interleave` outright -- the weld PLANES meet inside
     * the weld curves long before the centres run out of room. So a proposal
     * that lands under this is not returned, it is withdrawn and explained.
     */
    minSlackFraction: 0.15,
    /** How many corners the checker may withdraw before giving up. */
    passes: 6,
  };

  /** The derived ring of CENTRES, port half plus its mirror -- plan turns need it. */
  function ringCentres(doc, welds) {
    const list = welds || doc.welds;
    const out = list.map((w) => w.c.slice());
    if (doc.mirror) {
      const first = list[0].onCentreplane ? 1 : 0;
      const last = list[list.length - 1].onCentreplane ? list.length - 2 : list.length - 1;
      for (let i = last; i >= first; i--) out.push(V.mirrorY(list[i].c));
    }
    return out;
  }

  /** Plan-view turn at each entry of a closed centre ring, radians. */
  function planTurns(ring) {
    const n = ring.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = ring[(i - 1 + n) % n], c = ring[i], q = ring[(i + 1) % n];
      const a = Math.atan2(c[1] - p[1], c[0] - p[0]);
      const b = Math.atan2(q[1] - c[1], q[0] - c[0]);
      out[i] = Math.abs(V.wrapPi(b - a));
    }
    return out;
  }

  /**
   * The stations that round one corner, or null when the corner has no room.
   *
   * k welds on a fillet arc across the corner, each taking its share of the plan
   * turn. Placed at the MIDPOINTS of k equal sub-arcs, which keeps the two end
   * stations off the tangent points -- put them ON the tangent points and the
   * interior stations end up taking twice the turn of the outer ones, which is
   * the opposite of the point.
   *
   * THE RADIUS IS NOT A TASTE PARAMETER. Consecutive stations are 2 R sin(phi/2)
   * apart, and each weld's cut ellipse reaches a sin(phi/2) along that segment
   * (the axis decomposes as cos(phi/2) n + sin(phi/2) e1, so e1.axis IS
   * sin(phi/2)). The sines cancel and spec 3.4 reduces to
   *
   *     R  >  slack * a  =  slack * widen * b / cos(phi/2)
   *
   * -- clean, and note the `widen`: a weld deliberately wider than its mitre
   * value (the kit's bow, at 1.4) needs a proportionally bigger fillet, and a
   * first draft that used b alone proposed a 110 mm segment between two welds
   * that reach 100 mm each. It passed cut-consumption by 8 mm and failed
   * `developability.interleave` by 15.
   *
   * The radius is then capped by the legs the fillet has to fit between. If the
   * cap is below the spec-3.4 minimum the corner CANNOT be split here, and this
   * returns null with a reason rather than proposing something that does not
   * build. A fillet longer than the tube it is filleting is not a proposal, it
   * is a different boat.
   */
  function filletStations(prev, c, next, k, b, widen, o) {
    const din = planUnit(prev, c), dout = planUnit(c, next);
    if (!din || !dout) return { reject: 'degenerate leg' };
    const turn = Math.abs(V.wrapPi(Math.atan2(dout[1], dout[0])
      - Math.atan2(din[1], din[0])));
    if (!(turn > 1e-6)) return { reject: 'no turn' };
    const phi = turn / k;
    // Turn sense: +1 when the path turns left in plan.
    const sense = (din[0] * dout[1] - din[1] * dout[0]) >= 0 ? 1 : -1;

    const rMin = o.slack * Math.max(1, widen) * b / Math.cos(clamp(phi / 2, 0, 1.5));
    const legIn = planDist(prev, c), legOut = planDist(c, next);
    const capD = o.legFraction * Math.min(legIn, legOut);
    const tanHalf = Math.tan(clamp(turn / 2, 0, 1.55));
    const rCap = tanHalf > 1e-9 ? capD / tanHalf : Infinity;
    if (rCap < rMin) {
      return { reject: 'the legs either side are too short to round this corner '
        + 'without breaking spec 3.4 (needs a ' + rMin.toFixed(0) + ' mm fillet, '
        + 'has room for ' + rCap.toFixed(0) + ' mm)' };
    }
    const R = rMin;
    const d = R * tanHalf;

    // Fillet centre: back along the bisector, inside the turn.
    const bis = normalise2([din[0] - dout[0], din[1] - dout[1]]);
    const inward = bis ? [-bis[0], -bis[1]] : null;
    const cosHalf = Math.cos(clamp(turn / 2, 0, 1.55));
    if (!inward || cosHalf < 1e-6) return { reject: 'degenerate corner' };
    const O = [c[0] + inward[0] * (R / cosHalf), c[1] + inward[1] * (R / cosHalf)];
    // The tangent point on the incoming leg, as an angle about O.
    const Tin = [c[0] - din[0] * d, c[1] - din[1] * d];
    const a0 = Math.atan2(Tin[1] - O[1], Tin[0] - O[0]);

    const out = [];
    for (let j = 0; j < k; j++) {
      const arc = (j + 0.5) * turn / k;
      const ang = a0 + sense * arc;
      const x = O[0] + R * Math.cos(ang), y = O[1] + R * Math.sin(ang);
      // z rides the legs: a station on the incoming half of the arc is that far
      // back along the incoming leg, and takes the height it would have had
      // there. The centreline's rocker survives the corner rounding.
      const u = (arc / turn - 0.5) * 2;
      let z;
      if (u < 0) {
        const f = Math.min(1, (-u) * d / Math.max(1e-9, legIn));
        z = c[2] + (prev[2] - c[2]) * f;
      } else {
        const f = Math.min(1, u * d / Math.max(1e-9, legOut));
        z = c[2] + (next[2] - c[2]) * f;
      }
      out.push({ c: [x, y, z], turn: phi });
    }
    return { stations: out, radius: R, setback: d, turn, phi,
      capped: R < rMin - 1e-9 };
  }

  function planUnit(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return l < 1e-9 ? null : [dx / l, dy / l];
  }
  function planDist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
  function normalise2(v) {
    const l = Math.hypot(v[0], v[1]);
    return l < 1e-9 ? null : [v[0] / l, v[1] / l];
  }

  /**
   * suggestSeams: where the welds WANT to be, as a proposal.
   *
   * @param {object} doc
   * @param {{maxTurnDeg?:number, welds?:number, slack?:number,
   *          legFraction?:number}} [opts]
   *   `welds` is a TARGET COUNT of stored welds; the corner rule may need more,
   *   and when it does the corner rule wins and the proposal says so. Fewer is
   *   never proposed: this button adds and moves seams, it never deletes a weld
   *   the user put somewhere on purpose.
   * @returns {object} `{stations, steps, turnsBefore, turnsAfter, issues, ...}`.
   *   `steps` are plain op descriptors for `ops.apply`, in order, computed
   *   against THIS document -- ids of inserted welds are deterministic, so they
   *   are baked in. Apply them to a different document and they mean nothing.
   */
  function suggestSeams(doc, opts) {
    const o = Object.assign({}, SUGGEST_DEFAULTS, opts || {});
    const maxTurn = o.maxTurnDeg * DEG;
    const n = doc.welds.length;
    const ring = ringCentres(doc);
    const turnsBefore = planTurns(ring).slice(0, n);
    const bUniform = doc.welds.reduce((m, w) => Math.max(m, w.b), 0);

    // ---- how many welds each corner deserves -------------------------------
    const k = new Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      if (doc.welds[i].onCentreplane) continue;      // a tip IS the turn
      k[i] = Math.max(1, Math.ceil(turnsBefore[i] / maxTurn - 1e-9));
    }
    // ---- spare welds go to the longest runs --------------------------------
    // Only STORED segments can take one: `ops.addSeam` splits a segment between
    // two stored welds, and a bridge span runs from a weld to its own mirror,
    // so there is nothing to insert into there. Recomputed on every pass,
    // because a corner the checker withdraws hands its welds back to the pool.
    const target = o.welds == null ? 0 : Math.round(+o.welds);
    // `capExtra` is how the checker says "not in THAT segment": a spacing weld
    // that halved a segment the tip weld's own ellipse already fills is
    // withdrawn by lowering the cap there, and the target is met elsewhere.
    const capExtra = new Array(Math.max(0, n - 1)).fill(Infinity);
    const spacing = (withdrawnSet) => {
      const extra = new Array(Math.max(0, n - 1)).fill(0);
      let count = 0;
      for (let i = 0; i < n; i++) count += withdrawnSet.has(i) ? 1 : k[i];
      let guard = 0;
      while (count < target && guard++ < 64) {
        let best = -1, bestLen = 0;
        for (let i = 0; i < n - 1; i++) {
          if (extra[i] >= capExtra[i]) continue;
          const len = planDist(doc.welds[i].c, doc.welds[i + 1].c) / (extra[i] + 1);
          if (len > bestLen) { bestLen = len; best = i; }
        }
        if (best < 0) break;
        extra[best] += 1;
        count += 1;
      }
      return extra;
    };

    // ---- lay out, check spec 3.4, WITHDRAW what does not fit, repeat -------
    //
    // A fillet is only worth proposing if the boat it produces is buildable, so
    // the proposal checks ITSELF: lay the stations out, simulate the ops, run
    // the cut-consumption arithmetic on the result, and if a segment came out
    // too tight, drop the fillet that produced it and go round again. What
    // survives is a proposal every segment of which survives its own cuts --
    // which is what makes it safe to hand to a builder as a preview.
    const rejected = [];
    const withdrawn = new Set();
    let layout = null;
    for (let pass = 0; pass <= o.passes; pass++) {
      const extra = spacing(withdrawn);
      layout = layoutStations(doc, ring, k, extra, withdrawn,
        bUniform, o, rejected);
      // A corner the fillet itself declined is a corner that stays a corner --
      // and its welds go back into the pool the `welds` target draws from, so
      // the spacing has to be recomputed before anything else is judged.
      let grew = false;
      for (const r of rejected) {
        if (!withdrawn.has(r.index)) { withdrawn.add(r.index); grew = true; }
      }
      if (grew && pass < o.passes) continue;
      const cut = worstCutConsumption(layout.doc);
      layout.cut = cut;
      const tight = cut && cut.slack <= o.minSlackFraction * Math.max(1,
        cut.length - cut.slack);
      if (!tight) break;
      // Which weld we invented is to blame? The tightest segment names two, and
      // one of them is either a corner fillet or a spacing insert. Withdraw it
      // -- a spacing weld first, since it was the optional one -- and go round.
      // Only ever withdraws, so the loop cannot cycle.
      const blame = layout.blameFor(cut.where);
      if (!blame) break;
      if (blame.spacing) {
        const i = blame.sourceIndex;
        const was = extra[i] || 0;
        if (!(was > 0) || capExtra[i] <= was - 1) break;
        capExtra[i] = was - 1;
        continue;
      }
      if (withdrawn.has(blame.sourceIndex)) break;
      withdrawn.add(blame.sourceIndex);
      rejected.push({ weld: blame.fromWeld, index: blame.sourceIndex,
        reason: 'rounding this corner left a segment only '
          + cut.slack.toFixed(0) + ' mm longer than its own two mitre cuts '
          + '(spec 3.4 needs real slack, not a positive number)' });
    }

    const stations = layout.stations;
    const turnsAfter = layout.turnsAfter;

    // ---- what the proposal is worth ---------------------------------------
    const issues = [];
    let worstTurn = 0;
    stations.forEach((s, i) => {
      if (!s.onCentreplane) worstTurn = Math.max(worstTurn, turnsAfter[i]);
    });
    const before = turnsBefore.reduce((m, t, i) =>
      doc.welds[i].onCentreplane ? m : Math.max(m, t), 0);
    issues.push(CK.issue({
      id: 'analysis.suggest.turn', tier: 'analysis',
      level: worstTurn <= maxTurn + 1e-6 ? 'ok' : 'advisory', blocksExport: false,
      message: 'worst plan turn ' + (before / DEG).toFixed(0) + '° → '
        + (worstTurn / DEG).toFixed(0) + '° over ' + stations.length
        + ' welds (cap ' + o.maxTurnDeg + '°, tips exempt)',
      value: worstTurn / DEG, tolerance: o.maxTurnDeg, toleranceKind: 'deg',
      where: { analysis: 'suggestSeams' },
    }));
    const cut = layout.cut;
    if (cut) {
      issues.push(CK.issue({
        id: 'analysis.suggest.cutConsumption', tier: 'analysis',
        level: cut.slack > 0 ? 'ok' : 'advisory', blocksExport: false,
        message: cut.slack > 0
          ? 'every proposed segment survives its own mitre cuts (worst slack '
            + cut.slack.toFixed(0) + ' mm, spec 3.4)'
          : 'a proposed segment is ' + (-cut.slack).toFixed(0) + ' mm shorter '
            + 'than its two mitre cuts consume (spec 3.4)',
        value: cut.slack, tolerance: 0, toleranceKind: 'mm',
        where: { panel: cut.where, analysis: 'suggestSeams' },
      }));
    }
    for (const r of rejected) {
      issues.push(CK.issue({
        id: 'analysis.suggest.notSplit', tier: 'analysis', level: 'advisory',
        blocksExport: false,
        message: 'the ' + (turnsBefore[r.index] / DEG).toFixed(0) + '° turn at W'
          + r.weld + ' is over the ' + o.maxTurnDeg + '° cap and was LEFT '
          + 'ALONE: ' + r.reason + '. Move its neighbours out, or accept the '
          + 'mitre.',
        value: turnsBefore[r.index] / DEG, tolerance: o.maxTurnDeg,
        toleranceKind: 'deg',
        where: { weld: r.weld, analysis: 'suggestSeams' },
      }));
    }

    return {
      maxTurnDeg: o.maxTurnDeg,
      targetWelds: target || null,
      stations,
      steps: layout.steps,
      preview: layout.doc,
      inserted: stations.filter((s) => s.kind === 'insert').length,
      moved: stations.filter((s) => s.kind === 'move').length,
      kept: stations.filter((s) => s.kind === 'keep').length,
      turnsBefore: turnsBefore.map((t) => t / DEG),
      turnsAfter: turnsAfter.map((t) => t / DEG),
      worstTurnDeg: worstTurn / DEG,
      worstTurnBeforeDeg: before / DEG,
      cutConsumption: cut,
      rejected,
      issues,
    };
  }

  /**
   * One layout pass: stations, their tilts and widths, and the ops that get
   * there. Pure -- `doc` is read, never touched.
   *
   * `withdrawn` names stored-weld INDICES whose corner must not be filleted
   * (the caller adds to it when a fillet turned out to break spec 3.4).
   */
  function layoutStations(doc, ring, k, extra, withdrawn, bUniform, o, rejected) {
    const n = doc.welds.length;
    const stations = [];
    for (let i = 0; i < n; i++) {
      const w = doc.welds[i];
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const next = ring[(i + 1) % ring.length];
      let placed = null;
      if (k[i] > 1 && !withdrawn.has(i)) {
        // The weld's own departure from the mitre value -- the kit's bow carries
        // 1.4 -- has to ride along, because it is what sets the reach the fillet
        // radius must clear.
        const outAxis0 = V.norm(V.sub(ring[(i + 1) % ring.length], w.c));
        const widen = w.a / Math.max(1e-9,
          w.b / Math.max(1e-6, Math.abs(V.dot(w.n, outAxis0))));
        placed = filletStations(prev, w.c, next, k[i], w.b, widen, o);
        if (placed && placed.reject) {
          if (!rejected.some((r) => r.index === i)) {
            rejected.push({ weld: w.id, index: i, reason: placed.reject });
          }
          placed = null;
        }
      }
      if (placed) {
        // Keep the FIRST station on the source weld, except at the tail of the
        // stored list, where an insert has no segment to go into after it: there
        // the source keeps the LAST station and the rest are inserted before.
        const keepAt = i === n - 1 ? placed.stations.length - 1 : 0;
        placed.stations.forEach((s, j) => {
          stations.push({ c: s.c, sourceId: j === keepAt ? w.id : null,
            fromWeld: w.id, sourceIndex: i,
            kind: j === keepAt ? 'move' : 'insert',
            corner: { k: k[i], radius: placed.radius, setback: placed.setback } });
        });
      } else {
        stations.push({ c: w.c.slice(), sourceId: w.id, fromWeld: w.id,
          sourceIndex: i, kind: 'keep' });
      }
      for (let e = 0; e < (extra[i] || 0); e++) {
        const a = doc.welds[i].c, b2 = doc.welds[i + 1].c;
        const f = (e + 1) / ((extra[i] || 0) + 1);
        stations.push({ c: V.lerp(a, b2, f), sourceId: null, fromWeld: null,
          sourceIndex: i, kind: 'insert', spacing: true });
      }
    }

    // ---- tilts and widths for the proposed ring ---------------------------
    const proposedRing = ringCentres(doc, stations.map((s) => ({
      c: s.c,
      onCentreplane: !!(s.sourceId != null
        && doc.welds[D.byId(doc, s.sourceId)].onCentreplane),
    })));
    const N2 = proposedRing.length;
    const M = stations.length;
    stations.forEach((s, i) => {
      const src = s.sourceId == null ? null : doc.welds[D.byId(doc, s.sourceId)];
      const onCp = !!(src && src.onCentreplane);
      s.onCentreplane = onCp;
      // A WELD THAT DID NOT MOVE, BETWEEN NEIGHBOURS THAT DID NOT MOVE, KEEPS
      // ITS OWN NORMAL AND ITS OWN a. Recomputing the mitre bisector for every
      // station would quietly re-normalise a hand-tilted weld the user never
      // asked this button to touch -- and this button's whole contract is that
      // it proposes seam PLACEMENT, not a fresh boat.
      const still = (j) => stations[((j % M) + M) % M].kind === 'keep';
      if (s.kind === 'keep' && still(i - 1) && still(i + 1) && M === n) {
        s.n = src.n.slice();
        s.a = src.a;
        s.mitre = null;
        return;
      }
      const prev = proposedRing[(i - 1 + N2) % N2];
      const next = proposedRing[(i + 1) % N2];
      const inAxis = V.norm(V.sub(s.c, prev));
      const outAxis = V.norm(V.sub(next, s.c));
      let nrm = V.norm(V.add(inAxis, outAxis));
      if (onCp) nrm = V.norm([0, nrm[1] < 0 ? -1 : 1, 0]);
      s.n = nrm;
      // ONE TUBE: a is the mitre value b/cos(rake). A weld the user deliberately
      // widened keeps its widening -- the proposal scales a by the RATIO of the
      // new mitre value to the old, so `widen: 1.4` survives being moved.
      const cosRake = Math.max(1e-6, Math.abs(V.dot(nrm, outAxis)));
      const b = src ? src.b : bUniform;
      s.mitre = b / cosRake;
      if (src) {
        const j = D.byId(doc, s.sourceId);
        const oldOut = V.norm(V.sub(ring[(j + 1) % ring.length], ring[j]));
        const oldMitre = src.b / Math.max(1e-6, Math.abs(V.dot(src.n, oldOut)));
        s.a = src.a * (s.mitre / oldMitre);
      } else {
        s.a = s.mitre;
      }
    });
    const turnsAfter = planTurns(proposedRing).slice(0, M);
    stations.forEach((s, i) => { s.turnDeg = turnsAfter[i] / DEG; });

    const sim = buildSteps(doc, stations);
    return {
      stations, turnsAfter, steps: sim.steps, doc: sim.doc, ids: sim.ids,
      /**
       * Which station this proposal INVENTED is responsible for a named
       * segment of the resulting boat.
       *
       * By weld id off the derived ring, not by picking the segment id apart:
       * ids are what segment names are made of, and reading them back out of a
       * string is the kind of shortcut that survives until the day a boat has a
       * weld 1 and a weld 11. A spacing weld is offered first -- it was the
       * optional one -- and a weld that was already there is never blamed,
       * because withdrawing it is not something this button may do.
       */
      blameFor: (segId) => {
        const seg = D.ring(sim.doc).segments.find((s) => s.id === segId);
        if (!seg) return null;
        const ids = [seg.A.sourceId, seg.B.sourceId];
        let corner = null;
        for (let i = 0; i < M; i++) {
          if (ids.indexOf(sim.ids[i]) < 0) continue;
          if (stations[i].spacing) return stations[i];
          if (stations[i].corner && !corner) corner = stations[i];
        }
        return corner;
      },
    };
  }

  /**
   * Turn a station list into op descriptors, by SIMULATING them.
   *
   * Inserts first, in order, so every new weld has a stored segment to go into
   * (`ops.addSeam` names the segment by the index of the weld at its head, and
   * a segment only exists between two stored welds -- there is nothing after
   * the last one, which is why the tail corner keeps its source weld at the
   * END of its fillet). Then one `dragSeam` per station for position and tilt,
   * and one `setWidth` where the mitre value moved.
   *
   * The ids of inserted welds are deterministic (`doc.nextId` increments), so
   * simulating here and baking the ids into the descriptors is safe -- and it
   * means the caller replays plain `{op, args}` through `ops.apply`, one step at
   * a time, each with its own inverse. That is the whole reason this is a
   * proposal and not a mutation.
   */
  function buildSteps(doc, stations) {
    const steps = [];
    let cur = doc;
    const idFor = new Array(stations.length).fill(null);
    stations.forEach((s, i) => { idFor[i] = s.sourceId; });

    // --- inserts, in station order.
    for (let i = 0; i < stations.length; i++) {
      if (idFor[i] != null) continue;
      // The weld this one follows: the nearest earlier station that has one.
      let j = i - 1;
      while (j >= 0 && idFor[j] == null) j--;
      let segIdx;
      if (j < 0) segIdx = 0;
      else segIdx = D.byId(cur, idFor[j]);
      if (segIdx < 0 || segIdx >= cur.welds.length - 1) {
        segIdx = Math.max(0, cur.welds.length - 2);
      }
      const step = { op: 'addSeam', args: [segIdx, 0.5] };
      const r = OPS.apply(cur, step);
      cur = r.doc;
      idFor[i] = r.detail.newId;
      steps.push(step);
    }

    // --- position, tilt, width.
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      const id = idFor[i];
      const w = cur.welds[D.byId(cur, id)];
      const movedC = V.dist(w.c, s.c) > 1e-9;
      const movedN = V.dist(w.n, s.n) > 1e-12;
      if (movedC || movedN) {
        const step = { op: 'dragSeam', args: [id, { c: s.c.slice(), n: s.n.slice() }] };
        cur = OPS.apply(cur, step).doc;
        steps.push(step);
      }
      const w2 = cur.welds[D.byId(cur, id)];
      if (Math.abs(w2.a - s.a) > 1e-9 && s.a > 0) {
        const step = { op: 'setWidth', args: [id, s.a] };
        cur = OPS.apply(cur, step).doc;
        steps.push(step);
      }
    }

    return { steps, doc: cur, ids: idFor, cut: worstCutConsumption(cur) };
  }

  /**
   * Spec 3.4, measured on a document WITHOUT building it.
   *
   * The same statement `checks.cutConsumption` makes -- each weld's cut ellipse
   * reaches along the segment axis by sqrt((a e1.axis)^2 + (b e2.axis)^2), and
   * the two ends must not eat the segment -- restated here so a proposal can be
   * scored in microseconds instead of by a full loft. `checks` remains the
   * authority; this is the same arithmetic, and the tests hold them together.
   */
  function worstCutConsumption(doc) {
    let worst = null;
    for (const seg of D.ring(doc).segments) {
      const A = seg.A.weld, B = seg.B.weld;
      const L = V.dist(A.c, B.c);
      if (!(L > 0)) continue;
      const axis = V.norm(V.sub(B.c, A.c));
      const reach = (W) => {
        const f = D.weldFrame(W);
        return CK.radialBound(f)
          * Math.hypot(W.a * V.dot(f.e1, axis), W.b * V.dot(f.e2, axis));
      };
      const slack = L - reach(A) - reach(B);
      if (!worst || slack < worst.slack) worst = { slack, where: seg.id, length: L };
    }
    return worst;
  }

  /**
   * Replay a proposal, ONE OP AT A TIME.
   *
   * Every step goes through `ops.apply`, so every step carries its own inverse
   * and a UI can push them all on the undo stack (or push them as a group and
   * pop them in reverse). Nothing here knows any geometry: `suggestSeams`
   * decided, the ops execute, and the document is the only thing that changed.
   *
   * @returns {{doc, results, inverses}} `inverses` are in REVERSE order, ready
   *   to be applied one after another to undo the whole suggestion.
   */
  function applySuggestion(doc, proposal) {
    let cur = doc;
    const results = [];
    for (const step of proposal.steps) {
      const r = OPS.apply(cur, step);
      cur = r.doc;
      results.push(r);
    }
    return {
      doc: cur, results,
      inverses: results.map((r) => r.inverse).reverse(),
    };
  }

  // ==================================================================
  // The whole observer pass
  // ==================================================================

  /**
   * Run every observer and collect the advisories.
   *
   * Returns a plain object. The caller may render it, and MUST NOT store it:
   * no field of this result belongs in a document, a permalink or an SVG.
   */
  function observe(built, opts) {
    const o = opts || {};
    const f = flotation(built, o.flotation || o);
    const h = hoop(built, o.hoop || o);
    return {
      flotation: f, hoop: h,
      issues: f.issues.concat(h.issues),
      model: f.model,
    };
  }

  const api = {
    CONST, MODEL_DEFAULTS, SUGGEST_DEFAULTS,
    triangulate, clipBelow, faceBelow, landingProfile, sectionSegments,
    channelHalfAt, hullModel, bathtubArea, immersedAt, halfBeamAt, waterlineFor,
    flotation, flotationIssues,
    maxCurvatureRadius, hoop,
    ringCentres, planTurns, filletStations, layoutStations, suggestSeams, buildSteps,
    worstCutConsumption, applySuggestion,
    observe,
  };

  E.analysis = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
