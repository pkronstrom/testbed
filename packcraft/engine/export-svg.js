/**
 * engine/export-svg.js -- the blueprint. One file, 1:1, every part on it.
 *
 * 1 mm = 1 SVG user unit and the root carries `width="...mm"`, so the drawing
 * is measurable on screen, prints 1:1 from any browser, and drops into a laser
 * or a plotter without a scale factor anybody has to remember.
 *
 * ---------------------------------------------------------------------------
 * THE ONE HARD GATE
 *
 * `render` REFUSES on a document whose developability checks failed. Editing
 * never blocks and export always does (engine/checks.js policy): a
 * non-developable surface has no isometric flattening, so its "pattern" is not
 * a pattern -- it is a drawing that would cost a builder a day and a boat's
 * worth of fabric to discover was a lie. Everything else the checks say
 * (§3.4 tightness, fabric-tier seam mismatch, band clamping) is ADVISORY and is
 * PRINTED ON THE SHEET rather than used to refuse, because those are things a
 * builder absorbs with their hands and needs told, not things the geometry got
 * wrong.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DRAWN -- AND THE ONE SWITCH THAT CHANGES IT
 *
 * By default EVERY panel is drawn: port, starboard AND span, eleven numbered
 * pieces a builder can lay out against the labels the editor shows them. That
 * is the safe layout, and it is the library default because a drawing that
 * needs no interpretation cannot be misinterpreted.
 *
 * `{ mirrorOnce: true }` trades some of that for paper. The hull is bilaterally
 * symmetric BY REPRESENTATION -- the document stores the port half and
 * develop2.mirrorPanel reflects it, so a starboard panel is its port source
 * with one sign flipped and congruence is exact rather than merely close
 * (checks.symmetry, gate E3.3, measures it at 0). Every `starboard` panel is
 * therefore dropped and its
 * port source is labelled for both: "L1 / R1", cut twice, the pattern FLIPPED
 * between the two cuts. Self-mirroring spans (BOW/STERN) straddle the
 * centreplane and are their own mirror, so they stay single "cut 1" parts.
 *
 * THE FLIP IS OF THE PATTERN, NOT OF THE FABRIC. The old exporter said "fold
 * the fabric coated face to coated face and cut both layers at once", which is
 * a fabric trick that goes wrong quietly: the coating is on one face, and a
 * panel flipped after cutting has it on the outside. Flipping the PAPER and
 * tracing again cannot do that -- the fabric never moves and both pieces come
 * off coating-up.
 *
 * The floor gets the same treatment, but only after it is CHECKED rather than
 * assumed: `floorSymmetry` measures the landing polygon against its own
 * reflection, and only if that residual is zero to the kernel gate is half the
 * floor emitted with a marked FLIP LINE on the centreplane. An asymmetric floor
 * -- which a manual-mode document is entitled to have -- stays whole.
 *
 * The floor is drawn with its TAB BAND: the landing polygon is the fold line,
 * and the cut line stands outboard of it by the developed band width at each
 * vertex (engine/develop2.js `tabBand` measures those; the offset here just
 * carries them onto the floor's own outline). Spec 3.7 -- the tab IS the
 * closing weld for the longitudinal seam, so it is part of the floor piece.
 *
 * Annotations, each of which decides whether a build succeeds rather than
 * merely looks right:
 *
 *   - part label from `doc.labels` (L1/R1/BOW/STERN), the SAME string the
 *     editor shows, recomputed per render and never stored;
 *   - SEAM TICKS at the four weld ends of the longitudinal seam -- the pattern's
 *     own registration marks, intrinsic to the geometry rather than bolted on,
 *     and the marks that put the landing line back where the document says;
 *   - the longitudinal seam itself and a sparse set of rulings, which are match
 *     marks a cone hands you for free;
 *   - a fore arrow: panels are not symmetric front-to-back and mis-orientation
 *     is the easy error;
 *   - floor zone registration marks at every landing joint, with the EASE that
 *     zone has to absorb;
 *   - a 100.0 mm CALIBRATION SQUARE, because print scaling is the dominant
 *     real-world error and always will be (plan, "Tolerance philosophy").
 *
 * Deliberately NOT here: seam allowance. These are butt-welded seams; the
 * outline IS the net line, and cut line and net line are the same line.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js'); require('./doc.js'); require('./develop2.js');
    require('./checks.js');
  }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const D = E.doc;
  const DV = E.develop2;
  const CK = E.checks;

  const DEFAULTS = {
    /**
     * Usable fabric roll width, mm -- the PRIMARY axis of the whole layout.
     * Fabric comes on a roll: the width is fixed and paid for whether it is
     * used or not, and only the length is bought. So every packer here treats
     * the width as a hard constraint and minimises the length.
     */
    sheetWidth: 1500,
    /**
     * Clearance between parts, mm. Butt seams carry no allowance, so this is
     * only a scissors lane and a tracing lane -- 15 mm is a comfortable one.
     * (It was 40 mm, which was a guess, and on this hull a guess worth ~5% of
     * the roll.)
     */
    gap: 15,
    /**
     * Nesting resolution across the roll, mm. The packer models each part as a
     * filled horizontal span per band, so this is the granularity at which two
     * parts can interlock. 10 mm is well below anything a builder can hold and
     * makes the search 150 bands wide on a 1500 mm roll -- microseconds.
     */
    band: 10,
    /**
     * Orientations tried for each part.
     *
     * Right angles only, and that is a FABRIC decision rather than a
     * computational one: coated ripstop has a warp and a weft, and 0/180 keep a
     * part's long axis along the roll while 90/270 put it across -- both on
     * grain. An arbitrary angle puts the panel on the bias, where the same
     * cloth stretches several times as much, and no amount of saved fabric is
     * worth a hull panel that grows under pressure. Finer sets are accepted
     * (and are cheap: the search is linear in the count) for anyone cutting
     * from a non-woven or who has decided otherwise.
     *
     * 180 is not redundant with 0 even though the bounding box is identical:
     * the packer interlocks CONTOURS, so turning a hook-shaped panel end for
     * end changes what it can nest into.
     */
    angles: [0, 90, 180, 270],
    /** 'contour' (the real packer), 'shelf' (the old one, kept for comparison). */
    packer: 'contour',
    /** Calibration square, mm. EXACTLY 100.0; see the header. */
    calibration: 100,
    /** Title block band above the sheet, mm. */
    banner: 300,
    /** Outer margin of the drawing, mm. */
    margin: 40,
    /** Date STRING supplied by the caller; this file never reads a clock. */
    now: null,
    /**
     * Draw each mirrored pair ONCE, to be cut twice with the pattern flipped.
     * OFF in the library, ON in the editor: a library that quietly halves what
     * it was asked to draw is a library that surprises somebody, while an
     * editor that hands a DIY builder twice the paper they need is an editor
     * that wastes their afternoon. The switch is the same switch either way.
     */
    mirrorOnce: false,
  };

  /**
   * How far the floor's landing polygon may sit from its own reflection and
   * still be called symmetric, mm.
   *
   * This is a MATH-tier gate, not a fabric one, and deliberately so: for a
   * mirror-symmetric document the landing polygon is symmetric BY CONSTRUCTION
   * (measured at exactly 0 on all five library templates -- the mirrored half
   * is the port half with one sign flipped), so any residual at all means the
   * document is doing something the half-pattern cannot express. 0.02 mm is the
   * engine's numerical-path gate; the observed value is zero, so the whole
   * budget is headroom.
   */
  const FLOOR_SYMMETRY_MM = 0.02;

  // Fixed precision everywhere: the output has to be byte-stable across runs
  // (two exports of one document must diff to nothing), and floating noise in
  // the twelfth decimal would break that on its own.
  const n2 = (v) => (Math.abs(v) < 5e-3 ? '0' : v.toFixed(2));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const pathOf = (pts) => 'M ' + pts.map((p) => n2(p[0]) + ' ' + n2(p[1])).join(' L ') + ' Z';
  const openPathOf = (pts) => 'M ' + pts.map((p) => n2(p[0]) + ' ' + n2(p[1])).join(' L ');

  /**
   * Sizes are in CONTENT units and the content unit is a millimetre, so every
   * `font-size` below is a PHYSICAL height on the printed sheet: a part label
   * is 40 mm tall because it has to be findable across a floor covered in
   * taped-together A4, and body text is 5 mm because that is what reads.
   */
  const STYLE = `
  text { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; fill: #111; }
  .cut { fill: #fbfaf7; stroke: #111; stroke-width: 1.2; }
  .floorcut { fill: #f4f1ea; stroke: #111; stroke-width: 1.2; }
  .sheet { fill: #ffffff; stroke: #b9b0a0; stroke-width: 2; stroke-dasharray: 24 12; }
  .fold { fill: none; stroke: #2b7bb9; stroke-width: 1.2; stroke-dasharray: 12 6; }
  /* The LANDING LINE: where the floor welds to this panel. Dash-dot, so it is
     one glance apart from the cut line it runs along and from the red seam
     ticks that cross it. */
  .landing { fill: none; stroke: #2b7bb9; stroke-width: 1.6;
             stroke-dasharray: 30 5 5 5; }
  /* Floor-to-panel ATTACHMENT MATCH MARKS. Same colour on both patterns
     because they are the same physical registration. */
  .match { fill: none; stroke: #b8791f; stroke-width: 1.8; }
  .matchlab { font-size: 9px; fill: #b8791f; font-weight: 600; }
  .zonelab { font-size: 9px; fill: #2b7bb9; font-weight: 600; }
  .ruling { fill: none; stroke: #cfc6b4; stroke-width: 0.4; }
  .tick { fill: none; stroke: #c0392b; stroke-width: 1.4; }
  /* The flip line is neither a cut nor a fold, so it looks like neither:
     heavier than the fold, red like the other "read this" marks. */
  .flip { fill: none; stroke: #c0392b; stroke-width: 2.4; stroke-dasharray: 30 10 6 10; }
  .fliplab { font-size: 12px; fill: #c0392b; font-weight: 600; }
  .reg { fill: none; stroke: #2b7bb9; stroke-width: 1.2; }
  .arrow { fill: none; stroke: #111; stroke-width: 1.6; }
  .cal { fill: none; stroke: #c0392b; stroke-width: 0.8; }
  .caltick { stroke: #c0392b; stroke-width: 0.5; }
  .frame { fill: none; stroke: #111; stroke-width: 1; }
  .id { font-size: 40px; font-weight: 600; }
  .sub { font-size: 7px; fill: #555; }
  .lab { font-size: 7px; fill: #2b7bb9; }
  .callab { font-size: 6px; fill: #c0392b; }
  .h1 { font-size: 22px; font-weight: 600; }
  .h2 { font-size: 10px; font-weight: 600; }
  .body { font-size: 7px; }
  .warn { font-size: 8px; fill: #c0392b; font-weight: 600; }
  .mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 6px; }
`;

  // ------------------------------------------------------------------
  // Geometry helpers
  // ------------------------------------------------------------------

  function bounds(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  /** Rotate a point list about the origin. Exact at the four right angles. */
  function rotatePoints(pts, deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d === 0) return pts.map((p) => [p[0], p[1]]);
    if (d === 90) return pts.map((p) => [-p[1], p[0]]);
    if (d === 180) return pts.map((p) => [-p[0], -p[1]]);
    if (d === 270) return pts.map((p) => [p[1], -p[0]]);
    const r = (d * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return pts.map((p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
  }

  /** cos/sin of the four right angles, EXACTLY -- no 6.12e-17 in the output. */
  function rotCoeffs(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d === 0) return [1, 0];
    if (d === 90) return [0, 1];
    if (d === 180) return [-1, 0];
    if (d === 270) return [0, -1];
    const r = (d * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r)];
  }

  /**
   * A part, seen the way the packer sees it: one filled horizontal SPAN per
   * band across the roll.
   *
   * This is what lets concave parts interlock. A hook-shaped tip panel's
   * bounding box is ~40% air; its span model says "in this band I occupy x
   * from 380 to 900 and nothing else", so the next part can sit in the notch
   * instead of behind the box. It is not a no-fit-polygon nester -- within a
   * band the part is treated as filled from its leftmost to its rightmost ink,
   * so a C-shape's hollow is not offered to anybody -- but it is CONSERVATIVE
   * in exactly that direction, which is why non-overlap is guaranteed by
   * construction rather than checked afterwards.
   *
   * Spans are computed EXACTLY, not sampled: x is monotone in y along a
   * straight edge, so clipping each edge to each band it crosses and taking the
   * two clipped endpoints gives the true extremes.
   *
   * `gap` is applied as a rectangular dilation -- every span grows by `gap` on
   * each side and by ceil(gap/band) bands top and bottom, carrying the
   * neighbouring extremes. That over-reserves slightly at a diagonal edge,
   * which is the honest direction to be wrong in.
   */
  function spanModel(outline, deg, band, gap) {
    const pts = rotatePoints(outline, deg);
    const b = bounds(pts);
    const nB = Math.max(1, Math.ceil(b.h / band));
    const lo = new Float64Array(nB).fill(Infinity);
    const hi = new Float64Array(nB).fill(-Infinity);
    const bandOf = (y) => {
      const k = Math.floor((y - b.y0) / band);
      return k < 0 ? 0 : (k >= nB ? nB - 1 : k);
    };
    const put = (k, x) => {
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const up = p[1] <= q[1] ? p : q, dn = p[1] <= q[1] ? q : p;
      const k0 = bandOf(up[1]), k1 = bandOf(dn[1]);
      if (k0 === k1 || dn[1] - up[1] < 1e-12) {
        put(k0, p[0]); put(k0, q[0]);
        continue;
      }
      const t = (y) => up[0] + ((dn[0] - up[0]) * (y - up[1])) / (dn[1] - up[1]);
      for (let k = k0; k <= k1; k++) {
        const ya = Math.max(up[1], b.y0 + k * band);
        const yb = Math.min(dn[1], b.y0 + (k + 1) * band);
        if (yb < ya) continue;
        put(k, t(ya)); put(k, t(yb));
      }
    }
    // Dilate by the clearance, in both axes.
    const pad = Math.ceil(gap / band);
    const n = nB + 2 * pad;
    const L = new Float64Array(n), R = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = i - pad;
      let l = Infinity, r = -Infinity;
      for (let j = k - pad; j <= k + pad; j++) {
        if (j < 0 || j >= nB) continue;
        if (lo[j] < l) l = lo[j];
        if (hi[j] > r) r = hi[j];
      }
      L[i] = l - b.x0 - gap;
      R[i] = r - b.x0 + gap;
    }
    return {
      deg, L, R, pad, nBands: nB, dilated: n,
      w: b.w, h: b.h, x0: b.x0, y0: b.y0,
      area: b.w * b.h,
    };
  }

  /**
   * THE PACKER: contour skyline, bottom-left-fill, deterministic.
   *
   * For each part, in order, every orientation is tried at every band offset
   * across the roll; the placement that leaves the part's right edge nearest
   * the bow of the roll wins, ties broken toward the low side so the result is
   * a function of the input and nothing else. NO RANDOMNESS ANYWHERE -- two
   * exports of one boat must be byte-identical, and a packer seeded off the
   * clock or off object identity would make that untestable. (If a stochastic
   * ordering is ever wanted, it must arrive as a PRNG written out in this file
   * with a fixed seed -- never the platform's dice, which X6.2 greps for.)
   *
   * The greedy is run once per candidate ORDERING -- largest area first,
   * tallest first, longest-dimension first, widest first -- and the shortest
   * roll wins. Four cheap greedies beat one clever one on this part mix, and
   * the whole search is a few milliseconds.
   *
   * The skyline is one number a band: how far along the roll that band is
   * occupied. A part fits at band offset r when, for every band it dilates
   * into, its left span clears the skyline there; the resulting x is the max
   * over those bands. That is O(bands) a candidate, O(bands^2) a part.
   */
  function contourNest(parts, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const band = o.band, gap = o.gap, W = o.sheetWidth;
    const rows = Math.max(1, Math.ceil(W / band));

    // Span models are the expensive part; build each once and reuse across
    // every candidate ordering.
    const shapes = parts.map((p) => o.angles.map((a) => spanModel(p.outline, a, band, gap)));
    const boxes = parts.map((p) => bounds(p.outline));
    const areas = parts.map((p) => Math.abs(DV.signedArea(p.outline)));

    const ORDERINGS = [
      { name: 'area', key: (i) => -areas[i] },
      { name: 'height', key: (i) => -boxes[i].h },
      { name: 'longest', key: (i) => -Math.max(boxes[i].w, boxes[i].h) },
      { name: 'width', key: (i) => -boxes[i].w },
    ];

    // Two scoring rules, because they fail on different part mixes. `right`
    // pushes each part as far toward the bow of the roll as its own contour
    // allows -- excellent at filling notches, occasionally myopic enough to
    // wall off a later big part. `left` is textbook bottom-left-fill. Neither
    // wins everywhere on these five hulls; running both costs microseconds.
    let best = null;
    for (const ord of ORDERINGS) {
      for (const score of ['right', 'left']) {
        const idx = parts.map((p, i) => i)
          .sort((a, b) => (ord.key(a) - ord.key(b)) || (a - b));   // stable, total
        const run = packOrder(idx, shapes, boxes, parts, rows, band, W, gap, score,
          o.snapX);
        const tag = ord.name + '/' + score;
        if (!best || run.usedLength < best.usedLength - 1e-9
          || (Math.abs(run.usedLength - best.usedLength) <= 1e-9 && tag < best.ordering)) {
          run.ordering = tag;
          best = run;
        }
      }
    }

    // ...and the old shelf packer is one more candidate. It is structurally
    // worse (bounding boxes, one column a part) and usually loses by a mile,
    // but on the raft -- twelve near-rectangular side panels of almost equal
    // height -- columns ARE the right answer, and a "better packer" that is
    // ever worse than the one it replaced is not better. Not offered when the
    // layout is being snapped to a page lattice: the shelf packer knows nothing
    // about the lattice and would silently break the alignment.
    if (!o.snapX) {
      const shelf = shelfNest(parts, W, gap);
      if (shelf.usedLength < best.usedLength - 1e-9) {
        best = { placed: shelf.placed, usedLength: shelf.usedLength, ordering: 'shelf' };
      }
    }

    const netArea = areas.reduce((t, a) => t + a, 0);
    const sheetArea = best.usedLength * W;
    return {
      placed: best.placed, usedLength: best.usedLength, sheetWidth: W,
      netArea, sheetArea, ordering: best.ordering,
      packer: o.snapX ? 'grid' : 'contour', snapX: o.snapX || 0,
      wastePercent: sheetArea > 0 ? 100 * (1 - netArea / sheetArea) : 0,
      anyOverWidth: best.placed.some((q) => q.overWidth),
    };
  }

  /**
   * One greedy pass in a given part order.
   *
   * `x` is where the part's own bounding-box left edge lands: the clearance is
   * already inside L and R, so the constraint `x + L[k] >= skyline[k]` reads
   * "this part's ink in band k clears everything already there by `gap`".
   */
  function packOrder(idx, shapes, boxes, parts, rows, band, W, gap, score, snapX) {
    const byLeft = score === 'left';
    // Page-lattice snapping: a part's left edge is pushed to the next multiple
    // of the printable cell width. Everything else about the pack is unchanged,
    // so parts still interlock in the roll-width direction -- only their
    // along-roll position is quantised. See tile.layoutFor for why.
    const snap = snapX > 0 ? (x) => Math.ceil(x / snapX - 1e-9) * snapX : (x) => x;
    const skyline = new Float64Array(rows);
    const placed = new Array(parts.length);
    let overflowX = 0;

    for (const i of idx) {
      let pick = null;
      for (const sh of shapes[i]) {
        if (sh.h > W) continue;              // does not fit across the roll at all
        for (let inkRow = 0; inkRow < rows; inkRow++) {
          if (inkRow * band + sh.h > W + 1e-9) break;   // and only gets worse
          const r = inkRow - sh.pad;
          let x = 0, right = -Infinity;
          for (let k = 0; k < sh.dilated; k++) {
            const row = r + k;
            if (row < 0 || row >= rows) continue;
            const need = skyline[row] - sh.L[k];
            if (need > x) x = need;
          }
          x = snap(x);
          for (let k = 0; k < sh.dilated; k++) {
            const row = r + k;
            if (row < 0 || row >= rows) continue;
            if (x + sh.R[k] > right) right = x + sh.R[k];
          }
          // Ties go to the smaller x and then to the lower band, so the answer
          // is a function of the input and of nothing else.
          const a = byLeft ? x : right, bScore = byLeft ? right : x;
          const pa = pick && (byLeft ? pick.x : pick.right);
          const pb = pick && (byLeft ? pick.right : pick.x);
          if (!pick || a < pa - 1e-9
            || (Math.abs(a - pa) <= 1e-9 && bScore < pb - 1e-9)) {
            pick = { sh, r, x, right, inkRow };
          }
        }
      }
      if (!pick) {
        // Wider than the fabric in every orientation. Reported, never silently
        // overlapped: "buy a wider roll" is a real answer.
        const b = boxes[i];
        placed[i] = {
          id: parts[i].id, label: parts[i].label, role: parts[i].role,
          angle: 0, cos: 1, sin: 0, w: b.w, h: b.h,
          x: overflowX, y: 0, dx: overflowX - b.x0, dy: -b.y0,
          overWidth: true,
        };
        overflowX += b.w + gap;
        continue;
      }
      const sh = pick.sh;
      const bx = pick.x, by = pick.inkRow * band;
      const [c, s] = rotCoeffs(sh.deg);
      placed[i] = {
        id: parts[i].id, label: parts[i].label, role: parts[i].role,
        angle: sh.deg, cos: c, sin: s, w: sh.w, h: sh.h,
        x: bx, y: by,
        // The rigid motion that puts this part's own coordinates on the roll:
        // rotate about the origin by `angle`, then translate by (dx, dy).
        dx: bx - sh.x0, dy: by - sh.y0,
        overWidth: false,
      };
      for (let k = 0; k < sh.dilated; k++) {
        const row = pick.r + k;
        if (row < 0 || row >= rows) continue;
        const e = bx + sh.R[k];
        if (e > skyline[row]) skyline[row] = e;
      }
    }

    // Slide the whole layout up against the start of the roll. The first part
    // is placed one clearance in (its own dilation cleared an empty skyline),
    // and that clearance is a free ~15 mm of fabric nobody should buy.
    let minX = Infinity;
    for (const q of placed) if (q && !q.overWidth && q.x < minX) minX = q.x;
    if (isFinite(minX) && minX > 0) {
      for (const q of placed) if (q && !q.overWidth) { q.x -= minX; q.dx -= minX; }
    }
    const usedLength = placed.reduce((m, q) => Math.max(m, q.x + q.w), 0);
    return { placed, usedLength };
  }

  /**
   * PAGE-GRID NESTING: the same packer, snapped to the printable cell lattice.
   *
   * For a home printer the unit of cost is the PAGE. A part overhanging its
   * page by 5 mm costs a whole sheet of paper, a whole taping seam and a whole
   * chance to misalign, and the fabric-optimal nest knows nothing about paper:
   * it will happily leave a 5 mm tail across a page boundary a dozen times down
   * a 9 m roll.
   *
   * The first attempt here reserved whole CELLS per part, exclusively. It was
   * far worse and the measurement said so immediately -- on this hull a panel
   * is five to seven A4 cells across, so rounding both axes up and forbidding
   * any interlocking cost more length (and therefore more page COLUMNS) than
   * the alignment ever saved: 280 A4 sheets against 138.
   *
   * What survives is the surgical version: the contour packer, unchanged, with
   * each part's along-roll position pushed up to the next cell boundary. Parts
   * still interlock across the roll; only their x is quantised, so the cost is
   * bounded by one cell width a placement while the saving is a whole column of
   * sheets whenever a part would otherwise have poked over the edge.
   *
   * Whether that trade pays is NOT assumed -- engine/tile.js builds both and
   * counts the sheets.
   */
  function gridNest(parts, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!(o.cellW > 0)) throw new Error('gridNest: needs a cellW (printable cell width)');
    return contourNest(parts, Object.assign({}, o, { snapX: o.cellW }));
  }

  /** Pick a packer by name. `contour` unless somebody says otherwise. */
  function nest(parts, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (o.packer === 'shelf') {
      const r = shelfNest(parts, o.sheetWidth, o.gap);
      r.packer = 'shelf';
      return r;
    }
    if (o.packer === 'grid') return gridNest(parts, o);
    return contourNest(parts, o);
  }

  /**
   * Shelf nesting: parts tall-first, packed into columns across the sheet
   * width, first-fit across every open column rather than only the last.
   *
   * SUPERSEDED by `contourNest` and kept because a claim that the new packer is
   * better is worth nothing without the old one to measure against
   * (tests/engine-export.test.js X6.1 runs both on every template). Its
   * weakness is structural rather than tuning: it packs BOUNDING BOXES, and on
   * this hull the tip panels' boxes are ~40% air, so no ordering rescues it.
   */
  function shelfNest(parts, sheetWidth, gap) {
    const g = gap == null ? DEFAULTS.gap : gap;
    const order = parts.map((p) => ({ p, b: bounds(p.outline) }))
      .sort((a, b) => b.b.h - a.b.h || b.b.w - a.b.w);
    const columns = [];   // {x, width, used}
    const placed = [];
    let cursorX = 0;

    for (const item of order) {
      const { w, h } = item.b;
      let col = null;
      if (h <= sheetWidth) {
        for (const c of columns) {
          if (c.used + h + g <= sheetWidth && w <= c.width) { col = c; break; }
        }
      }
      if (!col) {
        col = { x: cursorX, width: w, used: 0 };
        columns.push(col);
        cursorX += w + g;
      }
      placed.push({
        id: item.p.id, label: item.p.label, role: item.p.role,
        // The shelf packer never turns a part; it says so explicitly, because
        // it is one of the candidates the contour search chooses between and
        // everything downstream reads a rigid motion, not a translation.
        angle: 0, cos: 1, sin: 0,
        w, h, x: col.x, y: col.used,
        // The translation that puts this part's own coordinates into sheet
        // coordinates. Panels develop around an arbitrary origin, so every one
        // of them needs one.
        dx: col.x - item.b.x0, dy: col.used - item.b.y0,
        // Reported, never silently overlapped: a part taller than the fabric is
        // a real answer ("buy a wider roll"), not a layout bug to hide.
        overWidth: h > sheetWidth,
      });
      col.used += h + g;
      if (w > col.width) col.width = w;
    }
    const usedLength = placed.reduce((m, q) => Math.max(m, q.x + q.w), 0);
    const netArea = parts.reduce((t, p) => t + Math.abs(DV.signedArea(p.outline)), 0);
    const sheetArea = usedLength * sheetWidth;
    return {
      placed, usedLength, sheetWidth, netArea, sheetArea,
      wastePercent: sheetArea > 0 ? 100 * (1 - netArea / sheetArea) : 0,
      anyOverWidth: placed.some((q) => q.overWidth),
    };
  }

  /**
   * The floor as a cuttable part: the landing polygon grown outboard by the
   * developed tab width at each vertex.
   *
   * The band itself is developed in the TUBE panel's frame (it is a strip of
   * tube surface -- engine/develop2.js `tabBand`), so it cannot simply be
   * pasted onto the floor drawing. What carries across is its WIDTH, which is
   * an arc length and therefore frame-independent, and that is what is offset
   * here. Each vertex takes the wider of the two bands meeting there, so the
   * tab never runs short at a joint.
   *
   * Mitre, not round: at a landing corner the offset vertex sits on the
   * bisector at `w / cos(half-angle)`, clamped at 3x so a near-cusp corner
   * (the tips, where the landing zones converge on the centreplane) grows a
   * blunt corner instead of a 2 m spike.
   */
  function floorPart(floor, opts) {
    const o = opts || {};
    const pts = floor.outline;
    const n = pts.length;
    const bandW = (band, end) => {
      const i = end === 'start' ? 0 : band.inner.length - 1;
      return Math.hypot(band.outer[i][0] - band.inner[i][0],
        band.outer[i][1] - band.inner[i][1]);
    };
    // Vertex i is where panel i starts and panel i-1 ends.
    const rawWidth = (i) => Math.max(
      bandW(floor.bands[i], 'start'),
      bandW(floor.bands[(i - 1 + n) % n], 'end'));

    const sym = floorSymmetry(pts);
    const half = !!o.mirrorOnce && sym.symmetric;

    /**
     * Tab widths, symmetrised when a half pattern is going to be cut from them.
     *
     * The LANDING polygon is symmetric to exactly zero, but the band widths
     * either side of the centreplane are not quite: they come out of a Newton
     * solve run in each panel's own developed frame, and a mirrored panel
     * inherits its source's frame, so the two answers differ by ~0.02 mm --
     * five hundred times below the fabric floor, and still enough to make a
     * half pattern that does not exactly reflect onto its other half. Taking
     * the wider of each mirror pair makes the grown outline symmetric BY
     * CONSTRUCTION (so the clip below lands on the axis) and can only ever add
     * tab, never take it away.
     */
    const widthAt = half
      ? (i) => Math.max(rawWidth(i), rawWidth(sym.partner[i]))
      : rawWidth;

    const s = DV.signedArea(pts) > 0 ? 1 : -1;
    const edgeNormal = (i) => {
      const p = pts[i], qq = pts[(i + 1) % n];
      const dx = qq[0] - p[0], dy = qq[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      return [(s * dy) / l, (-s * dx) / l];
    };

    const grown = [];
    for (let i = 0; i < n; i++) {
      const a = edgeNormal((i - 1 + n) % n), b = edgeNormal(i);
      let mx = a[0] + b[0], my = a[1] + b[1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) { mx = b[0]; my = b[1]; } else { mx /= ml; my /= ml; }
      const cos = Math.max(0.34, mx * b[0] + my * b[1]);   // clamp: 3x mitre
      const w = widthAt(i) / cos;
      grown.push([pts[i][0] + mx * w, pts[i][1] + my * w]);
    }
    const part = {
      id: floor.id, label: 'FLOOR', role: 'floor', qty: 1,
      outline: grown, landing: pts, floor,
      // The UNCLIPPED pair, kept whether or not a half is emitted: the
      // attachment marks are indexed by landing ZONE, and clipping renumbers
      // the vertices. Marks are computed on these and then filtered to the
      // drawn side, so a half pattern's marks are the same marks.
      landingFull: pts, grownFull: grown,
      tabWidths: pts.map((p, i) => widthAt(i)),
      half: false, flipLine: null,
      symmetric: sym.symmetric, symmetryResidual: sym.residual,
    };
    if (!half) return part;

    // Half the floor, cut line and fold line alike, clipped on the centreplane.
    // Both polygons are symmetric about y = 0, so the clip lands exactly on the
    // axis and the resulting edge IS the flip line.
    part.outline = clipHalfY(grown);
    part.landing = clipHalfY(pts);
    part.half = true;
    part.flipLine = axisEdge(part.outline);
    part.label = 'FLOOR';
    return part;
  }

  /**
   * Is the floor's landing polygon its own reflection in y = 0?
   *
   * VERIFIED, never assumed. For a `mirror: true` document it is symmetric by
   * construction, but the document is not the only thing that can produce a
   * floor: manual mode may set anything, `mirror` may be false, and a future
   * asymmetric representation would arrive here silently. Emitting half a
   * pattern for a boat whose other half is different is precisely the failure
   * this whole engine exists to make impossible, so it is measured.
   *
   * The measurement is a best cyclic alignment: the polygon reflected in y = 0
   * and traversed backwards must coincide with the original under SOME rotation
   * of the vertex list, because reflection reverses orientation and the vertex
   * numbering has no canonical start. The winning rotation also gives each
   * vertex its mirror partner, which the tab-width symmetrisation above needs.
   */
  function floorSymmetry(pts, tol) {
    const n = pts.length;
    const limit = tol == null ? FLOOR_SYMMETRY_MM : tol;
    const R = pts.map((p) => [p[0], -p[1]]).reverse();
    let best = Infinity, bestK = 0;
    for (let k = 0; k < n; k++) {
      let worst = 0;
      for (let i = 0; i < n && worst <= best; i++) {
        const a = pts[i], b = R[(i + k) % n];
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
      if (worst < best) { best = worst; bestK = k; }
    }
    // R[j] is the reflection of pts[n-1-j], so vertex i pairs with n-1-((i+k)%n).
    const partner = [];
    for (let i = 0; i < n; i++) partner.push((n - 1 - ((i + bestK) % n) + n) % n);
    return { symmetric: best <= limit, residual: best, rotation: bestK, partner };
  }

  /**
   * Sutherland-Hodgman clip to the half-plane y >= 0, with consecutive
   * duplicates dropped.
   *
   * The dedup is not cosmetic: a vertex sitting exactly ON the axis (a pointed
   * tip, which is where the landing zones converge) is both "inside" and "the
   * intersection of the edge leaving it", so the naive algorithm emits it
   * twice and the flip-line search below then finds a zero-length edge.
   */
  function clipHalfY(pts) {
    const out = [];
    const n = pts.length;
    const push = (p) => {
      const last = out[out.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-9) out.push(p);
    };
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ain = a[1] >= 0, bin = b[1] >= 0;
      if (ain) push([a[0], a[1]]);
      if (ain !== bin) {
        const t = a[1] / (a[1] - b[1]);
        push([a[0] + (b[0] - a[0]) * t, 0]);
      }
    }
    if (out.length > 1) {
      const f = out[0], l = out[out.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) out.pop();
    }
    return out;
  }

  /** The longest edge of a clipped polygon lying on y = 0: the flip line. */
  function axisEdge(pts) {
    let best = null, len = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.abs(a[1]) > 1e-6 || Math.abs(b[1]) > 1e-6) continue;
      const l = Math.abs(b[0] - a[0]);
      if (l > len) { len = l; best = [a, b]; }
    }
    return best;
  }

  /**
   * Zones longer than this get interior match marks, mm of 3D landing edge;
   * longer than the second, thirds instead of a midpoint.
   *
   * A metre of unmarked fabric edge is a metre over which the tube can creep
   * against the floor, and the creep is not recoverable once welded. 600 mm is
   * about the longest run a builder can hold true by eye against a straight
   * chord, and it is far above the fabric floor, so this is a WORKSHOP number
   * rather than a tolerance -- there is nothing to tighten it to.
   */
  const ZONE_LONG_MM = 600;
  const ZONE_VERY_LONG_MM = 1200;

  function zoneFractions(len) {
    if (len > ZONE_VERY_LONG_MM) return [1 / 3, 2 / 3];
    if (len > ZONE_LONG_MM) return [0.5];
    return [];
  }

  /**
   * THE FLOOR-TO-PANEL CORRESPONDENCE, in one place, for both patterns.
   *
   * BY CONSTRUCTION, NOT BY CALCULATION. Landing zone i and tube panel i are
   * the same curve seen twice: engine/develop2.js `buildFloor` walks the panels
   * in order and takes each one's `seamCurve3D` as that zone's landing, so
   * `zones[i].segmentId === panels[i].id` and the zone's two boundaries ARE the
   * panel's two seam points -- the very points `checks.matedEdges` asserts are
   * bit-identical between neighbouring panels ('mated.identity', measured at 0,
   * not at a tolerance). So the floor's marks and the panel's marks are not two
   * computations that have to agree; they are one computation rendered twice.
   *
   * Interior marks are placed by FRACTION OF ARC, not by absolute distance: the
   * floor edge is a straight chord of `lengthFlat` and the panel edge is a
   * curve of `length3D`, and the difference between them is the ease the
   * builder distributes along that zone. Marking both at the same fraction is
   * precisely the instruction "spread the surplus evenly between these marks".
   */
  function landingZones(built, labelOf) {
    const zones = built.floor.zones;
    const n = zones.length;
    return zones.map((z, i) => {
      const label = labelOf(z.segmentId);
      const prevLabel = labelOf(zones[(i - 1 + n) % n].segmentId);
      const nextLabel = labelOf(zones[(i + 1) % n].segmentId);
      return {
        index: i, id: z.id, segmentId: z.segmentId,
        label, prevLabel, nextLabel,
        // The boundary a zone STARTS at is shared with the zone before it, and
        // the mark names both -- that is the whole point of it.
        startLabel: prevLabel + '|' + label,
        endLabel: label + '|' + nextLabel,
        ease: z.ease, length3D: z.length3D, lengthFlat: z.lengthFlat,
        triangular: z.triangular,
        fractions: zoneFractions(z.length3D),
      };
    });
  }

  /** The point at fraction `f` of a polyline's own arc length. */
  function polyFraction(pts, f) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    const want = total * f;
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (run + d >= want || i === pts.length - 1) {
        const t = d < 1e-12 ? 0 : (want - run) / d;
        return {
          at: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
            pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t],
          along: [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], 0],
          arc: want, total,
        };
      }
      run += d;
    }
    return { at: pts[pts.length - 1].slice(), along: [1, 0, 0], arc: total, total };
  }

  /** Bow-to-stern extents of the built hull, from the 3D ruling mesh. */
  function extents(built) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity,
      z0 = Infinity, z1 = -Infinity;
    for (const p of built.panels) {
      for (const arr of [p.startEdge3D, p.endEdge3D]) {
        for (const q of arr) {
          if (q[0] < x0) x0 = q[0];
          if (q[0] > x1) x1 = q[0];
          if (q[1] < y0) y0 = q[1];
          if (q[1] > y1) y1 = q[1];
          if (q[2] < z0) z0 = q[2];
          if (q[2] > z1) z1 = q[2];
        }
      }
    }
    return { loa: x1 - x0, beam: y1 - y0, depth: z1 - z0 };
  }

  // ------------------------------------------------------------------
  // The gate
  // ------------------------------------------------------------------

  /**
   * The ONE hard refusal. Throws with the blocker list attached; everything
   * else the report says rides along on the sheet as advice.
   *
   * `opts.report` lets a caller that already ran the checks (the editor runs
   * them on every release) hand them in rather than pay for a second pass.
   */
  function gate(built, opts) {
    const o = opts || {};
    const rep = o.report || CK.report(built, { refine: false });
    if (!rep.exportAllowed) {
      const names = rep.blockers.map((b) => b.id + (b.where && b.where.panel
        ? ' @ ' + b.where.panel : '')).join(', ');
      const err = new Error('export refused: ' + rep.blockers.length
        + ' developability gate(s) failed -- the panels would not be an isometry '
        + 'of this boat (' + names + ')');
      err.blockers = rep.blockers;
      err.report = rep;
      throw err;
    }
    return rep;
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  /**
   * Fore/aft arrow, drawn in the PART's own frame and mapped onto the roll.
   *
   * Panels are not symmetric front to back, and the packer is now free to turn
   * one through a right angle to make it nest -- so an arrow drawn along the
   * sheet's x-axis would confidently point at the stern. It goes through the
   * same mapper as the outline, so it turns with the part. The word stays
   * upright: it is for reading, not for pointing.
   */
  function foreArrow(m, x, y, len) {
    const h = 12;
    const a = m([x, y]), b = m([x + len, y]);
    const t1 = m([x + len - h * 1.6, y - h]), t2 = m([x + len - h * 1.6, y + h]);
    const lab = m([x, y - 16]);
    return '<g class="arrow"><path d="M ' + n2(a[0]) + ' ' + n2(a[1]) + ' L '
      + n2(b[0]) + ' ' + n2(b[1]) + '"/><path d="M ' + n2(t1[0]) + ' ' + n2(t1[1])
      + ' L ' + n2(b[0]) + ' ' + n2(b[1]) + ' L ' + n2(t2[0]) + ' ' + n2(t2[1])
      + '"/></g>'
      + '<text class="sub" x="' + n2(lab[0]) + '" y="' + n2(lab[1]) + '">FORE</text>';
  }

  const crosshair = (p, cls, r) =>
    '<g class="' + cls + '"><circle cx="' + n2(p[0]) + '" cy="' + n2(p[1]) + '" r="'
    + n2(r) + '"/><path d="M ' + n2(p[0] - r * 1.8) + ' ' + n2(p[1]) + ' L '
    + n2(p[0] + r * 1.8) + ' ' + n2(p[1]) + ' M ' + n2(p[0]) + ' '
    + n2(p[1] - r * 1.8) + ' L ' + n2(p[0]) + ' ' + n2(p[1] + r * 1.8) + '"/></g>';

  /**
   * A seam tick: a short bar ACROSS the seam where it meets a weld.
   *
   * These are the pattern's registration marks and they are intrinsic -- the
   * seam meets each weld at a point the DOCUMENT owns (`weld.seam`, a geometric
   * clock angle), and both panels sharing that weld put their tick on the same
   * 3D point. Line the ticks up and the landing line is where the design says
   * it is; the alternative is trusting a scissors cut at a corner.
   */
  function seamTick(at, along, len, cls) {
    const l = Math.hypot(along[0], along[1]) || 1;
    const ux = along[0] / l, uy = along[1] / l;
    const h = (len || 20) / 2;
    return '<path class="' + (cls || 'tick') + '" d="M ' + n2(at[0] - uy * h) + ' '
      + n2(at[1] + ux * h) + ' L ' + n2(at[0] + uy * h) + ' ' + n2(at[1] - ux * h)
      + '"/>';
  }

  /** A direction in the part's own frame, turned into the roll's frame. */
  function rotAlong(along, q) {
    const c = q && q.cos != null ? q.cos : 1, s = q && q.sin != null ? q.sin : 0;
    return [along[0] * c - along[1] * s, along[0] * s + along[1] * c, 0];
  }

  /** The four weld ends of a panel's longitudinal seam, with their directions. */
  function seamEnds(panel) {
    const S = panel.seamCurve.length - 1;
    const R = panel.edgeA.length - 1;
    const far = panel.seamCurveFar;
    const out = [
      { at: panel.edgeA[0], along: V.sub([panel.seamCurve[1][0], panel.seamCurve[1][1], 0],
        [panel.seamCurve[0][0], panel.seamCurve[0][1], 0]), weld: panel.weldA },
      { at: panel.edgeB[0], along: V.sub([panel.seamCurve[S][0], panel.seamCurve[S][1], 0],
        [panel.seamCurve[S - 1][0], panel.seamCurve[S - 1][1], 0]), weld: panel.weldB },
    ];
    if (far && far.length === S + 1) {
      out.push({ at: panel.edgeA[R], along: V.sub([far[1][0], far[1][1], 0],
        [far[0][0], far[0][1], 0]), weld: panel.weldA });
      out.push({ at: panel.edgeB[R], along: V.sub([far[S][0], far[S][1], 0],
        [far[S - 1][0], far[S - 1][1], 0]), weld: panel.weldB });
    }
    return out;
  }

  /** One nested tube panel, with everything a builder needs printed on it. */
  function renderPanel(rec, q, m) {
    const panel = rec.panel;
    const g = [];
    const cx = q.x + q.w / 2, cy = q.y + q.h / 2;
    g.push('<path class="cut" d="' + pathOf(panel.outline.map(m)) + '"/>');
    for (const r of panel.rulings) {
      const a = m(r[0]), b = m(r[1]);
      g.push('<path class="ruling" d="M ' + n2(a[0]) + ' ' + n2(a[1]) + ' L '
        + n2(b[0]) + ' ' + n2(b[1]) + '"/>');
    }
    // THE LANDING LINE: both developed copies of it. The panel is opened along
    // the seam, so the line where the floor welds on is the panel's two short
    // edges -- dash-dot over the cut line, which is what says "this edge is not
    // just a cut, it lands on the floor".
    g.push('<path class="landing" d="' + openPathOf(panel.seamCurve.map(m)) + '"/>');
    if (panel.seamCurveFar) {
      g.push('<path class="landing" d="' + openPathOf(panel.seamCurveFar.map(m)) + '"/>');
    }
    const ends = seamEnds(panel);
    for (const e of ends) {
      // `along` is a direction in the PART's frame and the tick is built
      // perpendicular to it IN THE ROLL's frame, so it has to be turned with
      // the part -- otherwise every tick on a part the packer rotated points
      // the wrong way. (It did, from the day rotation landed until now.)
      g.push(seamTick(m(e.at), rotAlong(e.along, q), 24));
    }
    // Corner-to-corner registration: the two ends of the landing line are
    // exactly the floor's zone-boundary marks, so they carry the same names.
    const zone = rec.zone;
    if (zone) {
      const nameAt = (i) => (i === 0 || i === 2 ? zone.startLabel : zone.endLabel);
      for (let i = 0; i < ends.length; i++) {
        const p = m(ends[i].at);
        g.push('<text class="matchlab" x="' + n2(p[0]) + '" y="' + n2(p[1] - 16)
          + '" text-anchor="middle">' + esc(nameAt(i)) + '</text>');
      }
      // Interior match marks, at the SAME arc fractions as the floor's, on both
      // copies of the landing edge.
      for (const f of zone.fractions) {
        for (const curve of [panel.seamCurve, panel.seamCurveFar]) {
          if (!curve) continue;
          const s0 = polyFraction(curve, f);
          g.push(seamTick(m(s0.at), rotAlong(s0.along, q), 34, 'match'));
        }
      }
    }
    g.push('<text class="id" x="' + n2(cx) + '" y="' + n2(cy) + '" text-anchor="middle">'
      + esc(rec.label) + '</text>');
    // The sheet keeps the SHORT form; the long instruction lives once in the
    // title block's cutting list rather than eleven times across the fabric.
    g.push('<text class="sub" x="' + n2(cx) + '" y="' + n2(cy + 16) + '" text-anchor="middle">'
      + esc(positionLabel(rec.label)) + ' · ' + esc(panel.id) + ' · '
      + esc(rec.cutNote || 'cut 1') + ' · ' + n2(q.w) + ' × ' + n2(q.h) + ' mm</text>');
    g.push('<text class="sub" x="' + n2(cx) + '" y="' + n2(cy + 28) + '" text-anchor="middle">'
      + 'welds ' + panel.weldA + '→' + panel.weldB + ' · seam ' + n2(panel.seamLengthDev)
      + ' mm · red ticks = weld ends of the seam'
      + (q.angle ? ' · turned ' + q.angle + '° to nest' : '') + '</text>');
    const lb = bounds(panel.outline);
    g.push(foreArrow(m, lb.x0 + lb.w * 0.34, lb.y0 + lb.h * 0.5 + 54, lb.w * 0.32));
    return g.join('\n');
  }

  /** The floor, its tab band, and the landing zones the tube welds into. */
  function renderFloor(rec, q, m) {
    const part = rec.part;
    const zones = rec.zones || [];
    const floor = part.floor;
    const half = part.half;
    const g = [];
    const cx = q.x + q.w / 2, cy = q.y + q.h / 2;
    g.push('<path class="floorcut" d="' + pathOf(part.outline.map(m)) + '"/>');
    // The landing line: a MARKED line, not a cut edge -- and the tab's fold.
    g.push('<path class="fold" d="' + (half
      ? openPathOf(part.landing.map(m)) : pathOf(part.landing.map(m))) + '"/>');
    for (let i = 0; i < floor.zones.length; i++) {
      const z = floor.zones[i];
      // On a half pattern only the zones on the drawn side are marked; the
      // others land on the traced reflection and marking them here would put
      // two crosshairs on the same physical point.
      if (half && (z.from[1] < -1e-6 || z.to[1] < -1e-6)) continue;
      const a = m(z.from), b = m(z.to);
      g.push(crosshair(a, 'reg', 10));
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const zn = zones[i] || null;
      // The zone says which PANEL welds here and how much surplus tube edge has
      // to be worked in along it -- the two things a builder needs at the
      // moment they are pinning this stretch.
      g.push('<text class="zonelab" x="' + n2(mid[0]) + '" y="' + n2(mid[1])
        + '" text-anchor="middle">' + esc(zn ? zn.label : z.segmentId) + ' · ease '
        + z.ease.toFixed(1) + ' mm</text>');
      g.push('<text class="lab" x="' + n2(mid[0]) + '" y="' + n2(mid[1] + 11)
        + '" text-anchor="middle">' + esc(z.id) + ' · ' + n2(z.lengthFlat)
        + ' mm flat ← ' + n2(z.length3D) + ' mm of tube edge</text>');
    }
    // --- FLOOR-TO-PANEL ATTACHMENT MATCH MARKS ---
    // Drawn from the UNCLIPPED landing polygon, then filtered to the drawn
    // side, so a half pattern carries exactly the marks a whole one would --
    // and by symmetry the flip-traced half lands its marks on the mirrored
    // zones (asserted in tests/engine-export.test.js X7.3).
    const LF = part.landingFull || part.landing;
    const GF = part.grownFull || part.outline;
    const nz = LF.length;
    const drawn = (p) => !half || p[1] >= -1e-6;
    const markAt = (inner, outer, label) => {
      const dx = outer[0] - inner[0], dy = outer[1] - inner[1];
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l;
      const a = m([inner[0] - ux * 10, inner[1] - uy * 10]);
      const b = m([outer[0] + ux * 10, outer[1] + uy * 10]);
      g.push('<path class="match" d="M ' + n2(a[0]) + ' ' + n2(a[1]) + ' L '
        + n2(b[0]) + ' ' + n2(b[1]) + '"/>');
      if (label) {
        g.push('<text class="matchlab" x="' + n2(b[0]) + '" y="' + n2(b[1] - 6)
          + '" text-anchor="middle">' + esc(label) + '</text>');
      }
    };
    for (let i = 0; i < nz && zones.length === nz; i++) {
      const zone = zones[i];
      // The boundary this zone starts at, named for BOTH panels that meet on it.
      if (drawn(LF[i])) markAt(LF[i], GF[i], zone.startLabel);
      // ...and the interior marks that stop a long run creeping.
      for (const f of zone.fractions) {
        const j = (i + 1) % nz;
        const inner = [LF[i][0] + (LF[j][0] - LF[i][0]) * f,
          LF[i][1] + (LF[j][1] - LF[i][1]) * f];
        const outer = [GF[i][0] + (GF[j][0] - GF[i][0]) * f,
          GF[i][1] + (GF[j][1] - GF[i][1]) * f];
        if (drawn(inner)) markAt(inner, outer, '');
      }
    }

    if (half && part.flipLine) {
      // THE FLIP LINE. Not a cut edge and not a fold: the pattern is traced,
      // turned over about this line, and traced again, so the floor comes out
      // of one piece of fabric in one outline.
      const a = m(part.flipLine[0]), b = m(part.flipLine[1]);
      g.push('<path class="flip" d="M ' + n2(a[0]) + ' ' + n2(a[1]) + ' L '
        + n2(b[0]) + ' ' + n2(b[1]) + '"/>');
      g.push('<text class="fliplab" x="' + n2((a[0] + b[0]) / 2) + '" y="'
        + n2((a[1] + b[1]) / 2 - 8) + '" text-anchor="middle">'
        + 'FLIP LINE — trace, flip the pattern about this line, trace again</text>');
    }
    g.push('<text class="id" x="' + n2(cx) + '" y="' + n2(cy) + '" text-anchor="middle">FLOOR'
      + (half ? ' ½' : '') + '</text>');
    g.push('<text class="sub" x="' + n2(cx) + '" y="' + n2(cy + 16) + '" text-anchor="middle">'
      + (half
        ? 'cut 1 from a HALF pattern · ' + n2(q.w) + ' × ' + n2(q.h)
          + ' mm drawn · the landing line is mirror-symmetric to '
          + part.symmetryResidual.toFixed(3) + ' mm, so half of it is all of it'
        : 'cut 1 · ' + n2(q.w) + ' × ' + n2(q.h) + ' mm incl. tab · dashed blue = '
          + 'landing line, fold the tab up onto the tube')
      + '</text>');
    g.push('<text class="sub" x="' + n2(cx) + '" y="' + n2(cy + 28) + '" text-anchor="middle">'
      + 'ease is surplus TUBE edge, gathered inside its own zone — the midbody needs none'
      + (q.angle ? ' · turned ' + q.angle + '° to nest' : '') + '</text>');
    const lb = bounds(part.outline);
    g.push(foreArrow(m, lb.x0 + lb.w * 0.36, lb.y0 + lb.h * 0.5 + 54, lb.w * 0.28));
    return g.join('\n');
  }

  /** "Left 1, fore to aft" alongside the L1/R1 scheme. */
  function positionLabel(label) {
    if (label === 'BOW') return 'Bow, spans the centreline';
    if (label === 'STERN') return 'Stern, spans the centreline';
    if (label === 'FLOOR') return 'Floor, one piece';
    const pair = /^([LR]\d+) \/ ([LR]\d+)$/.exec(label);
    if (pair) return 'Left and right ' + pair[1].slice(1) + ', fore to aft';
    if (/^[LR]\d+$/.test(label)) {
      return (label[0] === 'L' ? 'Left ' : 'Right ') + label.slice(1) + ', fore to aft';
    }
    return label;
  }

  /**
   * The 100.0 mm calibration square.
   *
   * EXACTLY 100, written as the literal, with a 10 mm ruler along the bottom.
   * Print scaling is the dominant real-world error in this whole pipeline and
   * always will be -- ±0.1-0.5% on a home printer, and "Fit to Page" silently
   * on by default in most drivers. A builder who measures this square before
   * cutting has spent ten seconds; one who does not can lose a boat's fabric.
   */
  function calibrationSquare(x, y, size) {
    const c = size == null ? DEFAULTS.calibration : size;
    const g = ['<g id="calibration">'];
    g.push('<rect class="cal" x="' + n2(x) + '" y="' + n2(y) + '" width="' + n2(c)
      + '" height="' + n2(c) + '"/>');
    for (let i = 0; i <= c; i += 10) {
      const h = i % 50 === 0 ? 10 : 5;
      g.push('<path class="caltick" d="M ' + n2(x + i) + ' ' + n2(y + c) + ' L '
        + n2(x + i) + ' ' + n2(y + c - h) + '"/>');
    }
    // Clear of the 10 mm ruler ticks, which stand up to 10 mm off the lower edge.
    g.push('<text class="callab" x="' + n2(x + 3) + '" y="' + n2(y + c - 14) + '">'
      + c.toFixed(1) + ' mm — measure me</text>');
    g.push('<text class="callab" x="' + n2(x) + '" y="' + n2(y + c + 10) + '">'
      + 'If this is not ' + c.toFixed(0) + ' mm the print is scaled. Do not cut.</text>');
    g.push('</g>');
    return g.join('\n');
  }

  /**
   * The title block. Says what boat this is, how big it is, what it will take
   * to cut, and what the checks think of it.
   *
   * `now` is a STRING the caller passes. Nothing in this file reads the clock:
   * a library that does produces a different file every second, which makes
   * byte-stability untestable and every diff of two exports pure noise. The
   * editor passes today's date, the tests pass a fixed string, and the default
   * is a blank for a pen. Asserted mechanically in tests/engine-export.test.js
   * X2.4, which greps this source.
   */
  function titleLines(built, layout, rep, opts, parts) {
    const o = opts || {};
    const ext = extents(built);
    const doc = built.doc;
    const set = parts || [];
    const flipped = set.filter((p) => p.qty === 2);
    const lines = [];
    const L = (cls, text) => lines.push({ cls, text });
    const gap = () => lines.push({ cls: 'gap', text: '' });

    L('h1', 'Packraft cutting pattern — 1:1');
    L('warn', 'Print at 100% / Actual Size. Turn OFF "Fit to Page". '
      + 'Then measure the 100 mm square.');
    gap();
    L('h2', doc.meta.name);
    L('body', 'LOA ' + ext.loa.toFixed(0) + ' × beam ' + ext.beam.toFixed(0)
      + ' × depth ' + ext.depth.toFixed(0) + ' mm · displacement '
      + (built.volume / 1e6).toFixed(1) + ' L');
    L('body', doc.welds.length + ' stored welds → ' + built.ring.welds.length
      + ' derived · ' + built.panels.length + ' tube panels + 1 floor = '
      + (built.panels.length + 1) + ' parts'
      + (o.mirrorOnce
        ? ', drawn as ' + set.length + ' patterns (mirrored pairs drawn once)'
        : ''));
    L('body', 'Fabric ' + (layout.usedLength / 1000).toFixed(2) + ' m of '
      + layout.sheetWidth + ' mm · net area ' + (layout.netArea / 1e6).toFixed(2)
      + ' m² · waste ' + layout.wastePercent.toFixed(1) + '%'
      + (layout.anyOverWidth ? ' · A PART IS WIDER THAN THE SHEET' : ''));
    L('body', 'Floor landing ' + built.floor.perimeter3D.toFixed(0)
      + ' mm tube onto ' + built.floor.perimeterFlat.toFixed(0) + ' mm flat = '
      + built.floor.totalEase.toFixed(0) + ' mm ease · tab '
      + built.floor.tabWidth.toFixed(0) + ' mm'
      + (built.floor.anyBandClamped ? ' (CLAMPED at the wrap limit)' : ''));
    L('body', 'Date ' + (o.now == null ? '____-__-__' : o.now)
      + '   ·   Built by  ______________________');
    gap();

    L('h2', 'Before you cut');
    L('body', 'Butt-welded seams carry ZERO allowance: the outline IS the net line. Cut to the line.');
    if (o.mirrorOnce) {
      L('body', 'Mirrored pairs are drawn ONCE. Trace the pattern, cut, then TURN THE PATTERN OVER '
        + 'and trace');
      L('body', 'again for the other side. Flip the PAPER, never a cut panel: the fabric is coated '
        + 'on one face,');
      L('body', 'and a flipped panel puts the coating on the outside. Both pieces come off '
        + 'coating-up this way.');
    } else {
      L('body', 'Every part is drawn — port, starboard and the centreline spans. Nothing is folded '
        + 'or flipped:');
      L('body', 'the fabric is coated on one face, and a flipped panel puts the coating on the outside.');
    }
    L('body', 'Red ticks are the weld ends of the longitudinal seam. They line up between neighbours.');
    gap();

    // The cutting list. Only in mirrorOnce mode: in the full layout every part
    // is "cut 1" and a list saying so eleven times is noise.
    if (o.mirrorOnce) {
      L('h2', 'Cutting list — ' + set.length + ' patterns → '
        + set.reduce((t, p) => t + p.qty, 0) + ' pieces');
      for (const p of set) {
        // No column padding: SVG text collapses runs of spaces, so a padEnd
        // here lines nothing up and only looks aligned in the source.
        L('mono', p.label + ' · '
          + (p.qty === 2 ? 'cut 2 — trace, FLIP THE PATTERN, trace again'
            : (p.half ? 'cut 1 — HALF pattern, flip about the red flip line'
              : 'cut 1 — no mirror; this piece spans the centreline'))
          + (p.id === p.label ? '' : ' · ' + p.id));
      }
      if (!flipped.length) {
        L('mono', 'nothing to save: this boat has no mirrored pair');
      }
      gap();
    }

    // Everything the checks said that is NOT a blocker -- if it were a blocker
    // this function would never have run.
    const advisories = rep.issues.filter((i) => i.level === 'advisory' || i.level === 'warn');
    L('h2', 'Advisories (' + advisories.length + ') — things to absorb with your hands, '
      + 'not errors');
    if (!advisories.length) L('mono', 'none: every gate green');
    for (const i of advisories.slice(0, 8)) {
      L('mono', i.id + '  ' + (i.where && (i.where.panel || i.where.a || '') || '')
        + '  ' + i.message);
    }
    if (advisories.length > 8) L('mono', '… and ' + (advisories.length - 8) + ' more');

    return lines;
  }

  /**
   * The title block rendered at CONTENT scale, for the single-file SVG.
   *
   * Sizes here are physical millimetres on a 1:1 sheet, which is why they look
   * enormous: `h1` really is 22 mm tall. The tiler renders the SAME LINES at
   * page scale on its appendix sheet -- one source of words, two typographies,
   * so the two can never drift apart.
   */
  const LINE_STEP = { h1: 30, h2: 16, warn: 13, gap: 6, body: 10, mono: 10 };

  function titleBlock(built, layout, rep, opts, parts) {
    const lines = titleLines(built, layout, rep, opts, parts);
    const out = [];
    let y = 0;
    for (const l of lines) {
      if (l.cls !== 'gap') {
        out.push('<text class="' + l.cls + '" x="0" y="' + n2(y) + '">'
          + esc(l.text) + '</text>');
      }
      y += LINE_STEP[l.cls] == null ? 10 : LINE_STEP[l.cls];
    }
    return { svg: '<g id="title-block">\n' + out.join('\n') + '\n</g>', height: y, lines };
  }

  // ------------------------------------------------------------------
  // The whole drawing
  // ------------------------------------------------------------------

  /**
   * The parts that get PRINTED -- which is not always the parts that get CUT.
   *
   * Default: every panel plus the floor, one pattern a piece.
   *
   * `mirrorOnce`: every `starboard` panel is dropped and its port source
   * carries both names ("L1 / R1") and `qty: 2`. The pairing is not guessed
   * from the labels -- develop2.mirrorPanel stamps `mirrorOf` with the id of
   * the port panel it reflected, so the link is the one the geometry itself
   * made. A span is `selfMirroring` and stays qty 1: it already straddles the
   * centreplane, so it has no partner to save.
   */
  function printSet(built, opts) {
    const o = opts || {};
    const mirrored = new Map();   // port panel id -> its starboard label
    if (o.mirrorOnce) {
      for (const p of built.panels) {
        if (p.role === 'starboard' && p.mirrorOf) {
          mirrored.set(p.mirrorOf, built.labels[p.id] || p.id);
        }
      }
    }
    const parts = [];
    for (const p of built.panels) {
      if (o.mirrorOnce && p.role === 'starboard' && p.mirrorOf) continue;
      const own = built.labels[p.id] || p.id;
      const pair = mirrored.get(p.id) || null;
      parts.push({
        id: p.id,
        label: pair ? own + ' / ' + pair : own,
        primary: own,
        pair,
        qty: pair ? 2 : 1,
        cutNote: pair ? 'cut 2, flip the pattern' : 'cut 1',
        role: p.role,
        outline: p.outline,
        panel: p,
      });
    }
    parts.push(floorPart(built.floor, o));
    return parts;
  }

  /**
   * The drawing, as a body plus the box it lives in.
   *
   * Split out from `render` because the tiler needs exactly this: the same
   * body SVG windowed onto different regions, so content in an overlap band is
   * identical on both sheets BY CONSTRUCTION rather than by a matching
   * calculation that could drift.
   */
  function buildBody(built, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const rep = gate(built, o);
    const parts = printSet(built, o);
    const layout = nest(parts, o);
    const byId = new Map(parts.map((p) => [p.id, p]));

    /**
     * The drawing is emitted as PIECES -- each a box plus its own SVG string --
     * rather than as one flat blob.
     *
     * The single-file export just concatenates them, so nothing is lost there.
     * The tiler needs the boxes for two different jobs: dropping sheets that
     * would print nothing (most of a 9 m sheet layout is blank), and emitting
     * only the pieces a given sheet actually shows. Without the second, every
     * page carries the whole drawing and an A4 tiling of this boat is a 13 MB
     * HTML file that a browser opens slowly and prints slower. The glue-margin
     * guarantee survives untouched: two sheets sharing a piece emit the SAME
     * STRING at the same coordinates, which is the strongest form of "identical
     * by construction" available.
     */
    // Every piece is TAGGED with what it is, because the tiler has to be able
    // to say "pattern ink only" without guessing from coordinates. The prose
    // (title block, cutting list, calibration square, roll caption) belongs on
    // the print's appendix sheet, not on a band of cutting tiles that would
    // otherwise print a paragraph of instructions across five sheets of A3.
    const pieces = [];
    const piece = (kind, x, y, w, h, svg) => pieces.push({ kind, x, y, w, h, svg });

    // --- the title block and the calibration square, in the banner above ---
    // The banner grows if the block outgrows it (the cutting list is a line a
    // part), so nothing is ever quietly clipped off the top of the sheet.
    const title = titleBlock(built, layout, rep, o, parts);
    const banner = Math.max(o.banner, title.height + 40);
    piece('title', 0, -banner, 880, banner,
      '<g transform="translate(0 ' + n2(-banner + 20) + ')">' + title.svg + '</g>');
    const calX = 900, calY = -banner + 40;
    piece('calibration', calX - 10, calY - 10, o.calibration + 20, o.calibration + 40,
      calibrationSquare(calX, calY, o.calibration));

    // --- the sheet outline, and the parts on it ---
    piece('roll', 0, -20, layout.usedLength, o.sheetWidth + 20,
      '<rect class="sheet" x="0" y="0" width="' + n2(layout.usedLength)
      + '" height="' + n2(o.sheetWidth) + '"/>\n'
      + '<text class="sub" x="0" y="-6">Fabric sheet '
      + esc((layout.usedLength / 1000).toFixed(2)) + ' m × ' + o.sheetWidth
      + ' mm · dashed edge is the roll, not a cut line</text>');

    // The floor-to-panel correspondence, computed ONCE and rendered twice --
    // see `landingZones`. A label lookup that falls back to a dropped
    // starboard panel's port source keeps mirrorOnce naming consistent on both
    // patterns ("L2 / R2" on the panel, "L1/R1|L2/R2" on the floor's marks).
    const labelById = new Map(parts.map((p) => [p.id, p.label]));
    const labelOf = (id) => {
      if (labelById.has(id)) return labelById.get(id);
      const p = built.panels.find((x) => x.id === id);
      if (p && p.mirrorOf && labelById.has(p.mirrorOf)) return labelById.get(p.mirrorOf);
      return (built.labels && built.labels[id]) || id;
    };
    const zones = landingZones(built, labelOf);
    const zoneOf = new Map(zones.map((z) => [z.segmentId, z]));

    for (const q of layout.placed) {
      const part = byId.get(q.id);
      if (!part) continue;
      // The placement is a RIGID MOTION now, not a translation: the packer may
      // have turned the part to make it nest. Everything geometric on the part
      // goes through `m` -- outline, seam, rulings, ticks, zone marks and the
      // fore arrow -- so it all turns together. Only the lettering stays
      // upright, in sheet coordinates, because a builder has to read it.
      const c = q.cos == null ? 1 : q.cos, s = q.sin == null ? 0 : q.sin;
      const m = (c === 1 && s === 0)
        ? (p) => [p[0] + q.dx, p[1] + q.dy]
        : (p) => [p[0] * c - p[1] * s + q.dx, p[0] * s + p[1] * c + q.dy];
      piece('part', q.x, q.y, q.w, q.h,
        '<g id="part-' + esc(q.id) + '" data-label="' + esc(q.label) + '">\n'
        + (part.role === 'floor'
          ? renderFloor({ part, label: q.label, zones }, q, m)
          : renderPanel({ panel: part.panel, label: q.label, cutNote: part.cutNote,
            zone: zoneOf.get(part.id) }, q, m))
        + '\n</g>');
    }

    const x = -o.margin;
    const y = -banner - o.margin;
    const width = Math.max(layout.usedLength, calX + o.calibration + 40) + 2 * o.margin;
    const height = banner + o.sheetWidth + 2 * o.margin;

    /**
     * The box the CUTTING PATTERN occupies -- the nested pieces and nothing
     * else.
     *
     * Published rather than left for the tiler to infer, because inferring it
     * from `x/y/width/height` means inferring where the prose stops, and the
     * prose has moved before and will again. The union of the tagged `part`
     * pieces is the definition, so a piece that is added, removed or turned
     * changes this by construction.
     */
    const partPieces = pieces.filter((p) => p.kind === 'part');
    const nestBox = partPieces.length
      ? {
        x: Math.min(...partPieces.map((p) => p.x)),
        y: Math.min(...partPieces.map((p) => p.y)),
        x1: Math.max(...partPieces.map((p) => p.x + p.w)),
        y1: Math.max(...partPieces.map((p) => p.y + p.h)),
      }
      : { x: 0, y: 0, x1: 0, y1: 0 };
    nestBox.width = nestBox.x1 - nestBox.x;
    nestBox.height = nestBox.y1 - nestBox.y;

    return {
      body: pieces.map((p) => p.svg).join('\n'),
      pieces,
      x, y, width, height,
      style: STYLE,
      // Where ink actually lands. Same boxes, under the name the tiler's
      // blank-sheet test reads.
      occupancy: pieces.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })),
      nestBox, zones,
      layout, report: rep, parts,
      titleLines: title.lines,
      extents: extents(built),
    };
  }

  /**
   * The pieces of a drawing that a window shows. Text hangs outside a part's
   * outline box (labels sit under the part, the sheet caption above it), so the
   * window is grown by `slop` before the test -- cheaper than tracking glyph
   * boxes, and erring toward printing a piece twice rather than never.
   */
  function piecesIn(drawing, x, y, w, h, slop) {
    const s = slop == null ? 80 : slop;
    const x0 = x - s, y0 = y - s, x1 = x + w + s, y1 = y + h + s;
    return (drawing.pieces || []).filter((p) =>
      x0 < p.x + p.w && p.x < x1 && y0 < p.y + p.h && p.y < y1);
  }

  /**
   * The whole drawing as one self-contained SVG file.
   *
   * `width`/`height` carry the `mm` unit and the viewBox is the same numbers in
   * user units, so 1 user unit is 1 mm at 100% -- that identity is what makes
   * the file 1:1 in a browser, in Inkscape and on a cutter, and it is asserted
   * in tests/engine-export.test.js.
   *
   * @throws when the developability checks refuse (see `gate`).
   */
  function render(built, opts) {
    const b = buildBody(built, opts);
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
      + 'width="' + n2(b.width) + 'mm" height="' + n2(b.height) + 'mm" '
      + 'viewBox="' + n2(b.x) + ' ' + n2(b.y) + ' ' + n2(b.width) + ' ' + n2(b.height) + '">\n'
      + '<title>' + esc(built.doc.meta.name) + ' — packraft cutting pattern, 1:1</title>\n'
      + '<style>' + b.style + '</style>\n'
      + b.body + '\n</svg>\n';
  }

  const api = {
    DEFAULTS, FLOOR_SYMMETRY_MM, STYLE, render, buildBody, piecesIn, printSet,
    floorPart, floorSymmetry, clipHalfY, axisEdge,
    nest, contourNest, gridNest, shelfNest, spanModel, rotatePoints, rotCoeffs,
    bounds,
    extents, gate, calibrationSquare, titleBlock, titleLines, LINE_STEP,
    landingZones, zoneFractions, polyFraction, ZONE_LONG_MM, ZONE_VERY_LONG_MM,
    seamEnds, seamTick, rotAlong,
    positionLabel, n2, esc, pathOf,
  };

  E.exportSvg = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
