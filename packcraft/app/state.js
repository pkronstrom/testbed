/**
 * Design state store: the single owner of the params object (spec §11, §15).
 *
 * Holds the RAW params (what the user set) and the DESIGN (what the kernel
 * makes of them: derived params, skeleton, panels, issues). Every mutation
 * goes through update(), which regenerates, records undo and persists.
 *
 * Regeneration is split in two on purpose:
 *   live      derive + skeleton + light development, ~12 ms, runs on every
 *             slider tick so dragging stays responsive
 *   verify    the arc-length quadratures behind the mated-edge readout,
 *             ~22 ms, debounced until the drag stops
 * The verification numbers are a check on the geometry, not an input to it,
 * so deferring them changes nothing that gets built.
 *
 * A generate failure never blanks the viewport: the last good geometry stays
 * on screen and the error is surfaced as an issue (§15 "never a crash").
 */
;(function (root) {
  'use strict';
  const P = root.Packraft || (root.Packraft = {});

  const STORAGE_KEY = 'packraft.design.v1';
  const UNDO_LIMIT = 100;
  const COALESCE_MS = 600;   // a continuous slider drag is one undo step
  const VERIFY_DELAY = 180;
  const ANALYSIS_DELAY = 260;
  const HASH_DELAY = 400;

  /** localStorage is unavailable in some file:// contexts; degrade quietly. */
  function safeStorage(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function createStore() {
    let raw = null;
    let design = null;
    const subs = [];
    const undoStack = [];
    const redoStack = [];
    let lastLabel = null;
    let lastStamp = 0;
    let verifyTimer = null;
    let analysisTimer = null;
    let hashTimer = null;
    /**
     * Last converged finished mass, in grams (§5.1). The live path needs a
     * boat mass before there is a boat to weigh, so it starts on the seed
     * constant and adopts the analysis figure once one exists. This is only a
     * head start: analysis.solve() always re-runs the loop from the seed, so
     * its own numbers never depend on what the viewport happened to use.
     */
    let boatMass = null;

    const snapshot = () => JSON.stringify(raw);
    const notify = () => { for (const fn of subs) fn(design, raw); };

    function generate() {
      const t0 = performance.now();
      const out = { ok: true, issues: [] };
      try {
        const derived = P.params.derive(raw, { boatMass });
        out.params = derived;
        out.issues = P.params.validate(derived);
        const sk = P.skeleton.buildSkeleton(derived);
        out.skeleton = sk;
        out.issues = out.issues.concat(sk.issues);
        const seamAngle = (derived.construction.floorClockAngle * Math.PI) / 180;
        out.panels = sk.segments.map((s) =>
          P.develop.developSegment(s, { samples: 48, measure: false, seamAngle }));
        // The volume the generated boat actually encloses, as against the
        // Pappus figure the derive chain sizes against. Free here: it reuses
        // the surface already built for the viewport.
        const built = P.develop.enclosedVolume(out.panels);
        out.builtVolume = built;
        out.builtReserveRatio = built / derived.derived.displacementVolume;
      } catch (e) {
        out.ok = false;
        out.issues = (out.issues || []).concat([{
          level: 'error', code: 'generate', field: '',
          message: 'Could not generate this design: ' + e.message,
        }]);
        if (design) {
          out.params = out.params || design.params;
          out.skeleton = design.skeleton;
          out.panels = design.panels;
          out.stale = true;
        }
      }
      out.ms = performance.now() - t0;
      out.verification = design && out.ok ? null : (design ? design.verification : null);
      // Carry the last analysis forward, flagged stale, so dragging a slider
      // dims the right-hand rail rather than blanking it.
      if (design && design.analysis) {
        out.analysis = design.analysis;
        out.analysisStale = true;
      }
      design = out;
    }

    /** Warnings that only exist once the flat parts do. */
    function panelIssues(built) {
      const out = [];
      if (built.floor.anyBandClamped) {
        out.push({
          level: 'warn', code: 'tab-wrap', field: 'construction.floorTabWidth',
          message: 'The floor tab hits its wrap-angle ceiling on at least one segment: '
            + 'past the outboard equator the fabric would have to shrink-wrap, so the arc is clamped there (§3.7).',
        });
      }
      return out;
    }

    /** The expensive check, deferred until the user stops moving things. */
    function scheduleVerify() {
      clearTimeout(verifyTimer);
      verifyTimer = setTimeout(() => {
        if (!design || !design.ok || !design.skeleton) return;
        try {
          const mated = P.develop.matedEdges(design.skeleton);
          let maxMismatch = 0, maxConservation = 0;
          for (const e of mated) {
            if (e.mismatch > maxMismatch) maxMismatch = e.mismatch;
            const c = Math.max(e.conservationA, e.conservationB);
            if (c > maxConservation) maxConservation = c;
          }
          design.verification = { mated, maxMismatch, maxConservation };
          // Panels and nesting ride the same debounce: they cost ~40 ms and
          // nothing on the live path needs them.
          const built = P.panels.build(design.params, design.skeleton, { samples: 240, measure: false });
          design.built = built;
          design.nest = P.nest.nest(built, design.params.materials);
          design.issues = design.issues.concat(panelIssues(built));
          notify();
        } catch (e) { /* the issue list already carries the failure */ }
      }, VERIFY_DELAY);
    }

    /**
     * The §5 naval-architecture pass. Roughly 120 ms, because it re-runs the
     * whole derive/skeleton/panels/nest chain two or three times to close the
     * mass<->displacement loop, so it sits behind its own longer debounce and
     * lands after the pattern has already painted.
     *
     * It re-solves from the raw params rather than reusing design.params: the
     * whole point of the loop is that the mass it converges on changes the
     * tube size that produced it.
     */
    function scheduleAnalysis() {
      clearTimeout(analysisTimer);
      analysisTimer = setTimeout(() => {
        if (!design || !design.ok) return;
        const target = design;
        try {
          const a = P.analysis.solve(raw, { samples: 240 });
          // A commit may have landed while this ran; its own pass will follow.
          if (design !== target) return;
          design.analysis = a;
          design.analysisStale = false;
          // validate()'s reserve check is sized off the Pappus volume, which
          // overstates the built boat by ~2%. The analysis measures the hull
          // that actually gets welded, so once it has run its verdict is the
          // only one worth showing -- two warnings about the same thing with
          // different numbers is worse than either alone.
          design.issues = design.issues
            .filter((i) => i.code !== 'reserve-ratio')
            .concat(a.issues);
          if (a.mass.converged) boatMass = a.mass.total;
          notify();
        } catch (e) {
          if (design !== target) return;
          design.analysis = null;
          design.issues = design.issues.concat([{
            level: 'warn', code: 'analysis', field: '',
            message: 'The floats-and-trim analysis could not run on this design: ' + e.message
              + ' The geometry above is unaffected.',
          }]);
          notify();
        }
      }, ANALYSIS_DELAY);
    }

    function schedulePersist() {
      safeStorage(() => localStorage.setItem(STORAGE_KEY, snapshot()));
      clearTimeout(hashTimer);
      hashTimer = setTimeout(async () => {
        try {
          const payload = await P.encode.encode(raw);
          // Preserve anything else already in the hash (the view mode).
          const others = location.hash.replace(/^#/, '').split('&')
            .filter((kv) => kv && !/^d=/.test(kv));
          history.replaceState(null, '', '#' + others.concat('d=' + payload).join('&'));
        } catch (e) { /* a missing hash is not worth interrupting anyone over */ }
      }, HASH_DELAY);
    }

    function commit(label) {
      generate();
      scheduleVerify();
      scheduleAnalysis();
      schedulePersist();
      notify();
    }

    const store = {
      subscribe(fn) { subs.push(fn); if (design) fn(design, raw); },

      raw: () => raw,
      design: () => design,

      /** Replace the whole params object (load, reset, permalink). */
      load(params, opts) {
        if (!(opts && opts.noUndo) && raw) {
          undoStack.push(snapshot());
          redoStack.length = 0;
        }
        raw = JSON.parse(JSON.stringify(params));
        lastLabel = null;
        commit();
      },

      /**
       * Mutate params. `label` groups a continuous interaction (a slider
       * drag) into one undo step.
       */
      update(mutator, label) {
        const before = snapshot();
        const now = Date.now();
        const coalesce = label && label === lastLabel && (now - lastStamp) < COALESCE_MS;
        if (!coalesce) {
          undoStack.push(before);
          if (undoStack.length > UNDO_LIMIT) undoStack.shift();
          redoStack.length = 0;
        }
        lastLabel = label || null;
        lastStamp = now;
        mutator(raw);
        commit();
      },

      /** Override a primary field, marking it unlinked from the brief (§4.1). */
      override(field, value) {
        store.update((p) => {
          p.primary[field] = value;
          p.linked[field] = false;
        }, 'primary.' + field);
      },

      /** Relink a primary field so the derive chain owns it again. */
      revert(field) {
        store.update((p) => { delete p.linked[field]; }, null);
      },

      isLinked: (field) => !raw || raw.linked[field] !== false,

      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,

      undo() {
        if (!undoStack.length) return;
        redoStack.push(snapshot());
        raw = JSON.parse(undoStack.pop());
        lastLabel = null;
        commit();
      },

      redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshot());
        raw = JSON.parse(redoStack.pop());
        lastLabel = null;
        commit();
      },

      /** Current permalink, or null if encoding is unavailable. */
      async permalink() {
        const payload = await P.encode.encode(raw);
        return location.href.split('#')[0] + '#d=' + payload;
      },
    };

    /**
     * Startup precedence: URL hash (someone shared a design) beats
     * localStorage (the last session) beats the §16 reference design.
     */
    store.boot = async function boot() {
      const fromHash = P.encode.payloadFromHash(location.hash);
      if (fromHash) {
        try {
          store.load(await P.encode.decode(fromHash), { noUndo: true });
          return 'permalink';
        } catch (e) { /* fall through to the next source */ }
      }
      const saved = safeStorage(() => localStorage.getItem(STORAGE_KEY), null);
      if (saved) {
        try {
          store.load(P.encode.migrate(JSON.parse(saved)), { noUndo: true });
          return 'restored';
        } catch (e) { /* fall through */ }
      }
      store.load(P.params.defaults(), { noUndo: true });
      return 'default';
    };

    return store;
  }

  P.state = createStore();
  P.createStore = createStore;
  if (typeof module === 'object' && module.exports) module.exports = P.state;
})(typeof globalThis !== 'undefined' ? globalThis : this);
