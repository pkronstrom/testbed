/**
 * Every tunable number in the engine, in one file.
 *
 * Spec §0: values tagged [ESTIMATE] are the author's judgement, not laws.
 * They live here so calibration never touches logic. Each entry carries its
 * spec section and its tag.
 *
 * Tags: [SOURCED] published data · [VERIFIED] build-tutorial fact
 *       [DERIVED] computed · [ESTIMATE] judgement, calibrate me
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

  const C = {
    // ---- anthropometrics and the derive chain (§4.2) ----
    /** interiorLength = INTERIOR_LENGTH_K * height + INTERIOR_LENGTH_C  [SOURCED §4.2] */
    INTERIOR_LENGTH_K: 0.62,
    INTERIOR_LENGTH_C: 100,            // mm
    /** hipBreadth fallback when unmeasured [ESTIMATE §4.2, open item §17.16] */
    HIP_BREADTH_K: 0.19,
    HIP_BREADTH_MIN: 320,              // mm
    HIP_BREADTH_MAX: 420,              // mm
    /** interiorWidth = hipBreadth + this [SOURCED-corrected §4.2: 2..4 cm] */
    INTERIOR_WIDTH_MARGIN: 30,         // mm

    // ---- displacement and volume (§5.1) ----
    /**
     * Reserve buoyancy ratio the derive chain sizes the tube for.
     * Spec §5.1 gives a target band of 2.8-3.2 at design load and §16 quotes
     * ~3.0 for the reference boat. Held at 3.0; see notes/derive-calibration
     * for what that yields against the §16 tube diameter. [ESTIMATE §5.1]
     */
    RESERVE_RATIO_TARGET: 3.0,
    RESERVE_RATIO_MIN: 2.8,            // [SOURCED §5.1]
    RESERVE_RATIO_MAX: 3.2,            // [SOURCED §5.1]
    /** Water density, g/mm^3. 1000 kg/m^3. */
    WATER_DENSITY: 1e-3,
    /**
     * Seed boat mass for the displacement chain. Phase 3 replaces this with
     * the mass<->displacement iteration of §5.1; until then it is a constant.
     * [DERIVED §16: ~2.7 kg finished]
     */
    BOAT_MASS_SEED: 2700,              // g

    // ---- synthesised curve shape (§3.2, shoulder values read off the §4.5
    //      illustrative control points; these are the hull's "fairness" knobs)
    /** Keel height at the bow/stern shoulder knot, mm. [ESTIMATE §4.5] */
    KEEL_SHOULDER_BOW: 20,
    KEEL_SHOULDER_STERN: 5,
    /** Tube radius at the shoulder knots, as a fraction of midship. [ESTIMATE] */
    RADIUS_SHOULDER_BOW: 0.97,
    RADIUS_SHOULDER_STERN: 0.97,
    /** Plan half-width at the shoulder knots, as a fraction of midship. [ESTIMATE] */
    HALFWIDTH_SHOULDER_BOW: 0.80,
    HALFWIDTH_SHOULDER_STERN: 0.92,
    /**
     * Plan-view entry fullness: 0 is a straight wedge to the tip, 1 a blunt
     * elliptical entry. §3.5 names the property ("convergence: moderate at the
     * bow, aggressive at the stern") but never gives it a number. 0.25 is what
     * the single-shoulder-knot curve produced before the parameter existed, so
     * it is the default purely for continuity -- it is NOT a measured value,
     * and the reserve-nose look of a real Alpacka is nearer 0.7.
     * [ESTIMATE §3.5, open item §17: no plan-view calibration data exists]
     */
    ENTRY_FULLNESS_DEFAULT: 0.25,
    /** Where the extra plan-entry knots sit, as a fraction of the end region. */
    ENTRY_KNOTS: [0.25, 0.5, 0.75],
    /**
     * Where the end-region radius swell knot sits, as a fraction of the end
     * region measured from the tip. The photograph puts the bow peak at 0.30
     * of its region and the stern peak at 0.48; 0.35 splits them.
     * [MEASURED — notes/photogrammetry.md]
     */
    SWELL_KNOT_AT: 0.35,
    /**
     * The swell measured off the photograph, as a multiple of the midship
     * radius. NOT the default -- the defaults hold the old shoulder constants
     * so nothing moves unasked. This is what the "measured hull" preset uses.
     * [MEASURED — raw red mask, no fill: 1.43 bow / 1.39 stern]
     */
    SWELL_MEASURED_BOW: 1.43,
    SWELL_MEASURED_STERN: 1.39,

    // ---- analysis (§5, §6) ----
    /** Mass iteration convergence, g. §5.1 asserts under this in two passes. */
    MASS_CONVERGENCE: 1,
    /** Tape consumed per metre of seam, g. [ESTIMATE §5.8] */
    TAPE_GSM_PER_METRE: 12,
    VALVE_MASS: 45,                    // g  [SOURCED §7.1, TPU valve]
    MISC_MASS: 60,                     // g  [ESTIMATE] grab loops, patches
    /** Freeboard as a fraction of tube diameter. [ESTIMATE §5.2] */
    FREEBOARD_FLATWATER: 0.55,
    FREEBOARD_WHITEWATER: 0.65,
    /** Target and warning band for trim, degrees bow-up. [ESTIMATE §5.3] */
    TRIM_TARGET_DEG: 1.5,
    TRIM_WARN_DEG: 3.0,
    /** Effective waterline / LOA an Alpacka-style hull reaches. [ESTIMATE §5.6] */
    TRACKING_WL_RATIO_MIN: 0.88,
    /** Paddler CoG above the datum, mm. Sits on the floor. [ESTIMATE §5.5] */
    PADDLER_CG_HEIGHT: 180,
    /** Centre of buoyancy depth below the waterline, as a fraction. [ESTIMATE] */
    KB_BELOW_WATERLINE_FRAC: 0.45,
    /** Measured RF weld bond, N/mm, from a 3.2 mm wide weld. [VERIFIED §7.4] */
    WELD_BOND_STRENGTH: 3.57,
    /** Bond width that figure was measured at, mm (1/8"). [VERIFIED §7.4] */
    WELD_BOND_TEST_WIDTH: 3.2,
    /** Fabric tensile warp, N/mm (2500 N / 5 cm). [VERIFIED §7.1] */
    FABRIC_TENSILE_WARP: 50,
    /** Minimum seam safety factor at PROOF pressure. [ESTIMATE §5.7] */
    SEAM_SAFETY_MIN: 1.0,
    /** Floor slack floor for the catenary tension model. [ESTIMATE §5.7] */
    FLOOR_SLACK_MIN_FOR_TENSION: 0.02,
    /** Build time per girth seam including strip and corner, min. [ESTIMATE §5.7b] */
    MINUTES_PER_GIRTH_SEAM: 17,
    /** Floor corners above which the risk metric warns. [ESTIMATE §5.7b] */
    FLOOR_CORNER_WARN: 12,
    /** TPU-nylon solid density, g/mm^3, and pack efficiency. [ESTIMATE §5.2c] */
    FABRIC_DENSITY: 1.15e-3,
    PACKING_FACTOR: 0.16,

    // ---- curve validation (§3.2) ----
    R_MIN: 60,                         // mm  [ESTIMATE §3.2, open item §17.18]
    TAPER_RATE_MAX: 0.25,              // |dr/ds|  [ESTIMATE §3.2]

    // ---- segments and joints (§3.3) ----
    SEGMENT_BUDGET_DEFAULT: 5,         // per side  [VERIFIED §3.3]
    SEGMENT_BUDGET_CEILING: 7,         // [ESTIMATE §3.3]
    /** Outline deviation above which the UI suggests spending a seam. [ESTIMATE §3.3] */
    OUTLINE_DEVIATION_SUGGEST: 10,     // mm
    /** Dense samples per side for curve sampling and deviation scoring. */
    SIDE_SAMPLES: 240,
    /**
     * Decimation of the joint-placement search grid. Candidate joints sit on
     * every Nth sample; partitions are still scored against every sample, so
     * only the search is coarsened, never the measurement. Cost is
     * O(SIDE_SAMPLES^3 / stride^2) -- the dominant term in a regenerate.
     */
    JOINT_DP_STRIDE: 2,

    // ---- construction (§3.7, §7.4) ----
    FLOOR_TAB_MIN: 30,                 // mm  [VERIFIED §3.7]
    FLOOR_TAB_MAX: 200,                // mm  [ESTIMATE §3.7]
    FLOOR_WRAP_MAX_ANGLE: 80,          // deg [ESTIMATE §3.7]
    FLOOR_CLOCK_MIN: 180,              // deg [ESTIMATE §3.7 buildable-flat band]
    FLOOR_CLOCK_MAX: 200,              // deg [ESTIMATE §3.7]
    STRIP_WIDTH_DEFAULT: 50,           // mm  [ESTIMATE §7.4]

    // ---- design envelope warnings (§4.6) ----
    ENVELOPE: {
      loa: [2000, 2800],               // mm  [SOURCED/ESTIMATE §4.6]
      beam: [850, 1050],               // mm
      tubeDiaMidship: [280, 320],      // mm
      interiorLength: [1100, 1600],    // mm
    },

    // ---- tolerances (§2b) ----
    TOL_ARC_LENGTH: 1e-6,              // mm, kernel conservation
    TOL_MATED_EDGE: 0.01,              // mm, generated geometry
    TOL_ANALYSIS_REL: 0.02,            // 2%

    // ---- development sampling ----
    /** Circumferential samples per developed panel outline edge. */
    PANEL_SAMPLES: 720,
  };

  P.constants = C;
  if (typeof module === 'object' && module.exports) module.exports = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
