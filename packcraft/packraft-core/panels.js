/**
 * Panel generation (spec §3.7, §7.4, §7.4d, §8.3, §8.6).
 *
 * Turns a skeleton into the complete set of flat parts: tube panels, the floor
 * with its developed tab band and segment-keyed registration zones, and the
 * girth strips. Everything downstream (nesting, tiling, export) reads this.
 *
 * ---------------------------------------------------------------------------
 * THE MIRROR (spec §3.4b, §7.7). Exactly one reflection exists in the whole
 * engine, and it is `skeleton.mirrorNode` -- the starboard chain is built from
 * mirrored port nodes, so it is symmetric to the last bit before any panel is
 * developed. Panels therefore inherit symmetry rather than re-deriving it, and
 * every segment is developed directly from its own frustum.
 *
 * An earlier draft generated starboard panels by transforming the port
 * developments instead. That is what §3.4b suggests, and it saves ~2 ms, but
 * it needs the correct 2D isometry between two differently-oriented cone
 * frames AND a start/end swap (the loop traverses starboard aft-to-fore).
 * Getting either wrong silently yields plausible, wrong panels -- the first
 * attempt did exactly that, mislabelling the floor's landing zones. The
 * saving is not worth a class of silent error, so `mirrorPanel` below is
 * retained as the EXPECTATION used to verify congruence (gate G2.2), not as
 * the generator.
 *
 * Mirrored panels are congruent but NOT superimposable -- both outlines must
 * still be emitted (§8.6), and the fabric-folding note explains how to cut the
 * pair from one cut.
 * ---------------------------------------------------------------------------
 *
 * Two things the spec is emphatic about, implemented as it asks:
 *
 * - The floor tab is a DEVELOPED TUBE BAND, never a polygon offset (§3.7).
 *   The tutorial's "extend the floor by 3 cm all round" is a flat offset, fine
 *   at 30 mm and wrong at 150 mm, and it breaks down first at bow and stern
 *   where the protection matters most. The band here is the strip of tube
 *   surface between the landing generator and an arc length `floorTabWidth`
 *   around it, flattened by the same `develop` kernel as everything else.
 *
 * - The floor perimeter is FACETED, not smooth (§7.4d), with one straight
 *   landing zone per tube segment and registration points at every zone
 *   boundary. At the tips the zones converge to the centreplane apex, so the
 *   first and last are triangular rather than quadrilateral -- the degenerate
 *   case a naive quad-strip generator gets wrong.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js');
    require('./constants.js');
    require('./develop.js');
  }
  const P = root.Packraft || (root.Packraft = {});
  const V = P.vec3;
  const C = P.constants;
  const DEV = P.develop;

  /**
   * Seam registration (the fix for the discontinuous landing line).
   *
   * A girth joint is shared by two segments with different frames, so a single
   * fixed clock angle lands their seams at different points on the shared
   * mitre conic. This defines ONE seam point per joint, in the joint's own
   * frame, and solves for the circumferential angle at which each adjacent
   * segment reaches it.
   *
   * The joint frame is built on the bisector of the two axes -- the same
   * direction the mitre plane is built on -- so it is symmetric between the
   * segments by construction, and mirror-symmetric across the hull.
   *
   * @returns {{perSegment: Array<{start:number,end:number}>, points: Array}}
   */
  function registerSeams(skeleton, clockAngle) {
    const n = skeleton.segments.length;
    const perSegment = skeleton.segments.map(() => ({ start: clockAngle, end: clockAngle }));
    const points = [];

    for (let i = 0; i < n; i++) {
      const node = skeleton.nodes[i];
      const inc = skeleton.segments[(i - 1 + n) % n];
      const out = skeleton.segments[i];

      const axisJ = V.norm(V.add(inc.axis, out.axis));
      const f = V.frame(axisJ);
      const uJ = f.u, vJ = f.v;

      const thetaInc = solveSeamTheta(DEV.conify(inc), inc.planeEnd, node.p, axisJ, uJ, vJ, clockAngle);
      const thetaOut = solveSeamTheta(DEV.conify(out), out.planeStart, node.p, axisJ, uJ, vJ, clockAngle);

      perSegment[(i - 1 + n) % n].end = thetaInc;
      perSegment[i].start = thetaOut;

      const pInc = DEV.edgePoint3D(DEV.conify(inc), thetaInc, inc.planeEnd);
      const pOut = DEV.edgePoint3D(DEV.conify(out), thetaOut, out.planeStart);
      points.push({
        node: i,
        point: pInc,
        // Both segments must reach the SAME 3D point. This is the invariant
        // the whole registration exists to establish; G2.7 asserts it.
        agreement: V.dist(pInc, pOut),
      });
    }
    return { perSegment, points };
  }

  /**
   * The circumferential angle at which a segment's cut edge sits at a given
   * clock angle about the joint's axis. Scanned for a sign change, then
   * bisected -- the relation is monotone over a turn but not analytic.
   */
  function solveSeamTheta(cn, plane, origin, axisJ, uJ, vJ, target) {
    const wrap = (a) => {
      let x = a;
      while (x > Math.PI) x -= 2 * Math.PI;
      while (x < -Math.PI) x += 2 * Math.PI;
      return x;
    };
    const g = (th) => {
      const q = DEV.edgePoint3D(cn, th, plane);
      const d = V.sub(q, origin);
      const dp = V.sub(d, V.scale(axisJ, V.dot(d, axisJ)));
      return wrap(Math.atan2(V.dot(dp, vJ), V.dot(dp, uJ)) - target);
    };

    const N = 720;
    let prevTh = 0, prevG = g(0);
    for (let i = 1; i <= N; i++) {
      const th = (2 * Math.PI * i) / N;
      const cur = g(th);
      if (prevG <= 0 && cur >= 0 && cur - prevG < Math.PI) {
        let lo = prevTh, hi = th;
        for (let k = 0; k < 60; k++) {
          const m = 0.5 * (lo + hi);
          if (g(m) < 0) lo = m; else hi = m;
        }
        return 0.5 * (lo + hi);
      }
      prevTh = th; prevG = cur;
    }
    throw new Error('registerSeams: no seam angle found on this cut edge');
  }

  /**
   * The starboard geometry implied by a port panel: reflect in y = 0, and swap
   * start for end because the loop traverses the starboard side aft-to-fore.
   * Circumferential order is preserved (verified: reversing it is wrong by
   * ~400 mm). Used to CHECK the independently developed starboard panels,
   * not to produce them -- see the header note.
   */
  function mirrorPanel(panel, id) {
    return {
      id: id || ('R' + panel.id.slice(1)),
      role: 'starboard',
      mirrorOf: panel.id,
      startEdge3D: panel.endEdge3D.map(V.mirrorY),
      endEdge3D: panel.startEdge3D.map(V.mirrorY),
    };
  }

  /** Signed area of a closed 2D polygon; positive for counter-clockwise. */
  function signedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  const polyLength = (pts) => {
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return t;
  };

  /**
   * The floor tab band for one segment: the strip of tube surface running from
   * the landing generator through an arc length `width`, developed.
   *
   * Spec §3.7 says to specify arc length and clamp the angle, because a fixed
   * arc converts to very different angles as the radius tapers -- 150 mm is
   * 57 deg amidships and 115 deg near a tip, which is past the outboard
   * equator where the fabric would have to shrink-wrap.
   *
   * On a cone the developed circles are arcs of radius l about the apex, so an
   * arc length w subtends w/l of developed angle -- which varies along the
   * band, making its outer boundary a curve rather than a straight ray. That
   * curvature IS the error a polygon offset throws away.
   */
  function tabBand(seg, thetaStart, thetaEnd, width, maxAngleDeg, samples) {
    const cn = DEV.conify(seg);
    const n = samples || 64;
    const maxAngle = (maxAngleDeg * Math.PI) / 180;
    const inner = [], outer = [], inner3D = [], outer3D = [];
    const achieved = { minAngle: Infinity, maxAngle: -Infinity, clamped: false };

    for (let i = 0; i <= n; i++) {
      const f = i / n;
      // Follow the REGISTERED seam curve, not a fixed generator: the tab hangs
      // off the landing line, so it has to track wherever that line goes.
      const seamTheta = thetaStart + (thetaEnd - thetaStart) * f;
      const lStart = DEV.cutParam(cn, seamTheta, seg.planeStart);
      const lEnd = DEV.cutParam(cn, seamTheta, seg.planeEnd);
      const l = lStart + (lEnd - lStart) * f;

      // Perpendicular radius at this station, hence the angle the arc covers.
      const R = cn.kind === 'cylinder' ? cn.R : l * cn.sinAlpha;
      let dTheta = width / R;
      if (dTheta > maxAngle) { dTheta = maxAngle; achieved.clamped = true; }
      achieved.minAngle = Math.min(achieved.minAngle, dTheta);
      achieved.maxAngle = Math.max(achieved.maxAngle, dTheta);

      const theta = seamTheta - dTheta; // toward the tube's outboard face
      inner.push(DEV.paramPointDev(cn, seamTheta, l));
      outer.push(DEV.paramPointDev(cn, theta, l));
      inner3D.push(DEV.paramPoint3D(cn, seamTheta, l));
      outer3D.push(DEV.paramPoint3D(cn, theta, l));
    }

    return {
      inner, outer, inner3D, outer3D,
      outline: inner.concat(outer.slice().reverse()),
      minAngleDeg: (achieved.minAngle * 180) / Math.PI,
      maxAngleDeg: (achieved.maxAngle * 180) / Math.PI,
      clamped: achieved.clamped,
      // Arc length of the band's inner edge, in 3D and developed: the two must
      // agree, since development is an isometry. Checked by G2.3.
      innerLength3D: polyLength3D(inner3D),
      innerLengthDev: polyLength(inner),
      outerLength3D: polyLength3D(outer3D),
      outerLengthDev: polyLength(outer),
    };
  }

  const polyLength3D = (pts) => {
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += V.dist(pts[i], pts[i - 1]);
    return t;
  };

  /**
   * The floor panel.
   *
   * The tube lands on the floor along the generator at `floorClockAngle`, one
   * straight edge per segment (§7.4d). Those edges are 3D, and wherever the
   * hull rises they are LONGER than their plan projections -- 12.6 mm on each
   * bow segment of the reference hull, 26 mm around the whole 5.35 m
   * perimeter.
   *
   * The floor cannot simply be cut to those 3D lengths. A flat sheet whose
   * boundary keeps the plan-view turning but lengthens every edge does not
   * close: that failure is not an arithmetic residual to distribute, it is the
   * geometric statement that no such flat panel exists. (An earlier draft
   * tried to absorb it into the headings and produced a 771 mm gap.)
   *
   * So the floor is cut FLAT -- the plan projection of the landing loop, which
   * closes exactly -- and the surplus tube length becomes **ease**, reported
   * per zone for the builder to distribute inside that zone. This is exactly
   * the mechanism §7.4d describes, and the per-zone numbers are what §17.12
   * asks someone to check against a real build before trusting it.
   *
   * Both lengths are emitted for every zone so the pattern can print them and
   * the builder can verify with a tape before welding (§8.6).
   *
   * The landing line is continuous across girth joints: `registerSeams` fixes
   * one seam point per joint from the joint's own bisector frame, and each
   * segment is developed at whatever circumferential angle reaches it. Before
   * that, every segment measured the clock angle in its own frame and the
   * landing line stepped by up to 8.3 mm at each joint -- and came out
   * asymmetric between port and starboard on a hull symmetric to 1e-9
   * everywhere else. Adjacent segments now agree on the seam point to 5e-12 mm.
   */
  function buildFloor(skeleton, panels, params) {
    const cn = params.construction;
    const seamAngle = (cn.floorClockAngle * Math.PI) / 180;

    // Landing polyline: one straight edge per segment, in traversal order.
    const landing3D = [];
    const zones = [];
    for (const panel of panels) {
      const curve = panel.seamCurve3D;
      const a = curve[0];
      const b = curve[curve.length - 1];
      if (!landing3D.length) landing3D.push(a);
      landing3D.push(b);
      // The zone's length is the seam CURVE's arc length, not the chord: that
      // is the length of fabric edge the builder actually has to land.
      zones.push({ segmentId: panel.id, length3D: panel.seamLength3D, chord3D: V.dist(a, b) });
    }

    // The flat outline: the plan projection of the landing loop. Closed by
    // construction, because the landing loop is closed in 3D.
    const outlinePts = landing3D.slice(0, -1).map((q) => [q[0], q[1]]);

    // Registration points at every zone boundary, keyed to the segment that
    // lands there (§7.4d) -- strictly better than generic match marks because
    // a misalignment is caught inside one segment instead of accumulating.
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      z.id = 'Z' + (i + 1);
      z.from = outlinePts[i];
      z.to = outlinePts[(i + 1) % outlinePts.length];
      z.lengthFlat = Math.hypot(z.to[0] - z.from[0], z.to[1] - z.from[1]);
      // Surplus tube length to be eased into this zone (§7.4d). Zero wherever
      // the landing line is level; it appears only where the hull rises.
      z.ease = z.length3D - z.lengthFlat;
      z.easePercent = (100 * z.ease) / z.lengthFlat;
      // At the tips the landing zones converge to the centreplane apex, so
      // these are triangular rather than quadrilateral. Flagged explicitly:
      // it is where a naive quad-strip generator breaks (§7.4d).
      z.triangular = Math.abs(z.from[1]) < 1e-6 || Math.abs(z.to[1]) < 1e-6;
    }

    // The tab band, developed per segment (never offset).
    const bands = panels.map((panel) => {
      const seg = skeleton.segments.find((s) => s.id === panel.id);
      const band = tabBand(seg, panel.seamAngleStart, panel.seamAngleEnd,
        cn.floorTabWidth, cn.floorWrapMaxAngle);
      band.segmentId = panel.id;
      return band;
    });

    return {
      id: 'FLOOR',
      role: 'floor',
      outline: outlinePts,
      landing3D,
      zones,
      bands,
      seamAngle,
      tabWidth: cn.floorTabWidth,
      seamAgreement: 0,
      perimeter3D: zones.reduce((t, z) => t + z.length3D, 0),
      perimeterFlat: zones.reduce((t, z) => t + z.lengthFlat, 0),
      totalEase: zones.reduce((t, z) => t + z.ease, 0),
      maxZoneEase: zones.reduce((m, z) => Math.max(m, z.ease), 0),
      netArea: Math.abs(signedArea(outlinePts)),
      anyBandClamped: bands.some((b) => b.clamped),
    };
  }

  /**
   * Girth strips (§7.4): butt-jointed seams are closed by a strip of the same
   * structural fabric welded across the joint. They are first-class panels --
   * generated, nested, counted and printed -- not an afterthought.
   */
  function buildStrips(skeleton, panels, params) {
    const width = params.construction.stripWidth;
    const strips = [];
    for (let i = 0; i < skeleton.segments.length; i++) {
      const seg = skeleton.segments[i];
      const next = skeleton.segments[(i + 1) % skeleton.segments.length];
      const panel = panels.find((p) => p.id === seg.id);
      const length = panel ? polyLength3D(panel.endEdge3D) : 0;
      strips.push({
        id: 'S' + (i + 1),
        role: 'strip',
        seamId: seg.id + '-' + next.id,
        length,
        width,
        outline: [[0, 0], [length, 0], [length, width], [0, width]],
      });
    }
    return strips;
  }

  /**
   * Build every flat part for a design.
   * @param {object} params derived params
   * @param {object} skeleton output of skeleton.buildSkeleton
   */
  function build(params, skeleton, opts) {
    const o = opts || {};
    const samples = o.samples || C.PANEL_SAMPLES;
    const seamAngle = (params.construction.floorClockAngle * Math.PI) / 180;

    // Normalise outline winding (§2b). A developed panel comes out clockwise
    // or counter-clockwise depending on which side of the frustum its apex
    // sits, so raw outlines have mixed orientation and any area or nesting
    // sum built from them silently cancels. The edge arrays keep their own
    // parametrisation -- only the closed outline is reoriented.
    const orient = (panel) => {
      if (signedArea(panel.outline) < 0) panel.outline = panel.outline.slice().reverse();
      return panel;
    };

    // One seam point per joint, shared by both adjacent segments, so the
    // longitudinal seam is continuous around the hull.
    const registration = registerSeams(skeleton, seamAngle);

    // Every segment is developed from its own frustum. The skeleton's chain is
    // already exactly mirror-symmetric (skeleton.mirrorNode), so the two sides
    // cannot drift; see the header note on why this beats transforming the
    // port developments.
    const tube = skeleton.segments.map((seg, i) => orient(DEV.developSegment(seg, {
      seamAngle,
      seamAngleStart: registration.perSegment[i].start,
      seamAngleEnd: registration.perSegment[i].end,
      samples,
      measure: o.measure !== false,
    })));

    // Mated-edge labels (§8.3): every seam edge carries a shared ID and its
    // partner, in the tutorial's e / e-prime convention.
    const seams = [];
    for (let i = 0; i < skeleton.segments.length; i++) {
      const a = skeleton.segments[i];
      const b = skeleton.segments[(i + 1) % skeleton.segments.length];
      const label = 'e' + (i + 1);
      seams.push({ id: label, a: a.id, b: b.id, type: 'butt-strip', allowance: 0 });
      const pa = tube.find((p) => p.id === a.id);
      const pb = tube.find((p) => p.id === b.id);
      pa.aftEdgeLabel = label;
      pb.foreEdgeLabel = label + '′';
    }

    const floor = buildFloor(skeleton, tube, params);
    floor.seamAgreement = registration.points.reduce((m, p) => Math.max(m, p.agreement), 0);
    floor.seamPoints = registration.points;
    const strips = buildStrips(skeleton, tube, params);

    return {
      tube, floor, strips, seams,
      // §3.7: the floor construction is derived from the coating side, not
      // chosen. The pattern must emit the right cut-or-keep instruction.
      floorInstruction: params.construction.coatingOrientation === 'inside'
        ? 'RETAIN the dashed floor polygon: it becomes the bottom layer of a double floor.'
        : 'CUT OUT the dashed floor polygon: the floor is a separate panel.',
      counts: {
        tube: tube.length,
        unique: skeleton.segments.filter((s) => s.role !== 'starboard').length,
        strips: strips.length,
        floorCorners: skeleton.segments.length, // §5.7b: the risk metric
      },
    };
  }

  const api = { build, mirrorPanel, buildFloor, buildStrips, tabBand, signedArea, registerSeams };

  P.panels = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
