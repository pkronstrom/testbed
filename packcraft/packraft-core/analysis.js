/**
 * Naval-architecture analysis (spec §5, §6).
 *
 * Everything here is closed-form or a small bisection, so the whole chain runs
 * in milliseconds and can be recomputed whenever the design changes.
 *
 * Order matters -- each step feeds the next:
 *
 *   1. mass <-> displacement iteration   (§5.1)
 *   2. immersion -> freeboard, wetted area (§5.2, §5.2b)
 *   3. trim: LCB/LCG, 2-DOF equilibrium, seat position, MCT (§5.3, §5.4)
 *   4. stability and heel tolerance      (§5.5)
 *   5. tracking: immersed tail, CLR, windage (§5.6)
 *   6. strength and pressure             (§5.7, §6)
 *   7. build-cost metrics                (§5.7b, §5.8)
 *
 * TWO CORRECTIONS TO §5 CARRIED THROUGH FROM EARLIER PHASES:
 *
 * - Volume. §5.1 specifies the Pappus integral, and the derive chain uses it
 *   as its sizing target. But it overstates the boat that actually gets built
 *   by ~1.95%, because it double-counts where the port and starboard tubes
 *   interpenetrate near the tips and cannot see what faceting removes. Every
 *   buoyancy number here uses `develop.enclosedVolume` -- the exact volume of
 *   the generated frustum chain -- and the Pappus figure is reported only as
 *   the sizing target it is.
 *
 * - Boat mass. §5.1 says to iterate mass against displacement, and until the
 *   nest existed there was nothing to iterate: a seed constant stood in.
 *   `solve()` now closes that loop for real.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./constants.js');
    require('./curves.js');
    require('./params.js');
    require('./skeleton.js');
    require('./develop.js');
    require('./panels.js');
    require('./nest.js');
  }
  const P = root.Packraft || (root.Packraft = {});
  const C = P.constants;

  const G = 9.80665;            // m/s^2
  const RHO = 1e-6;             // kg/mm^3, fresh water
  const BAR = 0.1;              // 1 bar in N/mm^2

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // =========================================================================
  // Hull sampling -- one pass, reused by every integral below.
  // =========================================================================
  function hullStations(params, n) {
    const hc = P.curves.hullCurves(params.curves, params.primary.loa);
    const count = n || 400;
    const seam = (params.construction.floorClockAngle * Math.PI) / 180;
    const slack = Math.max(0, params.construction.floorSlack || 0);
    const out = new Array(count + 1);
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const p = hc.pointAt(t);
      const tangent = hc.tangentAt(t);
      const r = hc.rAt(t);
      const keel = hc.keel.at(t);
      const hw = hc.halfWidth.at(t);
      const zAxis = keel + r;
      // Where the floor lands on the tube, and how far it spans. Clock angle
      // is measured from the top of the tube, so 180 deg is the keel line and
      // the 190 deg default lands just inboard of it.
      const floorBase = zAxis + r * Math.cos(seam);
      const spanHalf = Math.max(0, hw - r * Math.abs(Math.sin(seam)));
      // A slack floor bulges below that line. Shallow-parabola approximation:
      // extra length fraction s over span L gives sag = L*sqrt(3s/8).
      const sag = 2 * spanHalf * Math.sqrt((3 * slack) / 8);
      out[i] = {
        t,
        x: p[0], y: p[1], z: p[2],
        r, keel, zAxis,
        halfWidth: hw,
        sheer: hc.sheer.at(t),
        floorBase, spanHalf, sag, seamAngle: seam,
        // dl along the 3D centreline, and along its plan projection: the
        // first weights volumes, the second weights waterplane areas.
        speed: Math.hypot(tangent[0], tangent[1], tangent[2]),
        speedPlan: Math.hypot(tangent[0], tangent[1]),
      };
    }
    out.dt = 1 / count;
    out.slack = slack;
    out.seam = seam;
    return out;
  }

  /**
   * Half-width of the dry channel between the two tubes at height `z`: the
   * inboard face of one tube, measured from the centreplane. Goes to zero
   * where the tubes meet on the centreline near the tips, which is exactly
   * where the channel stops existing.
   */
  function innerHalf(s, z) {
    const dz = z - s.zAxis;
    const bulge = Math.sqrt(Math.max(0, s.r * s.r - dz * dz));
    return Math.max(0, s.halfWidth - bulge);
  }

  /**
   * THE BOAT IS ONE HULL, NOT TWO TUBES.
   *
   * §5.2 says to "bisect on d, integrate along both tubes" and stops there.
   * That leaves out the largest single piece of buoyancy the boat has: the
   * watertight floor spans between the tubes at roughly the keel line, so the
   * bathtub above it and below the waterline displaces water exactly as a
   * canoe's hull does. Amidships on the reference boat it is 58,000 mm^2
   * against the tubes' 52,000 -- the model was counting less than half the
   * section, and floating the boat at 119 mm when it should sit near 65 mm.
   *
   * Consequences beyond draft, all of which follow from the same omission:
   *   - the waterplane is the FULL beam at the waterline, not two narrow
   *     strips, so it is ~1.7x wider and both second moments grow with it;
   *   - the tube's inboard face above the floor is INSIDE the boat and dry,
   *     so the old full-circle wetted arc was wrong in the other direction;
   *   - the floor's underside is fully wetted, which §5.2b already asked for
   *     and never got.
   *
   * Reserve buoyancy stays tube-only. That is §5.1's definition and it is the
   * right one: it asks what still floats you once the bathtub is full.
   */
  function sectionAt(s, wl) {
    const d = clamp(wl - s.keel, 0, 2 * s.r);
    const tubes = 2 * segmentArea(d, s.r);

    let channel = 0, floorWet = 0, tubeWet = 0, beam = 0;
    const dry = wl <= s.keel;

    if (!dry) {
      // Bathtub: integrate the gap between the tubes from the floor up.
      const top = Math.min(wl, s.zAxis + s.r);
      if (top > s.floorBase && s.spanHalf > 0) {
        const N = 16;
        const h = (top - s.floorBase) / N;
        for (let k = 0; k < N; k++) {
          channel += 2 * innerHalf(s, s.floorBase + (k + 0.5) * h) * h;
        }
        // Whatever a slack floor bulges below its landing line is submerged
        // whole. Parabolic segment: two thirds of the bounding box.
        channel += (2 / 3) * (2 * s.spanHalf) * s.sag;
        floorWet = 2 * s.spanHalf * (1 + (s.sag > 0 ? (8 / 3) * (s.sag / (2 * s.spanHalf)) ** 2 : 0));
      }

      // Wetted tube: from the floor landing, around the keel, up the outboard
      // face to the waterline. Everything inboard of the landing is interior.
      const thetaWl = Math.acos(clamp((wl - s.zAxis) / s.r, -1, 1));
      tubeWet = 2 * s.r * Math.max(0, (s.seamAngle || 0) - thetaWl);

      // Waterplane: the boat's full section at the water surface.
      if (wl < s.zAxis + s.r) {
        beam = 2 * (s.halfWidth + Math.sqrt(Math.max(0, s.r * s.r - (wl - s.zAxis) ** 2)));
      }
    }

    return { tubes, channel, beam, wetted: tubeWet + floorWet };
  }

  /** Submerged area of a circle of radius r immersed to depth d (§5.2). */
  function segmentArea(d, r) {
    if (d <= 0) return 0;
    if (d >= 2 * r) return Math.PI * r * r;
    const a = r - d;
    return r * r * Math.acos(a / r) - a * Math.sqrt(Math.max(0, 2 * r * d - d * d));
  }

  /** Wetted arc of the same circle. */
  function segmentArc(d, r) {
    if (d <= 0) return 0;
    if (d >= 2 * r) return 2 * Math.PI * r;
    return 2 * r * Math.acos((r - d) / r);
  }

  /** Waterplane half-width of the same circle at its waterline. */
  function segmentHalfWidth(d, r) {
    if (d <= 0 || d >= 2 * r) return 0;
    return Math.sqrt(Math.max(0, 2 * r * d - d * d));
  }

  /**
   * Integrate the immersed hull for a waterplane at height `w0` amidships and
   * slope `slope` (rise per mm of x; positive is bow-up).
   *
   * The `overlapFactor` scales the result to account for the port and
   * starboard tubes interpenetrating near the tips -- integrating both sides
   * independently double-counts that lens, exactly as the Pappus volume does.
   * It is measured once against the exact enclosed volume rather than assumed.
   */
  function immerse(stations, w0, slope, overlapFactor) {
    const k = overlapFactor == null ? 1 : overlapFactor;
    let volume = 0, momentX = 0, wetted = 0;
    let tubeVolume = 0, channelVolume = 0;
    let wpArea = 0, wpMomentX = 0;
    let foreMost = -Infinity, aftMost = Infinity;
    let lateralArea = 0, lateralMomentX = 0;

    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      const weight = (i === 0 || i === stations.length - 1) ? 0.5 : 1;
      const wl = w0 + slope * s.x;
      const sec = sectionAt(s, wl);

      // The overlap correction is a TUBE artefact -- it exists because the two
      // tubes interpenetrate near the tips. The channel integral already goes
      // to zero there on its own, so it must not be scaled again.
      const a = sec.tubes * k + sec.channel;
      const dl = s.speed * stations.dt * weight;
      volume += a * dl;
      momentX += a * s.x * dl;
      tubeVolume += sec.tubes * k * dl;
      channelVolume += sec.channel * dl;
      wetted += sec.wetted * dl;

      const dlPlan = s.speedPlan * stations.dt * weight;
      wpArea += sec.beam * dlPlan;
      wpMomentX += sec.beam * s.x * dlPlan;

      if (a > 0) {
        if (s.x > foreMost) foreMost = s.x;
        if (s.x < aftMost) aftMost = s.x;
        // Lateral (profile) plane: immersed depth against plan length (§5.6).
        // A profile is one view of the boat, so unlike the volume integrals
        // this is NOT doubled for the two tubes.
        const d = clamp(wl - s.keel, 0, 2 * s.r);
        lateralArea += d * dlPlan;
        lateralMomentX += d * s.x * dlPlan;
      }
    }

    return {
      volume,
      tubeVolume,
      channelVolume,
      lcb: volume > 0 ? momentX / volume : 0,
      wettedArea: wetted,
      waterplaneArea: wpArea,
      waterplaneCentroid: wpArea > 0 ? wpMomentX / wpArea : 0,
      immersedFore: foreMost,
      immersedAft: aftMost,
      lateralArea,
      clr: lateralArea > 0 ? lateralMomentX / lateralArea : 0,
    };
  }

  /**
   * Second moments of the waterplane, for MCT and GM (§5.4, §5.5).
   *
   * The waterplane is the boat's FULL section at the water surface -- one
   * continuous strip of beam `b` about the centreplane, because the bathtub
   * between the tubes is inside the hull. Treating it as two narrow tube
   * strips understated the beam by 1.7x amidships and both moments with it.
   */
  function waterplaneMoments(stations, w0, slope, centroidX) {
    let iL = 0, iT = 0;
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      const weight = (i === 0 || i === stations.length - 1) ? 0.5 : 1;
      const b = sectionAt(s, w0 + slope * s.x).beam;
      if (b <= 0) continue;
      const dlPlan = s.speedPlan * stations.dt * weight;
      const dx = s.x - centroidX;
      iL += b * dx * dx * dlPlan;
      // Transverse, about the centreplane: b^3/12 for a strip of full beam b.
      iT += ((b * b * b) / 12) * dlPlan;
    }
    return { iL, iT };
  }

  /** Sinkage that floats `displacement` mm^3 at a given trim slope. */
  function solveSinkage(stations, displacement, slope, overlapFactor) {
    let lo = -1000, hi = 2000;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (immerse(stations, mid, slope, overlapFactor).volume < displacement) lo = mid;
      else hi = mid;
      if (hi - lo < 1e-7) break;
    }
    return 0.5 * (lo + hi);
  }

  /**
   * 2-DOF equilibrium (§5.3): sinkage and trim, solved so the hull floats the
   * load AND the centre of buoyancy sits under the centre of gravity.
   *
   * Symmetry makes this genuinely 2-DOF rather than 3 -- LCB lies on the
   * centreplane by construction (§3.4b).
   */
  function solveEquilibrium(stations, displacement, lcg, overlapFactor) {
    const residual = (slope) => {
      const w = solveSinkage(stations, displacement, slope, overlapFactor);
      return { w, ...immerse(stations, w, slope, overlapFactor) };
    };
    // Trimming bow-down moves the centre of buoyancy forward, so the residual
    // is monotone and bisection is safe.
    let lo = -0.25, hi = 0.25;
    let rLo = residual(lo), rHi = residual(hi);
    if ((rLo.lcb - lcg) * (rHi.lcb - lcg) > 0) {
      // Outside the bracket: return the closer extreme rather than throwing,
      // so a wild design still renders with a warning instead of a crash.
      const pick = Math.abs(rLo.lcb - lcg) < Math.abs(rHi.lcb - lcg) ? rLo : rHi;
      return Object.assign({ slope: Math.abs(rLo.lcb - lcg) < Math.abs(rHi.lcb - lcg) ? lo : hi, converged: false }, pick);
    }
    let mid = 0, rMid = rLo;
    for (let i = 0; i < 80; i++) {
      mid = 0.5 * (lo + hi);
      rMid = residual(mid);
      if ((rLo.lcb - lcg) * (rMid.lcb - lcg) <= 0) { hi = mid; rHi = rMid; }
      else { lo = mid; rLo = rMid; }
      if (hi - lo < 1e-12) break;
    }
    return Object.assign({ slope: mid, converged: true }, rMid);
  }

  // =========================================================================
  // Mass (§5.8) -- fabric from the nest, plus the consumables it cannot see.
  // =========================================================================
  function massModel(nested, params) {
    const tape = C.TAPE_GSM_PER_METRE * (nested.totalSeamLength / 1000);
    const valve = C.VALVE_MASS;
    const misc = C.MISC_MASS;
    return {
      tube: nested.tubeMass,
      floor: nested.floorMass,
      fabric: nested.fabricMass,
      tape, valve, misc,
      total: nested.fabricMass + tape + valve + misc,
    };
  }

  /** Pressure model (§6). Absolute pressure scales with absolute temperature. */
  function pressures(analysisParams) {
    const pd = analysisParams.designPressureBar;
    const tCold = analysisParams.waterTempC + 273.15;
    const tHot = analysisParams.airTempC + 273.15;
    const proof = (pd + 1.013) * (tHot / tCold) - 1.013;
    return { design: pd, proof, thermalFactor: (pd + 1.013) === 0 ? 1 : (proof + 1.013) / (pd + 1.013) };
  }

  /** Seam loads and safety factors (§5.7). */
  function strength(params, rMax, press, floorLoadN, beamHalf) {
    // Thin-wall membrane, force per unit length. p in bar -> N/mm^2.
    const hoop = (p) => p * BAR * rMax;
    const girth = (p) => (p * BAR * rMax) / 2;

    const bond = C.WELD_BOND_STRENGTH;      // N/mm, measured, no width credit
    const tensile = C.FABRIC_TENSILE_WARP;  // N/mm

    // Floor as a membrane in catenary: T = W / (2 sin theta) (§5.7).
    const slack = Math.max(params.construction.floorSlack, C.FLOOR_SLACK_MIN_FOR_TENSION);
    const sag = Math.acos(1 / (1 + slack));
    const floorTension = floorLoadN / (2 * Math.max(Math.sin(sag), 1e-6)) / (2 * beamHalf);

    // The measured bond figure (§7.4) comes from an RF weld only 3.2 mm wide.
    // Our butt-strip gives stripWidth/2 of bond on each side -- 25 mm at the
    // default, nearly 8x that -- and shear capacity scales with bond area. So
    // there are two honest numbers, and reporting only the first would flag a
    // sound design as unsafe while reporting only the second would claim
    // credit the spec deliberately withholds:
    //
    //   conservative  the measured 3.57 N/mm, no width credit at all
    //   withWidth     scaled linearly by the actual bond width
    //
    // Neither is verified for IRON welds; §7.4's caveat and §18 step 5 (test
    // weld scraps before touching real panels) are the real answer.
    const bondWidth = params.construction.stripWidth / 2;
    const widthCredit = bondWidth / C.WELD_BOND_TEST_WIDTH;
    const proofHoop = Math.max(hoop(press.proof), 1e-9);

    return {
      hoopDesign: hoop(press.design),
      hoopProof: hoop(press.proof),
      girthDesign: girth(press.design),
      girthProof: girth(press.proof),
      bondStrength: bond,
      bondStrengthWithWidth: bond * widthCredit,
      bondWidth,
      widthCredit,
      fabricTensile: tensile,
      // Safety factors at PROOF pressure -- the sun-on-a-gravel-bar case is
      // how DIY boats actually fail (§6), so it is the one that matters.
      seamSafetyFactor: bond / proofHoop,
      seamSafetyFactorWithWidth: (bond * widthCredit) / proofHoop,
      fabricSafetyFactor: tensile / proofHoop,
      floorTension,
      // Inward pull narrows the beam under load (§5.7).
      inwardPull: floorTension * Math.cos(sag),
    };
  }

  /**
   * The whole chain, with the §5.1 mass<->displacement iteration closed.
   *
   * @param {object} rawParams pre-derive params
   * @returns {object} everything, plus the derived params and geometry it used
   */
  function solve(rawParams, opts) {
    const o = opts || {};
    const samples = o.samples || 240;
    const maxPasses = o.maxPasses || 8;

    let boatMass = C.BOAT_MASS_SEED;
    let passes = 0, delta = Infinity;
    let params, sk, built, nested, mass;

    // ---- 1. mass <-> displacement (§5.1) --------------------------------
    while (passes < maxPasses) {
      passes++;
      params = P.params.derive(rawParams, { boatMass });
      sk = P.skeleton.buildSkeleton(params);
      built = P.panels.build(params, sk, { samples, measure: false });
      nested = P.nest.nest(built, params.materials);
      mass = massModel(nested, params);
      delta = Math.abs(mass.total - boatMass);
      boatMass = mass.total;
      if (delta < C.MASS_CONVERGENCE) break;
    }
    const massConverged = delta < C.MASS_CONVERGENCE;

    const stations = hullStations(params, samples);
    const brief = params.brief;
    const loadMass = brief.paddlerMass + brief.cargoMass + mass.total;   // g
    const displacement = loadMass / C.WATER_DENSITY;                     // mm^3

    // Exact volume of the boat that gets built, not the Pappus sizing figure.
    const enclosed = P.develop.enclosedVolume(built.tube);
    // The same correction, applied to every immersion integral so buoyancy
    // is not overstated near the tips.
    const pappus = P.params.tubeVolume(P.curves.hullCurves(params.curves, params.primary.loa));
    const overlapFactor = enclosed / pappus;

    // ---- 2/3. equilibrium, trim, seat (§5.2, §5.3) ----------------------
    const boatCentroidX = tubeCentroidX(stations);
    const cargoX = cargoPosition(params, stations);
    const seatSet = params.analysis.seatPositionFromStern;
    const sternX = -params.primary.loa / 2;
    const seatX = seatSet == null ? null : sternX + seatSet;

    // Where the paddler must sit for level trim: solve the level waterline,
    // then place the seat so LCG lands on LCB. This is the §5.3 headline and
    // needs no iteration.
    const levelW = solveSinkage(stations, displacement, 0, overlapFactor);
    const level = immerse(stations, levelW, 0, overlapFactor);
    const seatForLevelX = (level.lcb * loadMass
      - brief.cargoMass * cargoX - mass.total * boatCentroidX) / brief.paddlerMass;

    const usedSeatX = seatX == null ? seatForLevelX : seatX;
    const lcg = (brief.paddlerMass * usedSeatX + brief.cargoMass * cargoX
      + mass.total * boatCentroidX) / loadMass;

    const eq = solveEquilibrium(stations, displacement, lcg, overlapFactor);
    const trimDeg = (Math.atan(eq.slope) * 180) / Math.PI;

    // ---- freeboard per station (§5.2) -----------------------------------
    // §5.2 wants freeboard PER STATION, "not as a single number -- the bow
    // can be dry while midship is not". The headline minimum is taken over
    // the MIDBODY only: at the tips the tube tapers to a fraction of its
    // midship diameter, so a ratio measured there compares a small tube to
    // its own small self and reads alarmingly low on a perfectly good hull.
    // Tip freeboard is reported separately rather than folded in.
    // The §5.2 target is about shipping water, so it is judged over the
    // COCKPIT -- the interior length, where the paddler and the opening are.
    // Measured at the tapering ends instead it compares a thin tube against
    // its own thin self and reads alarmingly low on a sound hull: 28% at the
    // stern tip and 43% at the end of the midbody, against 60% amidships.
    // The per-station array carries the whole picture either way.
    const halfCockpit = params.primary.interiorLength / 2;
    const inCockpit = (x) => Math.abs(x) <= halfCockpit;

    const freeboard = [];
    let minFreeboard = Infinity, minFreeboardX = 0, minFreeboardRatio = Infinity;
    let minTipFreeboard = Infinity;
    for (const s of stations) {
      const wl = eq.w + eq.slope * s.x;
      const fb = s.sheer - wl;
      const ratio = fb / (2 * s.r);
      const cockpit = inCockpit(s.x);
      freeboard.push({ t: s.t, x: s.x, freeboard: fb, ratio, cockpit });
      if (cockpit) {
        if (fb < minFreeboard) { minFreeboard = fb; minFreeboardX = s.x; }
        if (ratio < minFreeboardRatio) minFreeboardRatio = ratio;
      } else if (fb < minTipFreeboard) {
        minTipFreeboard = fb;
      }
    }
    if (!isFinite(minFreeboard)) { minFreeboard = 0; minFreeboardRatio = 0; }

    // ---- 4. stability (§5.5) --------------------------------------------
    const moments = waterplaneMoments(stations, eq.w, eq.slope, eq.waterplaneCentroid);
    const bm = moments.iT / Math.max(eq.volume, 1);
    // Centre of gravity height: paddler sits on the floor, near the waterline.
    const kg = C.PADDLER_CG_HEIGHT;
    const kb = eq.w - C.KB_BELOW_WATERLINE_FRAC * (eq.w - stationMinKeel(stations));
    const gm = kb + bm - kg;
    // Heel until the lowest MIDBODY freeboard is gone (§5.5). Using the tip
    // value here made a sound hull read as 5 deg of heel tolerance.
    const heelTolerance = (Math.atan2(Math.max(minFreeboard, 0),
      Math.max(params.primary.beam / 2, 1)) * 180) / Math.PI;

    // ---- 5. tracking (§5.6) ---------------------------------------------
    const immersedTail = eq.immersedAft === Infinity ? 0 : (0 - eq.immersedAft);
    const effectiveWL = (eq.immersedFore === -Infinity || eq.immersedAft === Infinity)
      ? 0 : eq.immersedFore - eq.immersedAft;
    const windage = windageProfile(stations, eq);

    // ---- 6. pressure and strength (§5.7, §6) ----------------------------
    const press = pressures(params.analysis);
    let rMax = 0;
    for (const s of stations) if (s.r > rMax) rMax = s.r;
    const floorLoadN = (brief.paddlerMass / 1000) * G;
    const str = strength(params, rMax, press, floorLoadN, params.primary.beam / 2);

    // ---- 7. build cost (§5.7b, §5.8) ------------------------------------
    const build = {
      seamCount: built.seams.length,
      girthSeams: built.seams.length,
      weldMetres: nested.totalSeamLength / 1000,
      floorCorners: built.floor.zones.length,
      estimatedHours: (built.seams.length * C.MINUTES_PER_GIRTH_SEAM) / 60,
      outlineDeviation: sk.deviation,
    };

    // ---- packed volume (§5.2c) ------------------------------------------
    const solidVolume = mass.fabric / C.FABRIC_DENSITY;          // mm^3
    const packedVolume = solidVolume / C.PACKING_FACTOR;

    const result = {
      params, skeleton: sk, panels: built, nest: nested,
      mass: Object.assign({}, mass, { passes, converged: massConverged, delta }),
      displacement,
      loadMass,
      volume: {
        enclosed,
        pappus,
        overlapFactor,
        reserveRatio: enclosed / displacement,
      },
      immersion: {
        waterline: eq.w,
        wettedArea: eq.wettedArea,
        waterplaneArea: eq.waterplaneArea,
        // Where the buoyancy actually comes from. The bathtub between the
        // tubes carries most of it, which is why the floor is not optional
        // trim: flood it and you are back on the reserve ratio alone.
        tubeVolume: eq.tubeVolume,
        channelVolume: eq.channelVolume,
        channelShare: eq.volume > 0 ? eq.channelVolume / eq.volume : 0,
        freeboard,
        minFreeboard,
        minFreeboardX,
        minFreeboardRatio,
        minTipFreeboard: isFinite(minTipFreeboard) ? minTipFreeboard : null,
      },
      trim: {
        angleDeg: trimDeg,
        lcb: eq.lcb,
        lcg,
        converged: eq.converged,
        seatForLevelFromStern: seatForLevelX - sternX,
        seatUsedFromStern: usedSeatX - sternX,
        iL: moments.iL,
        // Moment to change trim one degree, and the human form of it (§5.4).
        mctPerDegree: RHO * G * moments.iL * (Math.PI / 180),
        degreesPer10kgAt100mm: degreesFor(10000, 100, moments.iL),
      },
      stability: { gm, bm, kb, kg, heelTolerance, band: gmBand(gm) },
      tracking: {
        immersedTail,
        effectiveWL,
        effectiveWLRatio: effectiveWL / params.primary.loa,
        clr: eq.clr,
        lateralArea: eq.lateralArea,
        windageArea: windage.area,
        windageCentroid: windage.centroid,
        clrAftOfLcg: eq.clr - lcg,
      },
      pressure: press,
      strength: str,
      build,
      packed: { solidVolume, packedVolume, litres: packedVolume / 1e6 },
    };

    result.issues = review(result, params);
    return result;
  }

  const degreesFor = (grams, mm, iL) =>
    ((grams / 1000) * mm) / (RHO * 1e3 * Math.max(iL, 1)) * (180 / Math.PI) * 1e3;

  function tubeCentroidX(stations) {
    let m = 0, mx = 0;
    for (const s of stations) {
      const a = Math.PI * s.r * s.r * s.speed * stations.dt;
      m += a; mx += a * s.x;
    }
    return m > 0 ? mx / m : 0;
  }

  function stationMinKeel(stations) {
    let k = Infinity;
    for (const s of stations) if (s.keel < k) k = s.keel;
    return k;
  }

  function cargoPosition(params, stations) {
    const loa = params.primary.loa;
    switch (params.brief.cargoStowage) {
      case 'bow': return loa / 2 - params.derived.bowLength / 2;
      case 'stern': return -loa / 2 + params.derived.sternLength / 2;
      default: return 0;   // internal: near amidships, low
    }
  }

  function windageProfile(stations, eq) {
    let area = 0, mx = 0;
    for (const s of stations) {
      const wl = eq.w + eq.slope * s.x;
      const above = Math.max(0, s.sheer - Math.max(wl, s.keel));
      const dl = s.speedPlan * stations.dt;
      area += above * dl;
      mx += above * s.x * dl;
    }
    // A profile seen from the side, so no doubling: the tubes sit beside each
    // other, not on top of each other.
    return { area, centroid: area > 0 ? mx / area : 0 };
  }

  const gmBand = (gm) => (gm > 800 ? 'very stiff' : gm > 400 ? 'stiff'
    : gm > 150 ? 'moderate' : gm > 0 ? 'tender' : 'unstable');

  /**
   * Traffic lights (§15). Every item explains itself and names the parameter
   * that moves it, so a red light is actionable rather than alarming.
   */
  function review(a, params) {
    const out = [];
    const warn = (code, field, message) => out.push({ level: 'warn', code, field, message });
    const err = (code, field, message) => out.push({ level: 'error', code, field, message });

    if (!a.mass.converged) {
      err('mass-iteration', 'brief.paddlerMass',
        `Boat mass did not converge (${a.mass.delta.toFixed(1)} g after ${a.mass.passes} passes). §5.1 expects under ${C.MASS_CONVERGENCE} g in two.`);
    }

    const rr = a.volume.reserveRatio;
    if (rr < C.RESERVE_RATIO_MIN) {
      warn('reserve', 'primary.tubeDiaMidship',
        `Reserve buoyancy ${rr.toFixed(2)} is below the ${C.RESERVE_RATIO_MIN} target: the boat sits deep and swamps easily. Increase tube diameter.`);
    } else if (rr > C.RESERVE_RATIO_MAX) {
      warn('reserve', 'primary.tubeDiaMidship',
        `Reserve buoyancy ${rr.toFixed(2)} is above ${C.RESERVE_RATIO_MAX}: fabric, weight and seam load spent on volume you do not need.`);
    }

    const fbTarget = params.brief.useCase === 'whitewater'
      ? C.FREEBOARD_WHITEWATER : C.FREEBOARD_FLATWATER;
    if (a.immersion.minFreeboardRatio < fbTarget) {
      warn('freeboard', 'primary.tubeDiaMidship',
        `Lowest cockpit freeboard is ${(a.immersion.minFreeboardRatio * 100).toFixed(0)}% of tube diameter (${a.immersion.minFreeboard.toFixed(0)} mm at x = ${a.immersion.minFreeboardX.toFixed(0)} mm), under the ${(fbTarget * 100).toFixed(0)}% target for ${params.brief.useCase}.`);
    }

    if (Math.abs(a.trim.angleDeg) > C.TRIM_WARN_DEG) {
      warn('trim', 'analysis.seatPositionFromStern',
        `Trim is ${a.trim.angleDeg.toFixed(1)}° ${a.trim.angleDeg > 0 ? 'bow-up' : 'bow-down'}. Level to ${C.TRIM_TARGET_DEG}° bow-up is the target; move the seat to ${a.trim.seatForLevelFromStern.toFixed(0)} mm from the stern.`);
    }

    if (a.tracking.effectiveWLRatio < C.TRACKING_WL_RATIO_MIN) {
      warn('tracking', 'primary.sternLengthFrac',
        `Effective waterline is ${(a.tracking.effectiveWLRatio * 100).toFixed(0)}% of LOA, below the ${(C.TRACKING_WL_RATIO_MIN * 100).toFixed(0)}% an Alpacka-style hull achieves. A bow-down trim lifts the tail and loses the tracking you paid for.`);
    }

    if (a.strength.seamSafetyFactorWithWidth < C.SEAM_SAFETY_MIN) {
      err('seam-safety', 'analysis.designPressureBar',
        `Seam safety factor ${a.strength.seamSafetyFactorWithWidth.toFixed(2)} at proof pressure ${a.pressure.proof.toFixed(2)} bar, even crediting the full ${a.strength.bondWidth.toFixed(0)} mm bond width. Lower the design pressure, the tube radius, or widen the strip.`);
    } else if (a.strength.seamSafetyFactor < C.SEAM_SAFETY_MIN) {
      warn('seam-safety', 'construction.stripWidth',
        `Hoop load at proof pressure is ${a.strength.hoopProof.toFixed(2)} N/mm against a measured bond of ${a.strength.bondStrength} N/mm — but that figure is from a 3.2 mm RF weld, and the strip gives ${a.strength.bondWidth.toFixed(0)} mm of bond per side, so the real factor is about ${a.strength.seamSafetyFactorWithWidth.toFixed(1)}. Unverified for iron welds: test-weld scraps before cutting panels (§18).`);
    }

    if (a.stability.gm <= 0) {
      err('stability', 'primary.beam', 'Negative metacentric height: this hull is unstable.');
    }

    if (a.build.floorCorners > C.FLOOR_CORNER_WARN) {
      warn('floor-corners', 'construction.segmentBudget',
        `${a.build.floorCorners} floor corners. That joint is the one verified failure point (§7.4c), and each segment adds two.`);
    }

    return out;
  }

  const api = {
    solve, hullStations, immerse, segmentArea, segmentArc, segmentHalfWidth,
    solveSinkage, solveEquilibrium, pressures, strength, massModel,
    waterplaneMoments, review,
  };

  P.analysis = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
