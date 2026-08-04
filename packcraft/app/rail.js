/**
 * Right rail: always-visible metrics with traffic lights (spec §15).
 *
 * Every metric explains what it means and which parameter moves it, and a red
 * one links straight to the offending slider -- §15's rule, and the difference
 * between a number and an instruction.
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // `+ 0` kills negative zero: a trim of -0.00 deg reads as a fault when it is
  // the best answer the solver can give.
  const f = (v, dp) => (v == null || !isFinite(v) ? '–' : (v + 0).toFixed(dp == null ? 1 : dp).replace(/^-(0\.?0*)$/, '$1'));

  /**
   * Each metric says how to read it. `state` returns 'good' | 'warn' | 'bad',
   * so the light is derived from the same thresholds the issue list uses
   * rather than a second, drifting copy.
   */
  const METRICS = [
    {
      group: 'Floats',
      items: [
        {
          label: 'Reserve buoyancy', field: 'primary.tubeDiaMidship',
          value: (a) => f(a.volume.reserveRatio, 2) + '×',
          state: (a, C) => band(a.volume.reserveRatio, C.RESERVE_RATIO_MIN, C.RESERVE_RATIO_MAX),
          help: 'Tube volume divided by what the loaded boat displaces. Below 2.8 it sits deep and swamps; above 3.2 you are carrying fabric and seam load you do not need. Moved by tube diameter.',
        },
        {
          label: 'Freeboard', field: 'primary.tubeDiaMidship',
          value: (a) => f(a.immersion.minFreeboardRatio * 100, 0) + '%',
          state: (a, C) => (a.immersion.minFreeboardRatio >= (a.params.brief.useCase === 'whitewater' ? C.FREEBOARD_WHITEWATER : C.FREEBOARD_FLATWATER) ? 'good' : 'warn'),
          help: 'Lowest tube height above water across the cockpit, as a fraction of tube diameter. 55% flatwater, 65% whitewater. Measured over the cockpit because the tapering tips always read low.',
        },
        {
          label: 'Waterline', field: 'primary.tubeDiaMidship',
          value: (a) => f(a.immersion.waterline, 0) + ' mm',
          state: () => 'good',
          help: 'Height of the water surface above the midship keel datum, at the solved trim.',
        },
        {
          label: 'Floor carries', field: 'construction.floorClockAngle',
          value: (a) => f(a.immersion.channelShare * 100, 0) + '%',
          state: () => 'good',
          help: 'Share of your displacement carried by the bathtub between the tubes rather than by the tubes themselves. The floor is a hull, not a groundsheet — this is why a swamped packraft sits so much lower. Landing the floor higher up the tube shrinks it.',
        },
      ],
    },
    {
      group: 'Sits right',
      items: [
        {
          label: 'Trim', field: 'analysis.seatPositionFromStern',
          value: (a) => f(a.trim.angleDeg, 2) + '°',
          state: (a, C) => (Math.abs(a.trim.angleDeg) <= C.TRIM_WARN_DEG ? 'good' : 'warn'),
          help: 'Bow-up is positive. Level to about 1.5° bow-up is the target; bow-down ploughs and steers badly, and is the most common DIY failure.',
        },
        {
          label: 'Seat for level trim', field: 'analysis.seatPositionFromStern',
          value: (a) => f(a.trim.seatForLevelFromStern / 10, 1) + ' cm',
          state: () => 'good',
          help: 'Where the seat centroid must sit, measured from the stern, for the boat to float level with your load. This number is genuinely hard to get any other way.',
        },
        {
          label: 'Trim sensitivity', field: 'primary.interiorLength',
          value: (a) => f(a.trim.degreesPer10kgAt100mm, 2) + '°',
          state: () => 'good',
          help: 'Trim change from shifting 10 kg by 100 mm. Short rockered boats have low resistance to trim, which is why load placement matters so much on them.',
        },
      ],
    },
    {
      group: 'Stays upright and straight',
      items: [
        {
          label: 'Stability', field: 'primary.interiorWidth',
          value: (a) => a.stability.band,
          state: (a) => (a.stability.gm > 0 ? 'good' : 'bad'),
          help: 'Two widely-spaced tubes give an enormous transverse second moment and your weight sits barely above the water, so this is always stiff. Reported as a band because the raw number means little.',
        },
        {
          label: 'Heel tolerance', field: 'primary.tubeDiaMidship',
          value: (a) => f(a.stability.heelTolerance, 0) + '°',
          state: (a) => (a.stability.heelTolerance > 12 ? 'good' : 'warn'),
          help: 'How far you can lean before the cockpit ships water.',
        },
        {
          label: 'Immersed tail', field: 'primary.sternLengthFrac',
          value: (a) => f(a.tracking.immersedTail / 10, 0) + ' cm',
          state: () => 'good',
          help: 'Length of hull aft of midships still in the water at the solved trim. This is the direct tracking driver: trim bow-down and the tail lifts out, losing the tracking you paid for.',
        },
        {
          label: 'Effective waterline', field: 'primary.sternLengthFrac',
          value: (a) => f(a.tracking.effectiveWLRatio * 100, 0) + '%',
          state: (a, C) => (a.tracking.effectiveWLRatio >= C.TRACKING_WL_RATIO_MIN ? 'good' : 'warn'),
          help: 'Waterline length as a fraction of LOA. An Alpacka-style hull lands around 88-92%. Rocker distribution matters more than total rocker: symmetric rocker spins, aft-flattened rocker tracks.',
        },
      ],
    },
    {
      group: 'Holds together',
      items: [
        {
          label: 'Proof pressure', field: 'analysis.designPressureBar',
          value: (a) => f(a.pressure.proof, 2) + ' bar',
          state: () => 'good',
          help: 'What the hull reaches when inflated on cold water and left in the sun. Absolute pressure scales with absolute temperature, so this is derived, not chosen — and it is how DIY boats actually fail.',
        },
        {
          label: 'Seam safety factor', field: 'construction.stripWidth',
          value: (a) => f(a.strength.seamSafetyFactorWithWidth, 1) + '×',
          // Mirrors analysis.review() exactly, so the light and the issue list
          // can never disagree: red once even the width-credited factor is
          // short, amber while the raw measured bond alone would not hold.
          state: (a, C) => (a.strength.seamSafetyFactorWithWidth < C.SEAM_SAFETY_MIN ? 'bad'
            : a.strength.seamSafetyFactor < C.SEAM_SAFETY_MIN ? 'warn' : 'good'),
          help: 'Weld bond capacity against hoop load at PROOF pressure. Credits the full strip bond width against a figure measured on a 3.2 mm weld; amber means the uncredited measured bond alone would not hold, which is a reason to test-weld scraps, not to redesign. Unverified for iron welds.',
        },
        {
          label: 'Hoop load at proof', field: 'primary.tubeDiaMidship',
          value: (a) => f(a.strength.hoopProof, 2) + ' N/mm',
          state: () => 'good',
          help: 'Force per millimetre on the longitudinal closure. Scales linearly with tube radius, so a big-volume ultralight boat is inherently more stressed. Girth seams carry exactly half this.',
        },
      ],
    },
    {
      group: 'Costs',
      items: [
        {
          label: 'Finished mass', field: 'primary.tubeDiaMidship',
          value: (a) => f(a.mass.total / 1000, 2) + ' kg',
          state: () => 'good',
          help: 'Fabric from the nested panels, plus tape from total seam length, plus valve and fittings. Solved against displacement, since the boat has to float its own weight.',
        },
        {
          label: 'Packed volume', field: 'construction.floorTabWidth',
          value: (a) => f(a.packed.litres, 1) + ' L',
          state: () => 'good',
          help: 'Fabric solid volume divided by a packing factor calibrated on one published boat. Treat as indicative.',
        },
        {
          label: 'Weld length', field: 'construction.segmentBudget',
          value: (a) => f(a.build.weldMetres, 1) + ' m',
          state: () => 'good',
          help: 'The real predictor of build time.',
        },
        {
          label: 'Floor corners', field: 'construction.segmentBudget',
          value: (a) => String(a.build.floorCorners),
          state: (a, C) => (a.build.floorCorners <= C.FLOOR_CORNER_WARN ? 'good' : 'warn'),
          help: 'Instances of the one verified failure point: where two tube sections meet the floor. Each extra segment adds two. This is the risk metric.',
        },
        {
          label: 'Build time', field: 'construction.segmentBudget',
          value: (a) => f(a.build.estimatedHours, 1) + ' h',
          state: () => 'good',
          help: 'Roughly 17 minutes per girth seam including its strip and corners. An estimate, not a promise.',
        },
      ],
    },
  ];

  const band = (v, lo, hi) => (v < lo || v > hi ? 'warn' : 'good');

  function build(host, onFocusField) {
    const rows = [];
    for (const group of METRICS) {
      host.appendChild(el('h2', null, group.group));
      for (const m of group.items) {
        const row = el('div', 'metric-row');
        const label = el('span', 'm-label', m.label);
        const dot = el('span', 'm-dot');
        const val = el('b', 'm-val', '–');
        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(val);
        row.title = m.help;
        row.addEventListener('click', () => onFocusField && onFocusField(m.field));
        host.appendChild(row);
        rows.push({ m, row, dot, val });
      }
    }
    return {
      update(a, C) {
        for (const r of rows) {
          if (!a) { r.val.textContent = '…'; r.dot.className = 'm-dot'; continue; }
          try {
            r.val.textContent = r.m.value(a);
            r.dot.className = 'm-dot ' + r.m.state(a, C);
          } catch (e) {
            r.val.textContent = '–';
            r.dot.className = 'm-dot';
          }
        }
      },
    };
  }

  P.rail = { build, METRICS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
