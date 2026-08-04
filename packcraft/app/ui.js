/**
 * Left rail, issue list and bottom metric bar (spec §15).
 *
 * Vanilla DOM by decision, not by omission: the UI is sliders, number fields
 * and text, and a framework buys nothing here.
 *
 * Phase 1 exposes the L0 brief and the handful of primary parameters the plan
 * calls for. Every primary control carries the §4.1 linked/unlinked marker:
 * a hollow dot means the derive chain owns the value, a filled amber dot means
 * the user overrode it, with one-click revert.
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

  const fmt = (v, dp) => (v == null || !isFinite(v) ? '–' : v.toFixed(dp == null ? 0 : dp));

  /**
   * Control definitions. `path` addresses a block in the params object;
   * `field` is the key. Primary fields get the link marker and go through
   * store.override(); everything else is a plain update.
   */
  const GROUPS = [
    {
      title: 'Brief',
      note: 'Describe yourself and the trip. Everything below is derived from this until you override it.',
      controls: [
        { path: 'brief', field: 'paddlerHeight', label: 'Paddler height', min: 1400, max: 2100, step: 10, unit: 'cm', scale: 0.1, dp: 0 },
        { path: 'brief', field: 'paddlerMass', label: 'Paddler mass', min: 40000, max: 140000, step: 1000, unit: 'kg', scale: 0.001, dp: 0 },
        { path: 'brief', field: 'cargoMass', label: 'Cargo mass', min: 0, max: 50000, step: 1000, unit: 'kg', scale: 0.001, dp: 0 },
        {
          path: 'brief', field: 'hipBreadth', kind: 'number', label: 'Seated hip breadth',
          unit: 'mm', placeholder: 'blank = estimate from height',
          help: 'Sit on a flat hard surface and measure the widest span across your hips. A 20 mm error here is 20 mm of beam.',
          blank: (d) => (d && d.params && d.params.derived
            ? `≈ ${fmt(d.params.derived.hipBreadth)} mm estimated` : ''),
        },
      ],
    },
    {
      title: 'Primary',
      note: 'Overriding any of these unlinks it from the brief.',
      controls: [
        { path: 'primary', field: 'interiorLength', label: 'Interior length', min: 1000, max: 1800, step: 10, unit: 'mm', dp: 0 },
        {
          path: 'primary', field: 'interiorWidth', label: 'Interior width', min: 300, max: 600, step: 10, unit: 'mm', dp: 0,
          help: 'Clear width between the tubes. Beam is this plus one tube diameter, so it drives both stability and how much fabric the boat costs.',
        },
        { path: 'primary', field: 'tubeDiaMidship', label: 'Tube diameter', min: 200, max: 400, step: 2, unit: 'mm', dp: 0 },
      ],
    },
    {
      title: 'Bow and stern',
      note: 'Independent by design (§3.5): a short upswept bow and a long low stern is what makes these boats track.',
      controls: [
        { path: 'primary', field: 'bowLengthFrac', label: 'Bow length', min: 0.14, max: 0.32, step: 0.01, unit: '% LOA', scale: 100, dp: 0 },
        { path: 'primary', field: 'bowRise', label: 'Bow rise', min: 0, max: 300, step: 5, unit: 'mm', dp: 0 },
        {
          path: 'primary', field: 'bowTaper', label: 'Bow taper', min: 0.40, max: 1.50, step: 0.02, unit: '× midship ⌀', dp: 2,
          help: 'Tube diameter at the tip (or at the cap face, if a cap is set), as a multiple of midship. Above 1.0 the end cone EXPANDS — the measured Alpacka lobe runs 1.37×, and this is the buildable way to get it. The trade: a fatter cap tube costs cap width to the mitre cuts, so the blunt face narrows; the §3.4 error names the minimum. §3.5 suggests 0.65–0.75, an estimate the photographs contradict.',
        },
        {
          path: 'primary', field: 'bowFullness', label: 'Bow fullness', min: 0, max: 1, step: 0.05, unit: '', dp: 2,
          help: 'How bluntly the two tubes converge in plan view. 0 is a straight wedge to the tip; 1 is a rounded, elliptical entry — the Alpacka "reserve nose" look. This is width, not volume, and it costs faceting: past about 0.3 you need six segments per side or the flat panels cut the corner you just paid for.',
        },
        {
          path: 'primary', field: 'bowSwell', label: 'Bow swell', min: 0.60, max: 1.60, step: 0.02, unit: '× midship ⌀', dp: 2,
          // Unset means "no swell knot"; show where the plain taper already
          // sits so the first drag is continuous rather than a jump.
          get: (p) => (p.primary.bowSwell != null ? p.primary.bowSwell
            : (p.derived && p.derived.swellAuto ? p.derived.swellAuto.bow : 1)),
          set: (p, v) => { p.primary.bowSwell = v; },
          help: 'Tube diameter partway into the bow region, as a multiple of midship. Above 1.0 the tube gets FATTER before it rounds off — which is what an Alpacka actually does: measured off a product photograph it swells to 1.43×. The spec assumes tubes only ever get thinner; they do not. This is the reserve nose, and it is a bulge, not a taper.',
        },
        { path: 'primary', field: 'sternLengthFrac', label: 'Stern length', min: 0.20, max: 0.40, step: 0.01, unit: '% LOA', scale: 100, dp: 0 },
        { path: 'primary', field: 'sternRise', label: 'Stern rise', min: -50, max: 200, step: 5, unit: 'mm', dp: 0 },
        {
          path: 'primary', field: 'sternTaper', label: 'Stern taper', min: 0.40, max: 1.50, step: 0.02, unit: '× midship ⌀', dp: 2,
          help: 'Same knob at the other end. The stern is where you sit, so fattening it moves buoyancy under the paddler. On a segmented stern the fat part is better done with the stern swell plus its seam — keeping the tip slim is what lets a narrow stern cap survive its mitre cuts.',
        },
        {
          path: 'primary', field: 'sternFullness', label: 'Stern fullness', min: 0, max: 1, step: 0.05, unit: '', dp: 2,
          help: 'Plan-view bluntness at the stern. Carrying width aft keeps more hull in the water at the solved trim, which is the direct tracking driver.',
        },
        {
          path: 'primary', field: 'sternSwell', label: 'Stern swell', min: 0.60, max: 1.60, step: 0.02, unit: '× midship ⌀', dp: 2,
          // Unset means "no swell knot"; show where the plain taper already
          // sits so the first drag is continuous rather than a jump.
          get: (p) => (p.primary.sternSwell != null ? p.primary.sternSwell
            : (p.derived && p.derived.swellAuto ? p.derived.swellAuto.stern : 1)),
          set: (p, v) => { p.primary.sternSwell = v; },
          help: 'The same bulge at the stern. Measured 1.39× on the photographed hull. Fattening the stern moves buoyancy under the paddler and lets the seat sit further aft.',
        },
        {
          path: 'primary', field: 'bowCapWidth', label: 'Bow cap width', min: 0, max: 600, step: 10, unit: 'mm', dp: 0,
          help: 'Width of the blunt end: the side tubes stop this far apart and the ring wraps around through a tangent turn — the seam optimiser fans girth seams around it exactly as real boats do. 0 keeps the pointed knife-edge tip. Measured 0.146 × LOA (~409 mm) on the photographed hull.',
        },
        {
          path: 'primary', field: 'sternCapWidth', label: 'Stern cap width', min: 0, max: 600, step: 10, unit: 'mm', dp: 0,
          help: 'Same at the stern. Measured 0.063 × LOA (~176 mm) on the photographed hull.',
        },
        {
          path: 'primary', field: 'sternKeelDip', label: 'Stern keel dip', min: 0, max: 120, step: 2, unit: 'mm', dp: 0,
          help: 'How far the keel drops BELOW the midship baseline far aft. §3.5 reports this from Explorer photographs but says no reliable magnitude was established — the measurement here puts it at 0.029 × LOA, about 82 mm on a 2.8 m boat. A deep point far aft adds lateral plane where yaw damping works best, which is why these boats track without a fin.',
        },
      ],
    },
    {
      title: 'Construction',
      controls: [
        {
          path: 'construction', field: 'segmentBudget', label: 'Segment budget', min: 3, max: 9, step: 1, unit: 'per side', dp: 0,
          help: 'How many seams are you willing to weld? Each extra segment costs ~1.9 m of weld and two more floor corners — the one verified failure point.',
        },
        {
          path: 'construction', field: 'endStyleBow', kind: 'select', label: 'Bow sections',
          options: [
            ['auto', 'auto — seams where the curve needs them'],
            ['single', 'single piece — one cone to the tip'],
          ],
          help: 'Real boats build each end as one elongated cone from the last girth seam to the tip. "Single piece" enforces that; "auto" lets the optimiser spend seams inside the bow, which follows a curvy design more closely but puts a seam through it.',
        },
        {
          path: 'construction', field: 'tipPhaseBow', kind: 'select', label: 'Bow tip closure',
          options: [
            ['seam-on-axis', 'two mirrored halves, seam on the centreline'],
            ['panel-on-axis', 'one strip across the centreline'],
          ],
          help: 'How the very tip closes. Two mirrored pieces meeting at a centre seam, or a single strip that straddles the centreline — both appear on real boats, sometimes on the same boat.',
        },
        {
          path: 'construction', field: 'endStyleStern', kind: 'select', label: 'Stern sections',
          options: [
            ['auto', 'auto — seams where the curve needs them'],
            ['single', 'single piece — one cone to the tip'],
          ],
        },
        {
          path: 'construction', field: 'tipPhaseStern', kind: 'select', label: 'Stern tip closure',
          options: [
            ['seam-on-axis', 'two mirrored halves, seam on the centreline'],
            ['panel-on-axis', 'one strip across the centreline'],
          ],
        },
        { path: 'construction', field: 'floorClockAngle', label: 'Floor clock angle', min: 170, max: 230, step: 1, unit: '°', dp: 0 },
        {
          path: 'construction', field: 'floorTabWidth', label: 'Floor tab width', min: 30, max: 200, step: 5, unit: 'mm', dp: 0,
          help: 'How far the floor climbs the tube before the weld. Wider is more forgiving to weld but wraps past the outboard equator, where the arc has to be clamped.',
        },
        {
          path: 'construction', field: 'stripWidth', label: 'Butt-strip width', min: 25, max: 90, step: 5, unit: 'mm', dp: 0,
          help: 'Total width of the strip over a butt joint; half of it bonds on each side. Bond capacity scales with that width, so this is the seam safety factor lever.',
        },
      ],
    },
    {
      title: 'Load and pressure',
      note: 'Not geometry — these drive the §5 analysis in the right-hand rail.',
      controls: [
        {
          path: 'analysis', field: 'designPressureBar', label: 'Design pressure', min: 0.05, max: 0.35, step: 0.01, unit: 'bar', dp: 2,
          help: 'What you inflate to on the water. Everything structural is judged at PROOF pressure, which is this plus the thermal rise below.',
        },
        {
          path: 'analysis', field: 'waterTempC', label: 'Water temperature', min: 0, max: 30, step: 1, unit: '°C', dp: 0,
          help: 'Temperature when you inflate. Cold water and a hot afternoon is the worst case, and it is how DIY boats actually burst.',
        },
        {
          path: 'analysis', field: 'airTempC', label: 'Hot-day air temperature', min: 10, max: 60, step: 1, unit: '°C', dp: 0,
          help: 'The gravel bar in the sun. Absolute pressure scales with absolute temperature (§6).',
        },
        {
          path: 'analysis', field: 'seatPositionFromStern', kind: 'number', label: 'Seat position from stern',
          unit: 'mm', placeholder: 'blank = solve for level trim',
          help: 'Leave blank and the analysis reports where the seat must go for the boat to float level. Type a number to see what your chosen position actually does to the trim.',
          blank: (d) => (d && d.analysis
            ? `≈ ${fmt(d.analysis.trim.seatForLevelFromStern)} mm for level trim` : ''),
        },
      ],
    },
  ];

  function build(store, railEl) {
    const refresh = [];
    const byField = Object.create(null);

    for (const group of GROUPS) {
      const g = el('div', 'group');
      g.appendChild(el('h2', null, group.title));
      if (group.note) g.appendChild(el('p', 'note', group.note));
      for (const c of group.controls) {
        const wrap = control(store, c, refresh);
        byField[c.path + '.' + c.field] = wrap;
        g.appendChild(wrap);
      }
      railEl.appendChild(g);
    }

    return {
      refresh: (design, raw) => { for (const fn of refresh) fn(design, raw); },

      /**
       * §15: a red metric links to the parameter that moves it. Scroll the
       * control into view and flash it. Returns false when the metric names a
       * field with no control, so the caller can stay silent rather than
       * pretending something happened.
       */
      focus(field) {
        const wrap = byField[field];
        if (!wrap) return false;
        wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
        wrap.classList.remove('flash');
        // Force a reflow so re-clicking the same metric restarts the animation.
        void wrap.offsetWidth;
        wrap.classList.add('flash');
        setTimeout(() => wrap.classList.remove('flash'), 1400);
        return true;
      },
    };
  }

  function control(store, c, refresh) {
    const wrap = el('div', 'ctl');
    wrap.dataset.field = c.path + '.' + c.field;
    const head = el('div', 'ctl-head');
    const isPrimary = c.path === 'primary';

    const dot = el('span', 'link-dot');
    if (isPrimary) head.appendChild(dot);

    const label = el('label', null, c.label);
    head.appendChild(label);

    const val = el('span', 'val');
    head.appendChild(val);

    const revert = el('button', 'revert', 'revert');
    if (isPrimary) {
      revert.title = 'Hand this back to the derive chain';
      revert.addEventListener('click', () => store.revert(c.field));
      head.appendChild(revert);
    }
    wrap.appendChild(head);
    if (c.help) { label.title = c.help; wrap.title = c.help; }

    const getValue = (p) => (c.get ? c.get(p) : p[c.path][c.field]);
    const setValue = (p, v) => {
      if (c.set) c.set(p, v);
      else p[c.path][c.field] = v;
    };

    let input;
    if (c.kind === 'select') {
      input = el('select');
      for (const [v, text] of c.options) {
        const o = el('option', null, text);
        o.value = v;
        input.appendChild(o);
      }
      input.addEventListener('change', () => {
        store.update((p) => setValue(p, input.value), null);
      });
    } else if (c.kind === 'number') {
      input = el('input');
      input.type = 'number';
      if (c.placeholder) input.placeholder = c.placeholder;
      input.addEventListener('change', () => {
        const v = input.value === '' ? null : Number(input.value);
        store.update((p) => setValue(p, v), null);
      });
    } else {
      input = el('input');
      input.type = 'range';
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (isPrimary) store.override(c.field, v);
        else store.update((p) => setValue(p, v), c.path + '.' + c.field);
      });
    }
    wrap.appendChild(input);

    refresh.push((design, raw) => {
      // Read from the DERIVED params, never the raw ones: a linked field's
      // raw value is whatever it was last set to and goes stale the instant
      // the brief moves. derive() leaves overridden fields untouched, so this
      // is correct for linked and unlinked alike.
      const shown = (design && design.params) || raw;
      if (!shown) return;
      const v = getValue(shown);
      if (document.activeElement !== input) {
        input.value = v == null ? '' : v;
      }
      if (c.kind === 'number') {
        // A blank optional field is not empty, it is *solved for*. Show what
        // the engine assumed, so the placeholder is never the whole story.
        val.textContent = v == null
          ? (c.blank ? c.blank(design) || '' : '')
          : `${fmt(v)} ${c.unit}`;
      } else if (c.kind !== 'select') {
        val.textContent = `${fmt(v * (c.scale || 1), c.dp)} ${c.unit}`;
      }
      if (isPrimary) wrap.classList.toggle('unlinked', !store.isLinked(c.field));
    });

    return wrap;
  }

  /** Warnings and errors, most severe first (§15: every warning explains itself). */
  function renderIssues(design, host, onFocusField) {
    host.textContent = '';
    if (!design || !design.issues) return;
    const sorted = design.issues.slice().sort((a, b) =>
      (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1));
    for (const i of sorted) {
      const n = el('div', 'issue ' + i.level);
      n.appendChild(el('span', 'code', i.level + ' · ' + i.code + (i.field ? ' · ' + i.field : '')));
      n.appendChild(document.createTextNode(i.message));
      // §15: an issue that names a parameter jumps to it. The linking is
      // conditional on a control existing, so an issue about something the UI
      // does not yet expose is text rather than a dead click target.
      if (i.field && onFocusField) {
        n.classList.add('linked');
        n.addEventListener('click', () => {
          if (!onFocusField(i.field)) n.classList.remove('linked');
        });
      }
      host.appendChild(n);
    }
  }

  function renderMetrics(design) {
    const set = (id, text, cls) => {
      const n = document.getElementById(id);
      n.textContent = text;
      n.className = cls || '';
    };
    if (!design || !design.params) return;
    const d = design.params.derived;
    const sk = design.skeleton;

    set('m-segments', sk ? String(sk.segments.length) : '–');
    set('m-deviation', sk ? fmt(sk.deviation, 1) + ' mm' : '–');
    set('m-loa', fmt(design.params.primary.loa) + ' mm');
    set('m-beam', fmt(design.params.primary.beam) + ' mm');
    set('m-dia', fmt(design.params.primary.tubeDiaMidship) + ' mm');
    // As-built where available: the Pappus figure is a sizing target, the
    // enclosed volume is what the boat will actually float on.
    set('m-reserve', fmt(design.builtReserveRatio != null
      ? design.builtReserveRatio : d.reserveRatio, 2));
    set('m-time', fmt(design.ms, 0) + ' ms');

    if (design.nest) {
      const n = design.nest;
      set('m-fabric', n.tube.linearMetres.toFixed(1) + ' + ' + n.floor.linearMetres.toFixed(1) + ' m');
      set('m-waste', Math.round((n.tube.wastePercent + n.floor.wastePercent) / 2) + '%');
    } else {
      set('m-fabric', '…'); set('m-waste', '…');
    }

    const v = design.verification;
    if (!v) {
      set('m-mismatch', '…');
    } else {
      const tol = P.constants.TOL_MATED_EDGE;
      set('m-mismatch', v.maxMismatch.toFixed(2) + ' mm',
        v.maxMismatch < tol ? 'good' : 'bad');
    }
  }

  P.ui = { build, renderIssues, renderMetrics };
})(typeof globalThis !== 'undefined' ? globalThis : this);
