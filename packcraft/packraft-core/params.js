/**
 * Parameter schema, defaults, curve synthesis, the derive chain and
 * validation (spec §3.2, §4).
 *
 * Two notes on how this reads the spec:
 *
 * 1. THE CURVES ARE SYNTHESISED FROM THE PRIMARY PARAMETERS. Spec §4.5 lists
 *    literal control points for keel/sheer/halfWidth alongside primary fields
 *    (tubeDiaMidship, bowTaper, ...), but those two sets contradict each
 *    other: the §4.5 curves imply rMid = 150 mm and bowTaper = 0.27, against
 *    primary values of 140 mm and 0.70. Since §3.2 says "r(t) at the
 *    endpoints is the tip radius from the taper parameter" and §4.1 derives
 *    the tube diameter from the brief, the primary parameters win and the
 *    curves are generated from them. The §4.5 literals are treated as
 *    illustrative. L2 spline editing (Phase 5) overrides the synthesised
 *    curves; nothing here forecloses that.
 *
 * 2. `linked` mirrors the §4.5 rule that "every primary field carries a
 *    linked flag". It is kept as a sibling map rather than boxing every value,
 *    so the params object stays plain JSON that encodes compactly (§11).
 *    linked[field] === false means the user overrode it; the derive chain
 *    leaves it alone.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./constants.js');
    require('./curves.js');
    require('./quad.js');
  }
  const P = root.Packraft || (root.Packraft = {});
  const C = P.constants;
  const CURVES = P.curves;
  const QUAD = P.quad;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /** The §16 reference design: the author's boat. */
  function defaults() {
    return {
      schemaVersion: 1,

      brief: {
        paddlerHeight: 1830,
        paddlerMass: 85000,
        hipBreadth: null,
        cargoMass: 20000,
        cargoStowage: 'bow',
        useCase: 'flatwater',
        childCapable: true,
      },

      // Derived unless the matching `linked` flag is false.
      primary: {
        loa: 2800,
        beam: 980,
        tubeDiaMidship: 280,
        interiorLength: 1400,
        interiorWidth: 420,
        bowLengthFrac: 0.20,
        sternLengthFrac: 0.30,
        bowRise: 150,
        sternRise: 0,
        bowTipRise: 0,
        sternTipRise: 0,
        bowTaper: 0.70,
        sternTaper: 0.55,
        bowFullness: C.ENTRY_FULLNESS_DEFAULT,
        sternFullness: C.ENTRY_FULLNESS_DEFAULT,
        // End-region radius, as a multiple of midship. Above 1.0 is a swell --
        // the reserve nose. Defaults hold the old shoulder constants.
        bowSwell: null,
        sternSwell: null,
        // §3.5's deep point far aft, mm below the midship keel.
        sternKeelDip: 0,
        // Hold the tube radius constant over the whole ring: every seam the
        // same rho, every segment a plain cylinder. What the photographs
        // show once the wrap projection is accounted for.
        uniformRadius: false,
        // Blunt tip caps, mm across (§17.19). 0 = pointed tip. A cap closes
        // the ring with a transverse tube segment across the centreplane.
        bowCapWidth: 0,
        sternCapWidth: 0,
      },

      // §16: interior dimensions are the author's choice (kid-capable), not
      // the anthropometric formula's output. Everything else stays linked.
      linked: {
        interiorLength: false,
        interiorWidth: false,
      },

      // Synthesised by derive() from `primary` unless curvesAuthored is true.
      curves: null,
      curvesAuthored: false,

      construction: {
        segmentBudget: 5,
        // Spec §4.5 defaults both of these to 'panel-on-axis'. That produces
        // a boat that cannot be built: the straddling tip segment is
        // 2*halfWidth(t1) long and §3.2 drives halfWidth to zero at the tip,
        // so it fails the §3.4 buildability rule by 3-5x at every segment
        // budget. seam-on-axis is also the [VERIFIED] DIY Packraft
        // construction. Revisit when §17.19's blunt tip is modelled.
        // See notes/phase0-findings.md #3.
        tipPhaseBow: 'seam-on-axis',
        tipPhaseStern: 'seam-on-axis',
        // 'auto' lets the joint DP spend girth seams inside the end regions;
        // 'single' keeps them out, so each end is ONE elongated cone from the
        // last seam to the tip -- the construction every build photograph
        // shows, and the only seam topology a fat nose can honestly have,
        // since a lone developable cone cannot bulge.
        endStyleBow: 'auto',
        endStyleStern: 'auto',
        coatingOrientation: 'outside',
        floorClockAngle: 190,
        floorSlack: 0.0,
        floorTabWidth: 120,
        floorWrapMaxAngle: 80,
        stripWidth: 50,
        buttGap: 0,
        dualChamber: false,
      },

      materials: {
        tube: { name: 'ny6.6 210D TPU 1-side (art 72710)', gsm: 310, usableWidth: 1500, pricePerMetre: 23.90 },
        floor: { name: 'ny6.6 210D TPU 2-side (art 72711)', gsm: 475, usableWidth: 1470, pricePerMetre: 34.90 },
        currency: 'EUR',
      },

      analysis: {
        designPressureBar: 0.20,
        waterTempC: 10,
        airTempC: 45,
        seatPositionFromStern: null,
      },

      export: {
        profile: 'full-scale-fabric',
        pageSize: 'A4',
        modelScale: 5,
      },
    };
  }

  /**
   * Proportions measured off an orthographic product photograph of an
   * Alpacka-style hull (notes/photogrammetry.md). Everything is a fraction of
   * LOA, because the photograph carries no scale -- only shape.
   *
   * This is the calibration §12 asks for and says nobody has: "rocker, sheer
   * and keel curves remain estimates... the app should make it easy to enter
   * measured values and back-fit."
   */
  const MEASURED = {
    beamFrac: 0.3432,
    tubeDiaFrac: 0.1099,
    interiorWidthFrac: 0.1234,
    bowLengthFrac: 0.27,
    sternLengthFrac: 0.32,
    bowRiseFrac: 0.0907,
    sternRiseFrac: 0.0245,
    sternKeelDipFrac: 0.0293,
    bowSwell: C.SWELL_MEASURED_BOW,
    sternSwell: C.SWELL_MEASURED_STERN,
    bowTaper: 0.80,
    sternTaper: 0.61,
    bowFullness: 0.60,
    sternFullness: 0.50,
    // Blunt end caps, as a fraction of LOA: the halfWidth curve terminates
    // at capWidth/2 and a transverse tube closes the ring (§17.19).
    bowCapWidthFrac: 0.146,
    sternCapWidthFrac: 0.063,
  };

  /**
   * Apply the measured proportions to an existing design, keeping its LOA and
   * interior length. Tube diameter and interior width are unlinked, because
   * the whole point is to use the measured ratios rather than the derive
   * chain's -- reserve buoyancy then reports whatever this shape actually is.
   */
  function applyMeasured(params) {
    const out = clone(params);
    const L = out.primary.loa;
    const f = (frac) => frac * L;
    const pr = out.primary;
    // FITTED, not hand-tuned: a Nelder-Mead fit of the BUILT silhouettes
    // against the photo curves (side keel+sheer, plan outer), mixed RMS
    // 0.024*LOA. Notable results the fit settled, confirming the user's
    // read of the photographs: the bow "swell" is mostly the wrap turn's
    // projection (1.18, not the 1.43 the raw silhouette suggested), the
    // bow rise is only 0.025*LOA (the nose HEIGHT is the turn's crown, not
    // rocker), and the tube diameter stays near-constant.
    pr.tubeDiaMidship = f(0.1153);       // fitted 322.9 at 2800
    pr.interiorWidth = f(0.1316);        // fitted 368.5
    pr.bowLengthFrac = 0.30;
    pr.sternLengthFrac = 0.385;
    pr.bowRise = f(0.0247);
    pr.sternRise = f(0.0100);
    pr.sternKeelDip = f(0.0392);
    pr.uniformRadius = true;   // every seam the same rho; cylinders throughout
    pr.bowTaper = 0.70;   // fat enough that the merged union is blunt, thin enough to close the cusp
    pr.sternTaper = 0.70;
    pr.bowFullness = 0.43;
    pr.sternFullness = 0.29;
    pr.bowSwell = 1.18;
    pr.sternSwell = 1.43;
    // NO WRAP CAP. The blunt nose is two FAT tubes MERGING (halfWidth < r),
    // not a tube bridging a gap: the photo's 409 mm nose is a 0.146*LOA
    // union, and a bridging tube would need cap >= 2*r = 644 mm to turn the
    // corner at all. Merged instead, the hull reaches 409 mm width at
    // u = 0.05 -- the photographed nose -- with deviation 9 mm and every
    // segment buildable. See notes/photogrammetry.md.
    pr.bowCapWidth = 0;
    pr.sternCapWidth = 0;
    out.linked = Object.assign({}, out.linked, {
      loa: false, tubeDiaMidship: false, interiorWidth: false,
    });
    // No mid-seam on the end tubes (user observation from the photographs):
    // the apex piece straddles the centreline at both ends.
    out.construction.tipPhaseBow = 'seam-on-axis';
    out.construction.tipPhaseStern = 'seam-on-axis';
    out.construction.endStyleBow = 'auto';
    out.construction.endStyleStern = 'auto';
    out.construction.segmentBudget = 7;
    return out;
  }

  /**
   * The DIY Packraft kit boat (diypackraft.com), from its published seam
   * diagram and product photographs. Much simpler than the Alpacka, and its
   * topology is exactly what this kernel builds:
   *
   *     piece 1     bow BRIDGE -- a transverse tube straddling the
   *                 centreline between the two merging side tubes
   *     2L / 2R     short angled corner pieces
   *     3L / 3R     long side panels
   *     4L / 4R     stern pieces meeting at a POINT on the centreline
   *
   * So: bridged blunt bow (panel-on-axis + capWidth), pointed stern
   * (seam-on-axis, no cap), four pieces per side, seven segments round the
   * ring. No wrap turns, no swell, no keel dip -- a boat a person can
   * actually weld on a kitchen table.
   */
  function applyDiy(params) {
    const out = clone(params);
    const pr = out.primary;
    pr.uniformRadius = true;
    pr.bowLengthFrac = 0.19;
    pr.sternLengthFrac = 0.28;
    pr.bowRise = 0.055 * pr.loa;
    pr.sternRise = 0.020 * pr.loa;
    pr.sternKeelDip = 0;
    pr.bowTaper = 0.78;
    pr.sternTaper = 0.62;
    pr.bowFullness = 0.55;
    pr.sternFullness = 0.25;
    pr.bowSwell = null;
    pr.sternSwell = null;
    // Piece 1: the bow bridge. The design curve terminates here and the
    // straddling tube spans it, so this IS the flat of the bow.
    pr.bowCapWidth = 320;
    pr.sternCapWidth = 0;
    out.construction.tipPhaseBow = 'panel-on-axis';
    out.construction.tipPhaseStern = 'seam-on-axis';
    out.construction.endStyleBow = 'auto';
    out.construction.endStyleStern = 'auto';
    // Three pieces a side (2L corner, 3L side, 4L stern) plus the shared
    // bridge = seven segments round the ring, exactly the diagram.
    out.construction.segmentBudget = 3;
    return out;
  }

  /**
   * What the plain taper curve already gives at the swell knots, as a multiple
   * of the midship radius. A UI slider starts here so that touching it is
   * continuous rather than a jump.
   */
  function swellAuto(primary) {
    const kBow = primary.bowLengthFrac, kStern = 1 - primary.sternLengthFrac;
    const rMid = primary.tubeDiaMidship / 2;
    const base = CURVES.pchip([
      [0, rMid * primary.bowTaper],
      [kBow, rMid * C.RADIUS_SHOULDER_BOW],
      [0.5, rMid],
      [kStern, rMid * C.RADIUS_SHOULDER_STERN],
      [1, rMid * primary.sternTaper],
    ]);
    return {
      bow: base.at(kBow * C.SWELL_KNOT_AT) / rMid,
      stern: base.at(1 - (1 - kStern) * C.SWELL_KNOT_AT) / rMid,
    };
  }

  /**
   * Build keel / sheer / halfWidth control points from the primary params.
   * All three share one knot set so `sheer = keel + 2r` holds exactly at the
   * knots and r(t) comes back out of the §3.2 identity as designed.
   */
  function synthesizeCurves(primary) {
    const bf = primary.bowLengthFrac;
    const sf = primary.sternLengthFrac;
    if (!(bf > 0 && sf > 0 && bf + sf < 1)) {
      throw new Error('synthesizeCurves: bow/stern length fractions must be positive and sum below 1');
    }
    const kBow = bf, kStern = 1 - sf;
    if (!(kBow < 0.5 && kStern > 0.5)) {
      throw new Error('synthesizeCurves: bow/stern regions must not reach amidships');
    }

    const rMid = primary.tubeDiaMidship / 2;
    // uniformRadius holds the radius flat through the MIDBODY and shoulders
    // (no swell, no shoulder reduction). It cannot also hold it flat to the
    // tips: a tube of radius r closing a turn needs 2*r*tan(turn/2) of gap,
    // so a uniform 323 mm tube demands a >=644 mm nose -- far blunter than
    // the photographed 409 mm. The tips keep their taper; the photo agrees
    // (tube height at u=0.02 is 0.8x midship).
    const uni = primary.uniformRadius === true;
    const rBow = rMid * primary.bowTaper;
    const rStern = rMid * primary.sternTaper;
    const shoulderBow = uni ? 1 : C.RADIUS_SHOULDER_BOW;
    const shoulderStern = uni ? 1 : C.RADIUS_SHOULDER_STERN;
    const hwMid = primary.interiorWidth / 2 + rMid;

    /**
     * END-REGION SWELL, measured off an orthographic product photograph of an
     * Alpacka-style hull (see notes/photogrammetry.md).
     *
     * The spec assumes the tube only ever gets THINNER toward the tips -- §3.5
     * gives taper bands of 0.65-0.75 at the bow and 0.45-0.60 at the stern.
     * The photograph says the opposite over most of the end region: the tube
     * swells to 1.43x midship at 8% of LOA from the bow and 1.39x at 12% from
     * the stern, and only collapses over the last few percent into a blunt cap.
     * That swell is the "reserve nose" -- it is a bulge, not a taper.
     *
     * So the radius gets a knot inside each end region whose height is a
     * parameter rather than a constant, and it is allowed above 1.0. Defaults
     * hold the previous shoulder constants so nothing moves unasked.
     */
    const swellAt = C.SWELL_KNOT_AT;
    const tSwellBow = kBow * swellAt;
    const tSwellStern = 1 - (1 - kStern) * swellAt;
    // null means "no swell knot at all", which keeps the curve set bit-identical
    // to Phase 0. Any number is ABSOLUTE, in multiples of the midship radius --
    // the label on the slider has to be true.
    const bowSwell = uni ? null : primary.bowSwell;
    const sternSwell = uni ? null : primary.sternSwell;
    // §3.5's deep point far aft, which it flags as observed but unmeasured.
    // The photograph puts it 0.029*LOA below the midship keel at u = 0.83.
    const dip = primary.sternKeelDip || 0;

    // The base five knots, unchanged since Phase 0. The swell knots are keyed
    // RELATIVE to this curve so that "no swell asked for" is a no-op: pinning
    // them to absolute values instead moved the derived midship diameter from
    // 300.6 mm to 285.3 mm, a 5% shift nobody requested.
    const baseKnots = [0, kBow, 0.5, kStern, 1];
    const baseKeelVals = [
      primary.bowRise + primary.bowTipRise,
      C.KEEL_SHOULDER_BOW,
      0,
      C.KEEL_SHOULDER_STERN,
      primary.sternRise + primary.sternTipRise,
    ];
    const baseRVals = [
      rBow,
      rMid * shoulderBow,
      rMid,
      rMid * shoulderStern,
      rStern,
    ];
    const swelling = bowSwell != null || sternSwell != null || dip !== 0;

    let knots = baseKnots, keelVals = baseKeelVals, rVals = baseRVals;
    if (swelling) {
      const baseKeel = CURVES.pchip(baseKnots.map((t, i) => [t, baseKeelVals[i]]));
      const baseR = CURVES.pchip(baseKnots.map((t, i) => [t, baseRVals[i]]));
      knots = [0, tSwellBow, kBow, 0.5, kStern, tSwellStern, 1];
      keelVals = [
        baseKeelVals[0], baseKeel.at(tSwellBow), baseKeelVals[1], baseKeelVals[2],
        baseKeelVals[3], baseKeel.at(tSwellStern) - dip, baseKeelVals[4],
      ];
      rVals = [
        baseRVals[0],
        bowSwell == null ? baseR.at(tSwellBow) : rMid * bowSwell,
        baseRVals[1], baseRVals[2], baseRVals[3],
        sternSwell == null ? baseR.at(tSwellStern) : rMid * sternSwell,
        baseRVals[4],
      ];
    }
    // halfWidth keeps its own knots (tip, shoulders, midship) plus the entry
    // knots below; it does not need the radius swell knots.
    const hwKnots = [0, kBow, 0.5, kStern, 1];
    /**
     * BLUNT TIP CAPS (§17.19, measured on the Alpacka photograph: bow cap
     * 0.146*LOA wide, stern 0.063*LOA).
     *
     * A cap means the halfWidth curve terminates at capWidth/2 instead of 0:
     * the two tube ends stop short of the centreplane and a TRANSVERSE tube
     * segment closes the ring between them -- exactly how an inflatable
     * raft's bow works, and a plain cylinder our frustum machinery already
     * knows how to mitre, develop and cut. §3.2 mandates halfWidth -> 0 at
     * the tips; this deliberately extends that, with 0 recovering the
     * pointed tip unchanged.
     */
    // capWidth has two readings, both "how wide is the blunt end":
    //   seam-on-axis  the ring WRAPS -- halfWidth terminates at capWidth/2
    //                 and a tangent turn closes it (needs a gap >= 2r).
    //   panel-on-axis a straddling BRIDGE tube of that width joins the two
    //                 merging tubes, so the design curve stays POINTED and
    //                 the bridge is placed by the skeleton. This is the
    //                 Alpacka: steeply merging fat tubes with a short
    //                 transverse piece between them.
    const capBow = Math.max(0, primary.bowCapWidth || 0) / 2;
    const capStern = Math.max(0, primary.sternCapWidth || 0) / 2;

    const hwVals = [
      capBow,
      hwMid * C.HALFWIDTH_SHOULDER_BOW,
      hwMid,
      hwMid * C.HALFWIDTH_SHOULDER_STERN,
      capStern,
    ];

    /**
     * Plan-view entry fullness (§3.5 "convergence", left unparametrised).
     *
     * With one shoulder knot per end, a monotone cubic between 0 at the tip
     * and the shoulder value is very nearly a straight ramp -- a WEDGE. Real
     * packrafts carry their width much further toward the tip and then round
     * off, which is where an Alpacka's blunt "reserve nose" volume lives.
     *
     * Parametrise it as a blend, in u = 0 at the tip to 1 at the shoulder:
     *
     *   wedge    hw = hwSh * u                    a straight cone in plan
     *   ellipse  hw = hwSh * sqrt(u (2 - u))      a blunt, rounded entry
     *   hw(u)    = hwSh * [(1-f) u + f sqrt(u(2-u))]
     *
     * f = 0 is the sharpest entry the model allows and f = 1 the bluntest.
     * The shape shipped before this parameter existed measures f ~ 0.25, so
     * that is what the default reproduces.
     *
     * The cost is real and the UI must show it: a blunter entry turns the tube
     * centreline harder near the tip, which raises the faceted-chain deviation
     * and eventually breaks the §3.4 buildability rule.
     */
    const entry = (f, u) => (1 - f) * u + f * Math.sqrt(Math.max(0, u * (2 - u)));

    const fBow = clamp(primary.bowFullness == null ? C.ENTRY_FULLNESS_DEFAULT : primary.bowFullness, 0, 1);
    const fStern = clamp(primary.sternFullness == null ? C.ENTRY_FULLNESS_DEFAULT : primary.sternFullness, 0, 1);

    // With a cap the entry blend rides from the cap half-width up to the
    // shoulder value, so cap = 0 reproduces the old curve exactly.
    const extra = [];
    for (const u of C.ENTRY_KNOTS) {
      extra.push([kBow * u, capBow + (hwVals[1] - capBow) * entry(fBow, u)]);
      extra.push([1 - (1 - kStern) * u, capStern + (hwVals[3] - capStern) * entry(fStern, u)]);
    }

    // ONLY halfWidth takes the refined knot set. hullCurves fits the three
    // curves independently, so keel and sheer keep the coarse knots they have
    // always had and the rocker and taper come out bit-identical -- resampling
    // them through a denser PCHIP changed the hull enough to move the faceted
    // chain deviation from 12.7 mm to 22.6 mm, which is not a change the
    // fullness parameter is entitled to make.
    const halfWidth = hwKnots.map((t, i) => [t, hwVals[i]]).concat(extra)
      .sort((a, b) => a[0] - b[0]);

    return {
      keel: knots.map((t, i) => [t, keelVals[i]]),
      sheer: knots.map((t, i) => [t, keelVals[i] + 2 * rVals[i]]),
      halfWidth,
    };
  }

  /** Required displacement volume in mm^3, from the total load (§5.1). */
  function displacementVolume(params, boatMass) {
    const m = params.brief.paddlerMass + params.brief.cargoMass
      + (boatMass == null ? C.BOAT_MASS_SEED : boatMass);
    return m / C.WATER_DENSITY;
  }

  /** Tube volume by Pappus around the full ring: V = 2 * integral(pi r^2 dl). */
  function tubeVolume(hc) {
    return 2 * QUAD.integrate(
      (t) => Math.PI * hc.rAt(t) * hc.rAt(t) * hc.speedAt(t), 0, 1, 128);
  }

  /** Centreline loop length: both sides, tip to tip. */
  function loopLength(hc) {
    return 2 * QUAD.integrate((t) => hc.speedAt(t), 0, 1, 128);
  }

  /**
   * The §4.1 derive chain.
   *
   *   height           -> interior length
   *   hip breadth      -> interior width
   *   closure identity -> LOA = bow + interior + stern
   *   load x reserve   -> required tube volume
   *   volume / loop    -> tube radius, hence beam
   *
   * Returns a new params object with `primary`, `curves` and a read-only
   * `derived` block filled in. Fields whose `linked` flag is false are left
   * exactly as the user set them.
   */
  function derive(params, opts) {
    const out = clone(params);
    // §5.1: boat mass is both an input and an output. analysis.solve() feeds
    // the converged value back in; on its own, derive() uses the seed.
    const boatMass = (opts && opts.boatMass != null) ? opts.boatMass : null;
    const linked = out.linked || (out.linked = {});
    const pr = out.primary;
    const isLinked = (f) => linked[f] !== false;

    const h = out.brief.paddlerHeight;
    const hipBreadth = out.brief.hipBreadth != null
      ? out.brief.hipBreadth
      : clamp(C.HIP_BREADTH_K * h, C.HIP_BREADTH_MIN, C.HIP_BREADTH_MAX);
    const hipEstimated = out.brief.hipBreadth == null;

    if (isLinked('interiorLength')) {
      pr.interiorLength = C.INTERIOR_LENGTH_K * h + C.INTERIOR_LENGTH_C;
    }
    if (isLinked('interiorWidth')) {
      pr.interiorWidth = hipBreadth + C.INTERIOR_WIDTH_MARGIN;
    }

    // Closure identity (§4.1): LOA = bow + interior + stern, with bow and
    // stern expressed as fractions of LOA. Solved for LOA, so it holds by
    // construction for any brief.
    if (isLinked('loa')) {
      pr.loa = pr.interiorLength / (1 - pr.bowLengthFrac - pr.sternLengthFrac);
    }

    const vRequired = displacementVolume(out, boatMass) * C.RESERVE_RATIO_TARGET;

    // Hand-edited curves (L2, Phase 5) are authoritative for shape AND size:
    // resizing the tube would mean rescaling someone's spline behind their
    // back. In that case the midship diameter is read back OUT of the curves
    // instead of driving them.
    //
    // This MUST key off an explicit flag, not merely "curves is non-null".
    // derive() writes synthesised curves back into the object, so inferring
    // authorship from non-nullness makes the first derive poison every
    // subsequent one: the chain would stop responding to the brief the moment
    // it had run once, and a slider drag would silently stop resizing the tube.
    const curvesAreAuthored = !!params.curves && params.curvesAuthored === true;

    // Round caps bulge ~capWidth/2 beyond the tip station, so the curve
    // domain pulls back by that much to keep the SURFACE inside LOA. Rides on
    // the curves object so every hullCurves caller agrees (near-parallel-
    // entry approximation; the §16 fixtures have no caps and are untouched).
    const capInset = (curves) => {
      // Only a WRAP turn bulges past the tip station; a bridge does not.
      curves.insetBow = (out.construction.tipPhaseBow !== 'panel-on-axis' && pr.bowCapWidth > 0)
        ? pr.bowCapWidth / 2 : 0;
      curves.insetStern = (out.construction.tipPhaseStern !== 'panel-on-axis' && pr.sternCapWidth > 0)
        ? pr.sternCapWidth / 2 : 0;
      return curves;
    };

    // Tube radius from required volume. The loop length depends weakly on
    // the radius (halfWidth = interiorWidth/2 + r), so this is a fixed point;
    // it converges in a handful of passes.
    let iterations = 0;
    if (curvesAreAuthored) {
      const hcAuthored = CURVES.hullCurves(out.curves, pr.loa);
      pr.tubeDiaMidship = 2 * hcAuthored.rAt(0.5);
    } else if (isLinked('tubeDiaMidship')) {
      let rMid = pr.tubeDiaMidship / 2;
      for (let i = 0; i < 60; i++) {
        iterations = i + 1;
        const trial = Object.assign({}, pr, { tubeDiaMidship: 2 * rMid });
        const hc = CURVES.hullCurves(capInset(synthesizeCurves(Object.assign({}, trial, {
          tipPhaseBow: out.construction.tipPhaseBow,
          tipPhaseStern: out.construction.tipPhaseStern,
        }))), pr.loa);
        // V = 2 * pi * rMid^2 * Leff  with Leff = integral (r/rMid)^2 dl
        const lEff = QUAD.integrate((t) => {
          const s = hc.rAt(t) / rMid;
          return s * s * hc.speedAt(t);
        }, 0, 1, 128);
        const next = Math.sqrt(vRequired / (2 * Math.PI * lEff));
        const delta = Math.abs(next - rMid);
        rMid = next;
        if (delta < 1e-9) break;
      }
      pr.tubeDiaMidship = 2 * rMid;
    }

    if (isLinked('beam')) {
      pr.beam = pr.interiorWidth + 2 * pr.tubeDiaMidship;
    }

    const prWithTips = Object.assign({}, pr, {
      tipPhaseBow: out.construction.tipPhaseBow,
      tipPhaseStern: out.construction.tipPhaseStern,
    });
    if (!curvesAreAuthored) out.curves = capInset(synthesizeCurves(prWithTips));
    const hc = CURVES.hullCurves(out.curves, pr.loa);

    const vDisp = displacementVolume(out, boatMass);
    const vTube = tubeVolume(hc);

    out.derived = {
      hipBreadth,
      hipBreadthEstimated: hipEstimated,
      bowLength: pr.bowLengthFrac * pr.loa,
      sternLength: pr.sternLengthFrac * pr.loa,
      loopLength: loopLength(hc),
      displacementVolume: vDisp,
      tubeVolume: vTube,
      reserveRatio: vTube / vDisp,
      rMidship: pr.tubeDiaMidship / 2,
      rBowTip: hc.rAt(0),
      rSternTip: hc.rAt(1),
      // Where the port and starboard tubes meet: halfWidth(t) = r(t).
      // This is the fore/aft extent of the floor (§16 note), not the LOA.
      floorExtent: floorExtent(hc),
      // Volume/derivation bookkeeping, so a UI can show what drove the size.
      requiredTubeVolume: vRequired,
      radiusIterations: iterations,
      boatMassUsed: boatMass == null ? C.BOAT_MASS_SEED : boatMass,
      // Where the plain taper already puts the end-region radius, so a swell
      // slider can start there instead of jumping when first touched.
      swellAuto: swellAuto(pr),
      // Derived, read-only (§3.7): the coating side dictates the floor.
      floorConstruction: out.construction.coatingOrientation === 'inside'
        ? 'double-floor (polygon retained in the side pieces)'
        : 'separate floor (polygon cut out of the side pieces)',
    };

    return out;
  }

  /**
   * Fore and aft parameters where halfWidth(t) = r(t) -- the points at which
   * the port and starboard tube centrelines are one tube-radius apart, i.e.
   * where the tubes converge and the floor ends.
   */
  function floorExtent(hc) {
    const f = (t) => hc.halfWidthAt(t) - hc.rAt(t);
    if (f(0.5) <= 0) return { tFore: null, tAft: null, length: 0 };
    let tFore = null, tAft = null;
    try { tFore = QUAD.bisect(f, 0, 0.5, 1e-9); } catch (e) { tFore = 0; }
    try { tAft = QUAD.bisect(f, 0.5, 1, 1e-9); } catch (e) { tAft = 1; }
    const xFore = hc.pointAt(tFore)[0];
    const xAft = hc.pointAt(tAft)[0];
    return { tFore, tAft, length: xFore - xAft };
  }

  /**
   * Validation (§3.2 table, §4.6 envelope). Never blocks -- returns a list of
   * {level, code, message, field} with level 'error' | 'warn'.
   */
  function validate(params) {
    const issues = [];
    const pr = params.primary;
    const cn = params.construction;
    const hc = CURVES.hullCurves(params.curves, pr.loa);
    const n = C.SIDE_SAMPLES;

    const err = (code, field, message) => issues.push({ level: 'error', code, field, message });
    const warn = (code, field, message) => issues.push({ level: 'warn', code, field, message });

    // §3.2 radius floor
    let rMinSeen = Infinity, rMinT = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const r = hc.rAt(t);
      if (r < rMinSeen) { rMinSeen = r; rMinT = t; }
    }
    if (rMinSeen < C.R_MIN) {
      err('radius-floor', 'curves.sheer',
        `Tube radius falls to ${rMinSeen.toFixed(1)} mm at t=${rMinT.toFixed(3)}, below the ${C.R_MIN} mm buildable floor.`);
    }

    // §3.2 taper rate |dr/ds|
    let taperMax = 0, taperT = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const dt = 1 / n;
      const t0 = Math.max(0, t - dt), t1 = Math.min(1, t + dt);
      const drdt = (hc.rAt(t1) - hc.rAt(t0)) / (t1 - t0);
      const rate = Math.abs(drdt / hc.speedAt(t));
      if (rate > taperMax) { taperMax = rate; taperT = t; }
    }
    if (taperMax > C.TAPER_RATE_MAX) {
      warn('taper-rate', 'primary.bowTaper',
        `Radius taper reaches |dr/ds| = ${taperMax.toFixed(3)} at t=${taperT.toFixed(3)}, above the ${C.TAPER_RATE_MAX} wrinkle threshold.`);
    }

    // §3.2 plan interference over the midbody
    if (hc.halfWidthAt(0.5) <= hc.rAt(0.5)) {
      err('plan-interference', 'primary.beam',
        'Port and starboard tubes intersect amidships: halfWidth is not greater than the tube radius.');
    }

    // §3.3 segment budget
    if (cn.segmentBudget > C.SEGMENT_BUDGET_CEILING) {
      warn('segment-budget', 'construction.segmentBudget',
        `Segment budget ${cn.segmentBudget} exceeds the practical ceiling of ${C.SEGMENT_BUDGET_CEILING}; every extra segment adds two floor corners, the one verified failure point.`);
    }
    if (cn.segmentBudget < 3) {
      err('segment-budget', 'construction.segmentBudget',
        'Segment budget below 3 cannot form a closed hull.');
    }

    // §3.7 floor parameters
    if (cn.floorTabWidth < C.FLOOR_TAB_MIN) {
      err('floor-tab', 'construction.floorTabWidth',
        `Floor tab ${cn.floorTabWidth} mm is below the ${C.FLOOR_TAB_MIN} mm structural minimum -- it is the tube's closing strap.`);
    }
    if (cn.floorTabWidth > C.FLOOR_TAB_MAX) {
      warn('floor-tab', 'construction.floorTabWidth',
        `Floor tab ${cn.floorTabWidth} mm exceeds the ${C.FLOOR_TAB_MAX} mm range.`);
    }
    if (cn.floorClockAngle < C.FLOOR_CLOCK_MIN || cn.floorClockAngle > C.FLOOR_CLOCK_MAX) {
      warn('floor-clock', 'construction.floorClockAngle',
        `Floor clock angle ${cn.floorClockAngle} deg is outside the ${C.FLOOR_CLOCK_MIN}-${C.FLOOR_CLOCK_MAX} deg band that the verified flat-table sequence can weld.`);
    }

    // A swell asks the tube to fatten and then thin again inside one end
    // region. A chain of cones can only do that with a girth seam at the
    // bulge's peak; a SINGLE cone has a linear radius and cannot bulge at
    // all. So swell + single-section end is a design the construction cannot
    // express -- the seam-free bulged nose on a real Alpacka is a pillow
    // piece that takes double curvature when inflated, outside developable
    // patterning entirely.
    const swellConflict = (side, swell, style) => {
      if (style !== 'single' || swell == null) return;
      const auto = swellAuto(pr);
      if (swell > (side === 'bow' ? auto.bow : auto.stern) + 0.02) {
        warn('swell-single', `primary.${side}Swell`,
          `The ${side} swell asks the tube to bulge mid-region, but the single-section ${side} is one cone and a cone's radius is a straight line -- the bulge will be cut off flat, and the outline-deviation number is that loss. Either allow seams in the ${side} (segmented end style, which puts a seam through the bulge), or use ${side} taper for a fat straight cone instead.`);
      }
    };
    swellConflict('bow', pr.bowSwell, cn.endStyleBow);
    swellConflict('stern', pr.sternSwell, cn.endStyleStern);

    // A cap wider than the shoulder leaves the end region nothing to do.
    for (const [side, cap] of [
      ['bow', pr.bowCapWidth],
      ['stern', pr.sternCapWidth],
    ]) {
      const shoulder = (pr.interiorWidth / 2 + pr.tubeDiaMidship / 2)
        * (side === 'bow' ? C.HALFWIDTH_SHOULDER_BOW : C.HALFWIDTH_SHOULDER_STERN);
      if (cap / 2 >= shoulder) {
        err('cap-width', `primary.${side}CapWidth`,
          `The ${side} cap (${Math.round(cap)} mm) is as wide as the hull at the ${side} shoulder -- the end region has no room to converge.`);
      }
    }

    // Same conflict, vertical: the stern keel dip is a V inside the end
    // region, and a single straight cone chords straight across it.
    if (cn.endStyleStern === 'single' && pr.sternKeelDip > 10) {
      warn('dip-single', 'primary.sternKeelDip',
        `The stern keel dip (${Math.round(pr.sternKeelDip)} mm) puts a low point inside the stern region, but the single-section stern is one straight cone and will chord across it. Real boats put a girth seam at the deep point -- switch the stern to segmented, or drop the dip.`);
    }

    // §4.6 envelope -- warnings only, never constraints
    for (const field of Object.keys(C.ENVELOPE)) {
      const [lo, hi] = C.ENVELOPE[field];
      const v = pr[field];
      if (v < lo || v > hi) {
        warn('envelope', `primary.${field}`,
          `${field} = ${Math.round(v)} mm is outside the typical ${lo}-${hi} mm range.`);
      }
    }

    // §5.1 reserve buoyancy band
    if (params.derived) {
      const rr = params.derived.reserveRatio;
      if (rr < C.RESERVE_RATIO_MIN || rr > C.RESERVE_RATIO_MAX) {
        warn('reserve-ratio', 'primary.tubeDiaMidship',
          `Reserve buoyancy ratio ${rr.toFixed(2)} is outside the ${C.RESERVE_RATIO_MIN}-${C.RESERVE_RATIO_MAX} target band.`);
      }
    }

    return issues;
  }

  const api = {
    MEASURED, applyMeasured, applyDiy, swellAuto,
    defaults, synthesizeCurves, derive, validate,
    displacementVolume, tubeVolume, loopLength, floorExtent, clone,
  };

  P.params = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
