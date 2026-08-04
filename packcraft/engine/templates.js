/**
 * engine/templates.js -- STARTING POINTS, not destinations.
 *
 * Plan v5, emphatic: THERE IS NO GOLDEN BOAT. A template is a document the user
 * opens and then reshapes; the engine's acceptance criterion is the EDIT LOOP,
 * not any particular hull. The DIY 7-panel boat below is a SMOKE TEST -- it
 * exercises every topology (pointed end, bridged end, mirror, floor) in one
 * document -- and must never become a target. Old-app output comparisons are
 * kernel regression references, nothing more.
 *
 * So this file is a small LIBRARY of different starting points, chosen to span
 * the topologies the kernel has to survive rather than to be good boats:
 *
 *   diy7      bridged bow + pointed stern, 4 stored welds   (the smoke test)
 *   canoe     pointed at BOTH ends, 6 stored welds          (no span at all)
 *   raft      bridged at BOTH ends, 4 stored welds          (two spans)
 *   longboat  bridged bow + pointed stern, 6 stored welds   (gentle angles)
 *
 * There is no derive chain here, no optimiser, no anthropometrics: those live
 * in the old parametric spine, which this engine may not import (architecture
 * review 27 -- "generators emit documents, the engine consumes documents", and
 * tests/engine.test.js asserts mechanically that engine/* never resolves
 * packraft-core/*).
 *
 * ---------------------------------------------------------------------------
 * HOW A HAND-WRITTEN TEMPLATE IS BUILT
 *
 * Give a plan-view path: a list of centreline nodes down the PORT side.
 * Everything else falls out:
 *
 *   normal  the bisector of the incoming and outgoing chord directions -- the
 *           mitre plane, the one piece of the Monge construction worth keeping,
 *           demoted to exactly what the plan says it is: "a generator of nice
 *           ellipses", not the spine.
 *   b       the tube half-height. UNIFORM boat-wide (user direction, below).
 *   a       b / cos(rake) by default: a plane at angle rake to a tube of
 *           half-height b cuts an ellipse that wide. NOTE this is the cylinder
 *           relation. The geometry review (finding 5) is right that a TAPERED
 *           cone cut at rake rho gives b = R0/sqrt(1-k^2) etc -- but that only
 *           matters if you are trying to reproduce a cone. Here THE WELD IS
 *           AUTHORITATIVE: these numbers define the weld ellipse and the
 *           segment is whatever developable connects the two. No cylinder-only
 *           assumption is smuggled into the kernel. Where a node names an
 *           `aspect`, that overrides the mitre value outright -- see below.
 *   roll    the in-plane angle of the projected tube axis. This is the dof the
 *           original schema lacked and which costs up to 35 mm of radial shape
 *           error at the bow bridge when forced to zero (interaction review 15).
 *   seam    the document's floor clock angle, geometric (engine/doc.js).
 *
 * Tip topology needs no flags at all, which is the entire point of the
 * weld-first model. A POINTED end is a weld lying on the centreplane
 * (`onCentreplane: true`); a BRIDGED end is an end weld sitting off the
 * centreplane, so the derived ring closes through a self-mirroring span.
 * `tipPhaseBow`, `tipPhaseStern`, `endStyle*`, `capWidth`, `bowSwell`,
 * `bowFullness`, `uniformRadius`, ring-path turn sampling and DP exclusion
 * ranges all dissolve into "where the welds are".
 *
 * ---------------------------------------------------------------------------
 * ONE SHAPE RULE, USER DIRECTION, ENFORCED BY tests/engine-ops.test.js
 *
 * ONE TUBE. A packraft is a constant-diameter pipe bent round a path and
 * mitred at the turns -- "a singular tube should have a matching side profile
 * across its length". So every weld in a shipped template carries the SAME
 * `b` (`locks.uniformB` engaged, honestly: the stored document is the
 * document the lock claims), and every weld's `a` is EXACTLY the mitre value
 * b / cos(rake) -- the ellipse a plane at that angle cuts from that one tube.
 * Then every segment between welds is a true cylinder of the same radius,
 * and the plan silhouette holds one width down the whole boat.
 *
 * Everything the ends need falls out of that rule instead of being declared:
 *
 *   pointed stern -- the tip weld lies on the centreplane at a steep rake, so
 *     its section is NATURALLY a wide flat lens (a/b > 2 at the templates'
 *     tip angles): the two mirrored tubes merge fore-and-aft-wide and
 *     uniform-height, which is what the kit photos show. No override needed.
 *
 *   bridged bow -- the span between a weld and its own reflection is the same
 *     tube crossing the boat, and its corner welds are ordinary mitres.
 *
 * The earlier revision DECLARED the end welds oblong (`aspect: 1.45-1.8`
 * overriding the mitre value). That bought a fatter nose in one number but
 * broke the rule above: a weld wider than its own tube forces every
 * neighbouring segment to loft from circular to wide -- visible cones in the
 * plan view, "tube profile that will not do" (user). The refined rule
 * (diy7's bow): a weld MAY be declared wider than its mitre value (`widen`)
 * where the seam itself should take more area, PROVIDED the cone that buys
 * it is confined to a short gusset panel and never a main tube -- b is
 * untouched either way, so the side profile stays one height. The raw
 * `aspect`/`a` overrides remain for manual-mode experiments and for the
 * oblong BENCH document the numerics tests need.
 *
 * Proportion targets are taken from real boats (measured/published): DIY
 * Packraft Skeena 263-283 cm x 93 cm, 27.5 cm tubes -> LOA/beam 2.83-3.04,
 * tube/beam ~0.30; Alpacka Classic 11.7 in tubes; the Alpacka patent
 * (US 2018/0257744) describes a generally rectangular centre section, a
 * rounded full bow and a frustoconical stern LONGER than one tube diameter.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') { require('./vec3.js'); require('./doc.js'); }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const D = E.doc;

  const DEG = Math.PI / 180;

  /**
   * Build a weld document from a port-side centreline path.
   *
   * @param {Array<{c:number[], r?:number, widen?:number, aspect?:number,
   *                a?:number, onCentreplane?:boolean}>} nodes  bow-to-stern down
   *   the port side. `r` overrides the uniform half-height at this node (which
   *   makes the uniform-b lock dishonest -- shipped templates do not use it).
   *   `widen` multiplies the mitre value (a = widen * b/cos(rake)): the tube is
   *   horizontally flattened at this weld, height untouched -- the taper rule
   *   below. `aspect` sets a = aspect * b ignoring the mitre relation; `a` sets
   *   it outright. Benches use those two; shipped templates use only `widen`.
   * @param {{b?:number, mirror?:boolean, floor?:object, locks?:object,
   *          meta?:object}} opts
   */
  function fromPath(nodes, opts) {
    const o = opts || {};
    const floor = Object.assign({ clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      o.floor || {});
    const seam = floor.clockAngle * DEG;
    const mirror = o.mirror !== false;
    const bUniform = o.b == null ? 150 : o.b;

    // Derive the full ring of node CENTRES so every weld's normal can be a
    // true bisector -- including the two that straddle the centreplane.
    const ringNodes = nodes.slice();
    if (mirror) {
      const first = nodes[0].onCentreplane ? 1 : 0;
      const last = nodes[nodes.length - 1].onCentreplane ? nodes.length - 2 : nodes.length - 1;
      for (let i = last; i >= first; i--) {
        ringNodes.push({ c: V.mirrorY(nodes[i].c) });
      }
    }
    const N = ringNodes.length;

    const welds = nodes.map((node, i) => {
      const prev = ringNodes[(i - 1 + N) % N].c;
      const next = ringNodes[(i + 1) % N].c;
      const inAxis = V.norm(V.sub(node.c, prev));
      const outAxis = V.norm(V.sub(next, node.c));
      let n = V.norm(V.add(inAxis, outAxis));
      if (node.onCentreplane) n = V.norm([0, n[1] < 0 ? -1 : 1, 0]);

      // Rake: the angle the mitre plane makes with the local tube axis.
      const cosRake = Math.abs(V.dot(n, outAxis));
      const b = node.r == null ? bUniform : node.r;
      const mitre = b / Math.max(1e-9, cosRake);
      const a = node.a != null ? node.a
        : (node.aspect != null ? node.aspect * b
          : (node.widen != null ? node.widen * mitre : mitre));

      // The major axis lies along the tube axis projected into the weld plane.
      const eMajor = V.norm(V.reject(outAxis, n));
      const f = V.frame(n);
      const roll = Math.atan2(V.dot(eMajor, f.v), V.dot(eMajor, f.u));

      return {
        c: node.c.slice(), n, a, b, roll, seam,
        onCentreplane: !!node.onCentreplane, profile: null,
      };
    });

    const uniform = welds.every((w) => w.b === welds[0].b);
    return D.create({
      mirror,
      welds,
      floor,
      locks: Object.assign({ uniformB: uniform, mirror: true, pairs: [] }, o.locks || {}),
      meta: Object.assign({ name: 'untitled', note: '' }, o.meta || {}),
    });
  }

  // ------------------------------------------------------------------
  // The library
  // ------------------------------------------------------------------

  /**
   * THE DIY 7-PANEL BOAT -- the smoke test, NOT the goal (plan v5).
   *
   * One document containing every topology the engine has to survive: a bridged
   * bow (self-mirroring span), a pointed stern (centreplane weld), the mirror,
   * and a floor.
   *
   *   port half, bow -> stern            derived ring (7 welds, 7 segments)
   *   W1 bow bridge end   x = +1080      W1  W2  W3  W4*  M(W3) M(W2) M(W1)
   *   W2 bow corner       x =  +900      L1  L2  L3  R3   R2    R1    BOW
   *   W3 stern knuckle    x =  -400
   *   W4 stern tip        x = -1280  * on the centreplane -> pointed stern
   *
   * THE LAYOUT IS THE KIT'S OWN PANEL DIAGRAM, seam for seam: piece 1 is the
   * BOW span, 2L/2R the corner panels (L1/R1), 3L/3R the sides (L2/R2),
   * 4L/4R the stern taper (L3/R3) -- 4 stored welds, 7 panels + floor. The
   * diagram's plan signatures, all MEASURED off the diagram (pixel-scanned
   * width profile) and reproduced by seam position on a pure mitred tube
   * (no `widen`, no aspect):
   *
   *   BLUNT NOSE, NOT THE WIDEST LINE  piece 1's leading edge sits at 0.74
   *     of the beam. (The diagram scans at 0.62; the extra width is user
   *     direction -- a wider piece 1 and longer 2L/2R runs make the bow
   *     chamber roomy enough to take a cargo ZIPPER. The first pass had the
   *     nose at 0.91 and the whole boat read as tapering backwards.)
   *   WIDE-SWEEPING 1|2 SEAMS  the bridge welds carry `widen: 1.4` -- the
   *     one deliberate departure from the mitre value in the library, and it
   *     is user direction twice over: the diagram's piece 1 is a deep
   *     trapezoid whose side seams sweep diagonally from the gunwale corners
   *     toward the cockpit, taking real area. A pure mitre CANNOT reach that
   *     sweep: for two equal cylinders the weld plane must bisect, and the
   *     plan turn caps the seam at ~45 deg of rake (pushing the corner weld
   *     inboard to force more folds the ring past square -- measured, gates
   *     object at 94-103 deg turns). Widening the weld keeps b (the height)
   *     untouched: the span becomes an oblong constant-section tube -- wider
   *     fore-and-aft, same height, side profile still constant -- and the
   *     taper is confined to the 2L/2R gussets, which is exactly what the
   *     kit's own small tapered corner piece is.
   *   LONG FLARING CORNERS, BLUNT FRONT  the corner weld sits OUTBOARD at
   *     (800, 325) -- read closely off the drawing: the 1|2 seams leave the
   *     outline exactly at the blunt front corners, and the 2|3 seam meets
   *     the outline well aft, so the flare through 2L/2R is what rounds the
   *     front. Splitting the plan turn 64/25 (bridge/corner) instead of
   *     79/8 blunts the front corner from ~101 to ~116 deg interior while
   *     the corner silhouette (475) stays inside the knuckle's (485): the
   *     widest line of the boat remains aft.
   *   SIDES WIDEN AFT  the widest line of the boat is the stern KNUCKLE
   *     (measured: width grows 185 -> 250 px from 28% to 62% of length).
   *     y runs 245 at the 2|3 seam to 335 at the 3|4 seam.
   *   ONE STRAIGHT V STERN  4L is a single panel: knuckle at full beam,
   *     straight 860 mm run to the tip, no mid-taper seam. The shallow
   *     convergence puts the tip's mitre lens at a/b = 2.8, so the two tubes
   *     merge as the diagram's wide wedge.
   *
   * ONE TUBE throughout (header rule): b = 150 everywhere, every a the mitre
   * value, all seven segments cylinders of the same 300 mm tube.
   * LOA ~2920, beam ~975 at the knuckle, L/B 3.0.
   */
  function diy7() {
    return fromPath([
      { c: [1080, 190, 250], widen: 1.4 },    // bow bridge, port end (1|2L seam)
      { c: [800, 325, 205] },                 // bow corner (2L|3L seam)
      { c: [-420, 335, 155] },                // stern knuckle (3L|4L seam), widest
      { c: [-1280, 0, 150], onCentreplane: true },  // pointed stern
    ], {
      b: 150,
      floor: { clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      meta: {
        name: 'DIY 7-panel',
        note: 'The kit’s panel diagram, seam for seam: BOW=1, L1/R1=2L/2R, '
          + 'L2/R2=3L/3R, L3/R3=4L/4R, plus the floor. One 300 mm tube '
          + 'throughout; blunt zipper-ready nose (front/beam 0.74, long 2L/2R '
          + 'runs), sides widening aft, one straight V stern (tip a/b 2.8).',
      },
    });
  }

  /**
   * KIT -- the user-approved PRESET, frozen 2026-08-03.
   *
   * A verbatim copy of diy7 as it stood when the user signed off on the bow
   * ("looks better now; save that as a preset model"): the kit panel diagram
   * seam for seam, blunt front corners (turn split 64/25), wide-sweeping 1|2
   * seams (widen 1.4, the zipper-ready chamber), sides widening aft to the
   * knuckle, one straight V stern. diy7 remains the EVOLVING smoke test
   * (plan v5) and may drift; this entry must not -- change it only on
   * explicit user direction.
   */
  function kit() {
    return fromPath([
      { c: [1080, 190, 250], widen: 1.4 },    // bow bridge, port end (1|2L seam)
      { c: [800, 325, 205] },                 // bow corner (2L|3L seam)
      { c: [-420, 335, 155] },                // stern knuckle (3L|4L seam), widest
      { c: [-1280, 0, 150], onCentreplane: true },  // pointed stern
    ], {
      b: 150,
      floor: { clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      meta: {
        name: 'DIY kit (preset)',
        note: 'User-approved preset of the kit-diagram boat, frozen. Blunt '
          + 'front corners, widen 1.4 bow seams, widest at the stern knuckle, '
          + 'straight V stern. One 300 mm tube, uniform height.',
      },
    });
  }

  /**
   * CANOE -- pointed at BOTH ends.
   *
   * The topology diy7 does not have: no self-mirroring span anywhere, both end
   * welds on the centreplane, so the derived ring simply turns at each tip.
   * Ten segments (5 port, 5 starboard) and every one of them an ordinary panel.
   *
   * Every weld takes the mitre value (one tube); both tips come out wide
   * lenses at a = 2.39 b from their own rake alone.
   *
   * The entry lengths are set by the tip lens, not by taste: the tip weld's
   * ellipse consumes b*tan(rake) of the segment behind it, and rake at a tip is
   * large by construction (the tube axis is nearly perpendicular to the
   * athwartships weld plane). At 145 mm tube height and a 65 deg rake that is
   * 315 mm, so the quarter weld has to stand 700+ mm off the tip. Crowding it
   * closer is what the first draft of this template did, and the gates said so
   * precisely: interleave -13 mm, 92 of 360 stations with crossing rulings, the
   * correspondence non-monotone, and conservation off by 217 mm.
   */
  function canoe() {
    return fromPath([
      { c: [1150, 0, 200], onCentreplane: true },   // pointed bow
      { c: [500, 300, 150] },                       // fore quarter
      { c: [170, 340, 120] },
      { c: [-170, 340, 120] },
      { c: [-500, 300, 150] },                      // aft quarter
      { c: [-1150, 0, 200], onCentreplane: true },  // pointed stern
    ], {
      b: 145,
      floor: { clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      meta: {
        name: 'canoe',
        note: 'Both ends pointed: two centreplane welds, no bridge span, ten '
          + 'segments. One 290 mm tube throughout; the tip welds are wide '
          + 'lenses from their own rake.',
      },
    });
  }

  /**
   * RAFT -- bridged at BOTH ends.
   *
   * The other end-topology extreme: neither end weld is on the centreplane, so
   * the ring closes through TWO self-mirroring spans (labelled BOW and STERN)
   * and there is no pointed tip at all. Twelve segments, all of them the same
   * 310 mm tube (the header rule).
   *
   * Each bridge is flanked by a CORNER weld for the same reason diy7 grew one:
   * without it the ~81 deg plan turn from side tube to span sat on one mitre
   * and all four corners of the raft read as a rectangle from above. The
   * corner split is 54/36.
   *
   * (This template used to carry a = 2 b overrides on the bridge welds to
   * exercise the general correspondence; that job moved to `oblongBench`
   * below when the overrides turned the corner panels into visible cones.)
   */
  function raft() {
    return fromPath([
      { c: [1100, 250, 185] },   // bow bridge, port end
      { c: [920, 380, 175] },    // bow corner
      { c: [500, 380, 130] },
      { c: [-500, 380, 130] },
      { c: [-920, 380, 175] },   // stern corner
      { c: [-1100, 250, 185] },  // stern bridge, port end
    ], {
      b: 155,
      floor: { clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      meta: {
        name: 'raft',
        note: 'Both ends bridged: two self-mirroring spans, no centreplane '
          + 'weld. One 310 mm tube throughout, corner welds splitting each '
          + 'end turn.',
      },
    });
  }

  /**
   * LONGBOAT -- more welds, gentler angles.
   *
   * Six stored welds instead of four, so the turn at each joint is roughly
   * halved and the mitre rakes with it. That matters to the kernel: gentle
   * rakes are the well-conditioned end of the correspondence, and a template
   * that stays there is the one to reach for when an edit has walked the boat
   * into a developability warning. Bridged bow, pointed stern, 11 segments
   * (6 stored welds, one of them a centreplane tip that is emitted once, so the
   * derived ring is 6 + 5 = 11 -- B2's comment said 12).
   *
   * W2 sits up at the bow as a CORNER weld (it was a midbody station at
   * x = +1000, which left ~81 deg of plan turn on the bridge mitre alone --
   * the near-rectangular corner the templates were called out for). At
   * (1330, 312) the bow turn splits 59/33 over two welds; same weld count.
   */
  function longboat() {
    return fromPath([
      { c: [1500, 210, 220] },   // bridged bow
      { c: [1330, 312, 200] },   // bow corner
      { c: [400, 340, 130] },
      { c: [-300, 340, 130] },
      { c: [-900, 280, 150] },   // quarter
      { c: [-1450, 0, 190], onCentreplane: true },  // pointed stern
    ], {
      b: 140,
      floor: { clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      meta: {
        name: 'longboat',
        note: 'Six stored welds, gentle joint angles, bridged bow + pointed '
          + 'stern, 11 segments. One 280 mm tube throughout.',
      },
    });
  }

  /**
   * A single-segment BENCH: two coaxial circles in parallel planes.
   *
   * Both normals point along +x, i.e. along traversal for the segment A -> B.
   * (In a closed ring a weld's normal points at the NEXT weld; a two-weld
   * "ring" is degenerate, so this bench is for lofting A -> B directly, not for
   * `develop2.build`.) Exercises the exact cone branch and is the document the
   * cone cross-check in tests/engine.test.js runs against. Not a boat, so it is
   * not in `LIBRARY`.
   */
  function coneBench(opts) {
    const o = Object.assign({ rA: 160, rB: 100, length: 500 }, opts || {});
    return D.create({
      mirror: false,
      welds: [
        { c: [0, 0, 0], n: [1, 0, 0], a: o.rA, b: o.rA, roll: 0, seam: Math.PI },
        { c: [o.length, 0, 0], n: [1, 0, 0], a: o.rB, b: o.rB, roll: 0, seam: Math.PI },
      ],
      floor: { clockAngle: 180, tabWidth: 30, wrapMaxAngle: 80 },
      locks: { uniformB: false, mirror: false, pairs: [] },
      meta: { name: 'cone bench', note: 'two coaxial circles, parallel planes' },
    });
  }

  /**
   * The OBLONG BENCH: a raft whose bridge welds are declared a = 2 b, rolled.
   *
   * This is the pre-corner raft template, kept verbatim as a numerics
   * fixture: the 2:1 rolled welds either side of ordinary port segments make
   * those segments `general` -- no closed-form branch can rescue them --
   * while the two spans stay exact mirror-pair extrusions, and the middle
   * segment joins two welds that are fore/aft reflections (the B2 node-dedup
   * regression). Every shipped template is now a pure mitred tube whose
   * segments all take closed-form branches, so this document is where the
   * general correspondence, the antipodal-root seed scan (E1.6) and the
   * dedup regression keep their coverage. A bench, not a boat: not in
   * `LIBRARY`, and its violation of the one-tube rule is the point.
   */
  function oblongBench() {
    return fromPath([
      { c: [1100, 280, 190], aspect: 2.0 },   // bow bridge, port end
      { c: [500, 380, 130] },
      { c: [-500, 380, 130] },
      { c: [-1100, 280, 190], aspect: 2.0 },  // stern bridge, port end
    ], {
      b: 155,
      floor: { clockAngle: 190, tabWidth: 120, wrapMaxAngle: 80 },
      meta: {
        name: 'oblong bench',
        note: '2:1 rolled bridge welds driving the general correspondence; '
          + 'a fixture, not a shipped boat.',
      },
    });
  }

  /** The shipped starting points, in the order a picker should show them. */
  const LIBRARY = { kit, diy7, canoe, raft, longboat };

  /**
   * `template(name)` -- a DEEP COPY every time.
   *
   * Each generator builds from scratch through `D.create`, so there is no
   * shared mutable state to leak between two boats open in one page. Returning
   * a copy is nevertheless part of the contract, because ops are
   * document-to-document and a caller is entitled to assume the thing it was
   * handed is its own.
   */
  function template(name) {
    const fn = LIBRARY[name];
    if (!fn) {
      throw new Error('templates: no template named ' + name
        + ' (have ' + names().join(', ') + ')');
    }
    return D.clone(fn());
  }

  const names = () => Object.keys(LIBRARY);

  const api = { DEG, fromPath, kit, diy7, canoe, raft, longboat, coneBench,
    oblongBench, LIBRARY, template, names };

  E.templates = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
