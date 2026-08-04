/**
 * engine/ops.js -- THE EDIT LAYER. Document in, document out, plus undo.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM doc.js
 *
 * engine/doc.js already carries small positional mutators (`D.addSeam`,
 * `D.setWidth`, ...). Those are RAW: they take an ARRAY INDEX, move numbers in
 * the record, and stop. This module is the layer a UI actually talks to. It
 * addresses welds by their STABLE ID -- an index is invalidated by the next
 * insert, and a UI holding one is holding a bug -- and it owns the three things
 * a raw mutator must not know about:
 *
 *   1. LOCKS. `setHeight` under `locks.uniformB` writes every locked weld, not
 *      one. Locks are relations between document fields applied by the EDIT
 *      layer, never by the geometry kernel (plan, "Constraint philosophy").
 *   2. INVERSES. Every op returns the descriptor that undoes it, so undo is a
 *      2-field object rather than a snapshot of the whole boat. `apply()`
 *      replays either direction.
 *   3. WHAT MOVED. Every op returns `changedSegments` -- the ids of derived
 *      segments whose loft is no longer the one already on screen -- so a live
 *      editor re-lofts two panels instead of nine. Computed by DIFFING the
 *      derived rings, not by hand-reasoning about adjacency, so it stays
 *      correct for the topology switch (where the segment SET changes) without
 *      a special case.
 *
 * (`addSeam` is the one exception, and deliberately: it names a SEGMENT, and a
 * segment has no identity of its own -- it is derived, and the one being split
 * ceases to exist. It takes the stored-segment index, which is the index of the
 * weld at its head, and returns the new weld's id.)
 *
 * Nothing here blocks an edit. Every op re-validates and hands the issues back
 * with the document; a half-finished boat is a legitimate document and only
 * EXPORT is gated (engine/checks.js). Ops throw only for caller errors -- an
 * id that does not exist, or removing a weld from a 2-weld boat -- never for
 * geometry.
 *
 * ---------------------------------------------------------------------------
 * addSeam DOES NOT LERP THE RECORD. It reads the loft.
 *
 * The naive insert averages the two neighbouring weld records. That is wrong in
 * a way that shows: on any segment whose welds are raked differently, the
 * averaged ellipse does not lie on the surface the user is looking at, so
 * "subdivide this tube" visibly changes the boat's shape. The plan asks for a
 * seam interpolated "along the loft", and the loft is right there:
 *
 *   1. the new weld's PLANE is the interpolated plane -- centre by lerp of c,
 *      normal by SLERP (constant angular rate; a normalised lerp is not),
 *   2. the new weld's CURVE is the actual section of the lofted surface by that
 *      plane, reduced to an ellipse by AREA MOMENTS (exact whenever the section
 *      really is an ellipse -- which is every closed-form branch: cone,
 *      cylinder, extrusion -- and area/aspect preserving when it is not),
 *   3. the new weld's SEAM is the clock angle of the point where the segment's
 *      existing longitudinal seam crosses that plane, so the landing line does
 *      not move when a seam is inserted,
 *   4. `b` is overridden by the uniform-b LOCK when engaged, because the lock
 *      says b is not a free parameter of this boat.
 *
 * If any step degenerates the op falls back to the linear interpolation and
 * says so in `detail.method`. Total, never throwing: interaction review 4.
 *
 * ---------------------------------------------------------------------------
 * editProfile IS THE SMALLEST OP IN THE FILE, AND THAT IS THE POINT
 *
 * B5 -- "adjust a seam's side profile" -- writes ONE field of ONE weld
 * (`weld.profile`, a dimensionless radial deviation; the representation and
 * the reasoning behind it are documented in engine/doc.js's header). It needs
 * no new inverse machinery, no new diff machinery and no new kernel entry
 * point, because the weld-first model was arranged so that a section curve is
 * a property of a weld and everything else re-derives.
 *
 * The three things that DID need saying, all of them elsewhere:
 *
 *   - `weldKey` (below) had to learn the profile, or a moulding would edit the
 *     document without re-lofting anything on screen;
 *   - `addSeam` had to STOP doing its clever thing on a profiled segment: the
 *     moment-ellipse section fit is exact only because a plane cut of a cone or
 *     an extrusion is a conic, and a moulded tube's section is not;
 *   - engine/loft.js had to re-argue each closed form. Two survive with equal
 *     profiles (the mirror-pair extrusion and the homothetic cone); the
 *     parallel-plane formula does not, and declines.
 * ---------------------------------------------------------------------------
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js'); require('./quad.js'); require('./doc.js'); require('./loft.js');
  }
  const E = root.PackraftEngine || (root.PackraftEngine = {});
  const V = E.vec3;
  const D = E.doc;
  const LOFT = E.loft;

  const TAU = 2 * Math.PI;

  /**
   * Capture radius of the centreplane snap, mm (plan v4: "dragging the last dot
   * onto/off the mirror line SWITCHES topology live, with snap-to-plane within
   * a small capture radius"). 20 mm is a couple of pixels at a whole-boat zoom
   * and an eighth of a tube radius -- small enough that it never fires by
   * accident, large enough to be reachable with a mouse.
   */
  const SNAP_MM = 20;

  // ==================================================================
  // What moved: diff the derived rings
  // ==================================================================

  // The PROFILE is in the key. It is the only field of a weld that is not a
  // scalar, and leaving it out is how "I moulded that section and nothing
  // re-lofted" happens: `changedSegments` is what a live editor rebuilds, so a
  // field missing from this string is a field the screen never notices.
  const weldKey = (w) => [
    w.c[0], w.c[1], w.c[2], w.n[0], w.n[1], w.n[2],
    w.a, w.b, w.roll, w.seam,
    w.profile ? w.profile.k.join(':') : '',
  ].join(',');

  /** id -> everything the loft of that segment depends on. */
  function ringKeys(doc) {
    const m = new Map();
    if (!doc.welds || doc.welds.length < 2) return m;
    for (const s of D.ring(doc).segments) {
      m.set(s.id, s.role + '|' + s.selfMirroring + '|'
        + weldKey(s.A.weld) + '|' + weldKey(s.B.weld));
    }
    return m;
  }

  /**
   * Segments whose loft the caller must redo, and the ones it must throw away.
   *
   * `changed` includes newly created segments: a UI re-lofts exactly this list
   * and drops `removed`, and is then in sync with the new document whatever the
   * op was -- including a topology switch, where the whole set of segments at
   * one end of the boat is replaced.
   */
  function diffSegments(before, after) {
    const A = ringKeys(before), B = ringKeys(after);
    const changed = [], added = [], removed = [];
    for (const [id, k] of B) {
      if (!A.has(id)) { changed.push(id); added.push(id); }
      else if (A.get(id) !== k) changed.push(id);
    }
    for (const id of A.keys()) if (!B.has(id)) removed.push(id);
    return { changed, added, removed };
  }

  // ==================================================================
  // Result plumbing
  // ==================================================================

  function result(op, args, before, after, inverse, detail) {
    const d = diffSegments(before, after);
    return {
      op, args,
      doc: after,
      changedSegments: d.changed,
      addedSegments: d.added,
      removedSegments: d.removed,
      issues: D.validate(after),
      inverse,
      detail: detail || {},
    };
  }

  function indexOfId(doc, id) {
    const i = doc.welds.findIndex((w) => w.id === id);
    if (i < 0) throw new Error('ops: no weld with id ' + id);
    return i;
  }

  /** The record as it was, for an exact inverse. */
  const snapshot = (doc, ids) => ids.map((id) => ({
    id, weld: D.clone(doc.welds[indexOfId(doc, id)]),
  }));

  // ==================================================================
  // Geometry helpers
  // ==================================================================

  /** Constant-angular-rate interpolation of two unit vectors. */
  function slerpUnit(a, b, s) {
    const d = Math.max(-1, Math.min(1, V.dot(a, b)));
    if (d > 1 - 1e-12 || d < -1 + 1e-9) return V.norm(V.lerp(a, b, s));
    const om = Math.acos(d), so = Math.sin(om);
    return V.add(V.scale(a, Math.sin((1 - s) * om) / so),
      V.scale(b, Math.sin(s * om) / so));
  }

  /**
   * The ellipse of best fit to a closed plane polygon, by AREA MOMENTS.
   *
   * For a uniform elliptical lamina with semi-axes (a, b) about its principal
   * axes,  area = pi a b,  INT u^2 dA = pi a^3 b / 4,  INT v^2 dA = pi a b^3 /4,
   * INT uv dA = 0. So diagonalising the central second-moment matrix gives the
   * axis directions, and
   *
   *     a/b = sqrt(l1/l2),    a*b = sqrt( 4 sqrt(l1 l2) / pi )
   *
   * recovers both semi-axes in closed form. EXACT when the section really is an
   * ellipse -- which it is on every closed-form branch of the loft (a plane cut
   * of a cone, a cylinder or an elliptic extrusion is a conic) -- and
   * area-and-aspect preserving when it is not. No eigen-solver, no conic
   * least-squares, no failure mode where the fit flips to a hyperbola.
   *
   * @returns {{c:number[2], a:number, b:number, roll:number, area:number}|null}
   *   in the 2-D coordinates the points were given in; `roll` is the angle of
   *   the a-axis from +u.
   */
  function momentEllipse(pts) {
    const n = pts.length;
    if (n < 8) return null;
    let A2 = 0, cx = 0, cy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const cr = p[0] * q[1] - q[0] * p[1];
      A2 += cr;
      cx += (p[0] + q[0]) * cr;
      cy += (p[1] + q[1]) * cr;
      sxx += cr * (p[0] * p[0] + p[0] * q[0] + q[0] * q[0]);
      syy += cr * (p[1] * p[1] + p[1] * q[1] + q[1] * q[1]);
      sxy += cr * (p[0] * q[1] + 2 * p[0] * p[1] + 2 * q[0] * q[1] + q[0] * p[1]);
    }
    const area = A2 / 2;
    if (!isFinite(area) || Math.abs(area) < 1e-9) return null;
    cx /= 3 * A2; cy /= 3 * A2;
    // Central moments: INT u^2 dA etc., about the centroid.
    const Iuu = sxx / 12 - area * cx * cx;
    const Ivv = syy / 12 - area * cy * cy;
    const Iuv = sxy / 24 - area * cx * cy;
    const s = Math.sign(area) || 1;
    const m11 = s * Iuu, m22 = s * Ivv, m12 = s * Iuv;
    // 2x2 symmetric eigenvalues, closed form.
    const tr = m11 + m22, dd = Math.sqrt(Math.max(0, (m11 - m22) * (m11 - m22) + 4 * m12 * m12));
    const l1 = (tr + dd) / 2, l2 = (tr - dd) / 2;
    if (!(l1 > 0) || !(l2 > 0)) return null;
    // Eigenvector for l1.
    let ex = m12, ey = l1 - m11;
    if (Math.hypot(ex, ey) < 1e-12) { ex = 1; ey = 0; }
    // sqrt(l1 l2) = (pi/4)(ab)^2, so a*b is the SQUARE ROOT of 4 sqrt(l1 l2)/pi.
    const ab = Math.sqrt(4 * Math.sqrt(l1 * l2) / Math.PI);
    const r = Math.sqrt(l1 / l2);
    const a = Math.sqrt(ab * r), b = Math.sqrt(ab / r);
    if (!(a > 0) || !(b > 0) || !isFinite(a) || !isFinite(b)) return null;
    return { c: [cx, cy], a, b, roll: Math.atan2(ey, ex), area: Math.abs(area) };
  }

  /**
   * The section of a lofted segment by a plane, as a weld record.
   *
   * Returns null (never throws) whenever the cut degenerates -- a ruling
   * parallel to the plane, a cut that leaves the patch, a non-finite fit --
   * and `addSeam` then falls back to linear interpolation.
   */
  function sectionWeld(lf, plane, samples) {
    const N = samples || 128;
    const cut = lf.cutWithPlane(plane, N);
    if (cut.missing) return null;
    // A cut that leaves the patch is an EXTRAPOLATION of the surface, not a
    // section of it, and fitting to it would put the new weld somewhere the
    // boat is not. A few stragglers at the seam are tolerable; a tenth of the
    // ring is not, and the caller falls back to linear interpolation.
    if (cut.offPatch > N / 10) return null;
    const nrm = V.norm(plane.normal);
    const fr = V.frame(nrm);
    const pts = [], pts3 = [];
    for (let i = 0; i < N; i++) {            // drop the duplicated last sample
      const p = cut.points[i];
      if (!p) return null;
      pts3.push(p);
      const d = V.sub(p, plane.point);
      pts.push([V.dot(d, fr.u), V.dot(d, fr.v)]);
    }
    const fit = momentEllipse(pts);
    if (!fit) return null;
    // RICHARDSON, and it is free. A polygon INSCRIBED in an ellipse has less
    // area than the ellipse, by O(h^2) in the sample spacing -- 128 samples of
    // an exact cone section come back 0.026 mm small on a 130 mm radius, which
    // is a bias, not noise, and it would sit in every inserted weld. The same
    // points thinned by two give the h -> 2h answer at no extra cost, so
    // (4 f_h - f_2h)/3 cancels the leading term and leaves O(h^4): the same
    // cone section then lands within 1e-4 mm.
    const half = [];
    for (let i = 0; i < pts.length; i += 2) half.push(pts[i]);
    const coarse = half.length >= 8 ? momentEllipse(half) : null;
    const rich = (f, c2) => (c2 ? (4 * f - c2) / 3 : f);
    const a = rich(fit.a, coarse && coarse.a);
    const b = rich(fit.b, coarse && coarse.b);
    if (!(a > 0) || !(b > 0)) return null;
    const c = V.add(plane.point,
      V.add(V.scale(fr.u, fit.c[0]), V.scale(fr.v, fit.c[1])));
    const w = {
      c, n: nrm, a, b, roll: fit.roll, seam: 0,
      onCentreplane: false, profile: null,
    };
    return { weld: w, points: pts3, offPatch: cut.offPatch,
      residual: radialResidual(w, pts3) };
  }

  /**
   * How far a weld ellipse sits from a sampled 3-D curve, radially, in mm.
   *
   * Reported by `addSeam` as `detail.fitResidual`: "the inserted weld is this
   * far off the surface you inserted it into". Never gated -- an editor paints
   * it -- and on every closed-form branch (cone, cylinder, extrusion) the
   * section IS an ellipse and this is ~1e-10.
   */
  function radialResidual(w, pts3) {
    const fr = D.weldFrame(w);
    const base = V.frame(w.n);
    let worst = 0;
    for (const p of pts3) {
      const rel = V.sub(p, w.c);
      const clock = Math.atan2(V.dot(rel, base.v), V.dot(rel, base.u));
      worst = Math.max(worst, V.dist(p, D.weldPoint(w, D.paramAtClock(w, clock), fr)));
    }
    return worst;
  }

  /**
   * The clock angle, about a new weld, of the point where the segment's
   * longitudinal seam crosses that weld's plane.
   *
   * This is what keeps the landing line still when a seam is inserted: the new
   * weld's seam point is a point of the OLD seam curve, so the floor's landing
   * polygon gains a vertex on itself instead of moving.
   */
  function seamClockAt(lf, A, B, plane, centre) {
    const tA = D.seamParam(A);
    const rawB = lf.thetaAtPhi(D.seamParam(B));
    if (!isFinite(rawB)) return null;
    const tB = tA + V.wrapPi(rawB - tA);
    const nrm = V.norm(plane.normal);
    const at = (x) => {
      const st = lf.station(tA + (tB - tA) * x);
      return V.add(st.p, V.scale(st.r, x));
    };
    const sd = (x) => V.dot(V.sub(at(x), plane.point), nrm);
    let lo = 0, hi = 1, flo = sd(0), fhi = sd(1);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2, f = sd(mid);
      if (flo * f <= 0) { hi = mid; fhi = f; } else { lo = mid; flo = f; }
    }
    const p = at((lo + hi) / 2);
    const fr = V.frame(nrm);
    const rel = V.sub(p, centre);
    return Math.atan2(V.dot(rel, fr.v), V.dot(rel, fr.u));
  }

  /**
   * A profile resampled onto `m` coefficients, or m zeros when there is none.
   *
   * Used only to bring two profiles onto a common knot count before blending.
   * `doc.profileSpec({knots: m})` does the resampling by evaluating the current
   * spline at the new stations and re-solving the interpolation system, so the
   * SHAPE survives a change of resolution even though the coefficients cannot.
   */
  function resampleK(p, m) {
    if (!p) return new Array(m).fill(0);
    if (p.k.length === m) return p.k.slice();
    const r = D.profileSpec({ knots: m }, p);
    return r ? r.k.slice() : new Array(m).fill(0);
  }

  /**
   * Blend two profiles, for a seam inserted between them.
   *
   * Two profiles at the SAME resolution blend coefficient by coefficient, which
   * is what makes "add a seam in a moulded tube" a no-op on the shape: equal
   * arrays blend to themselves at every fraction. One profile against none
   * blends against zeros, i.e. the moulding fades out along the segment exactly
   * as the loft does.
   */
  function lerpProfile(pa, pb, s) {
    if (!pa && !pb) return null;
    const m = Math.max(pa ? pa.k.length : 0, pb ? pb.k.length : 0,
      D.PROFILE_MIN_KNOTS);
    const ka = resampleK(pa, m), kb = resampleK(pb, m);
    const k = new Array(m);
    for (let i = 0; i < m; i++) k[i] = ka[i] + (kb[i] - ka[i]) * s;
    return { k };
  }

  // ==================================================================
  // The operations
  // ==================================================================

  /**
   * addSeam: insert a weld into stored segment `segIdx` at fraction f.
   *
   * Stable ids: the new weld takes doc.nextId and EVERY EXISTING WELD KEEPS ITS
   * ID (architecture review 5 -- positional part names silently relabel a
   * builder's half-cut pattern set). Only array positions shift.
   */
  function addSeam(doc, segIdx, f, opts) {
    const o = opts || {};
    const A = doc.welds[segIdx], B = doc.welds[segIdx + 1];
    if (!A || !B) throw new Error('ops.addSeam: no stored segment ' + segIdx);
    const s = f == null ? 0.5 : f;
    if (!(s > 0 && s < 1)) throw new Error('ops.addSeam: f must be in (0,1); got ' + s);

    // Linear fallback -- also the source of the fields the section cannot know
    // (there is no "interpolated seam" until the seam curve has been crossed).
    const lin = {
      c: V.lerp(A.c, B.c, s),
      n: slerpUnit(A.n, B.n, s),
      a: A.a + (B.a - A.a) * s,
      b: A.b + (B.b - A.b) * s,
      roll: A.roll + V.wrapPi(B.roll - A.roll) * s,
      seam: A.seam + V.wrapPi(B.seam - A.seam) * s,
    };

    let method = 'linear', residual = null, offPatch = null, section = null;
    let w = Object.assign({}, lin);
    // A PROFILED NEIGHBOUR DISQUALIFIES THE SECTION FIT, and says so.
    //
    // `sectionWeld` reduces the plane cut to an ellipse by area moments, which
    // is exact only because a plane cut of a cone, a cylinder or an elliptic
    // extrusion IS a conic. Cut a moulded tube and the section is the moulding,
    // not an ellipse, so the fit would quietly replace the shape the user drew
    // with the ellipse of the same area and aspect -- an inserted seam that
    // visibly un-moulds the boat. So: fall back to interpolating the RECORD,
    // profile included. On the branches where the two profiles are identical
    // (extrusion, cone, cylinder -- the ones a moulded template actually
    // produces) interpolating identical coefficient arrays reproduces them
    // exactly, so the linear path is not a compromise there at all.
    const profiled = !!(A.profile || B.profile);
    if (profiled) method = 'linear-profiled';
    if (o.method !== 'linear' && !profiled) {
      const plane = { point: lin.c, normal: lin.n };
      let lf = null;
      try {
        lf = LOFT.loft(A, B, { stations: o.stations || 96 });
      } catch (e) { lf = null; }
      const sec = lf && sectionWeld(lf, plane, o.samples || 128);
      if (sec && isFinite(sec.weld.a) && isFinite(sec.weld.b)) {
        method = 'section';
        section = sec;
        offPatch = sec.offPatch;
        w.c = sec.weld.c;
        w.a = sec.weld.a;
        w.b = sec.weld.b;
        // A principal axis has no sign, so the fit is only defined mod pi.
        // Pick the lift nearest the neighbours' roll: the ellipse is identical
        // either way (roll + pi is the same curve traced from t + pi), but a
        // roll that stays continuous along the boat is what a fairness lock and
        // a numeric readout will both want later.
        w.roll = Math.abs(V.wrapPi(sec.weld.roll - lin.roll)) > Math.PI / 2
          ? V.wrapPi(sec.weld.roll + Math.PI) : sec.weld.roll;
        const clock = seamClockAt(lf, A, B, plane, sec.weld.c);
        if (clock != null) w.seam = clock;
        else w.seam = lin.seam;
      }
    }
    // The uniform-b LOCK owns b. An inserted weld is an edit like any other, so
    // it obeys the same relation -- otherwise "add a seam" quietly breaks the
    // invariant the lock exists to hold.
    if (doc.locks.uniformB) w.b = A.b;
    // Measure the residual AFTER the lock has had its say: the number a UI
    // shows must describe the weld that was actually inserted, not the free fit
    // that the lock then overrode.
    if (section) residual = radialResidual(Object.assign({}, w, { n: lin.n }), section.points);

    const profile = lerpProfile(A.profile, B.profile, s);

    const d = D.clone(doc);
    const id = d.nextId++;
    d.welds.splice(segIdx + 1, 0, D.normaliseWeld(Object.assign({ id }, w,
      { onCentreplane: false, profile })));
    d.welds[segIdx + 1].id = id;

    return result('addSeam', [segIdx, s], doc, d,
      { op: 'removeSeam', args: [id] },
      { newId: id, method, fitResidual: residual, offPatch, fraction: s,
        knots: profile ? profile.k.length : 0 });
  }

  /** removeSeam: delete the weld with this id; its neighbours re-loft. */
  function removeSeam(doc, id) {
    const idx = indexOfId(doc, id);
    if (doc.welds.length <= 2) {
      throw new Error('ops.removeSeam: a boat needs at least 2 welds');
    }
    const prev = D.clone(doc.welds[idx]);
    const d = D.clone(doc);
    d.welds.splice(idx, 1);
    return result('removeSeam', [id], doc, d,
      { op: 'restoreSeam', args: [idx, prev] }, { index: idx });
  }

  /** Undo primitive for removeSeam: put a weld record back where it was. */
  function restoreSeam(doc, index, weld) {
    const d = D.clone(doc);
    const w = D.normaliseWeld(weld);
    w.id = weld.id;
    d.welds.splice(index, 0, w);
    if (d.nextId <= w.id) d.nextId = w.id + 1;
    return result('restoreSeam', [index, D.clone(weld)], doc, d,
      { op: 'removeSeam', args: [w.id] }, { index });
  }

  /** Undo primitive for every single-record op: overwrite whole weld records. */
  function restoreWelds(doc, list) {
    const d = D.clone(doc);
    const back = [];
    for (const item of list) {
      const i = indexOfId(d, item.id);
      back.push({ id: item.id, weld: D.clone(d.welds[i]) });
      const w = D.normaliseWeld(item.weld);
      w.id = item.id;
      d.welds[i] = w;
    }
    return result('restoreWelds', [D.clone(list)], doc, d,
      { op: 'restoreWelds', args: [back] }, { count: list.length });
  }

  // ------------------------------------------------------------------
  // dragSeam, and the end-topology switch (plan v4)
  // ------------------------------------------------------------------

  /**
   * The mitre-bisector normal for an END weld that is NOT on the centreplane,
   * i.e. one that closes the ring through a self-mirroring bridge span.
   *
   * The outgoing chord at such a weld is the one crossing to its own mirror, so
   * it is exactly athwartships. Same construction as the template generator's,
   * which is the point: a weld dragged off the centreplane must land in the
   * same state a template would have written.
   */
  function endBisector(doc, idx) {
    const w = doc.welds[idx];
    const y = w.c[1];
    if (idx === doc.welds.length - 1) {
      const inAxis = V.norm(V.sub(w.c, doc.welds[idx - 1].c));
      const out = [0, y >= 0 ? -1 : 1, 0];
      return V.norm(V.add(inAxis, out));
    }
    const inAxis = [0, y >= 0 ? 1 : -1, 0];
    const out = V.norm(V.sub(doc.welds[idx + 1].c, w.c));
    return V.norm(V.add(inAxis, out));
  }

  /**
   * dragSeam: move and/or tilt one weld's plane.
   *
   * END TOPOLOGY IS WHERE THE DOT SITS (plan v4). On the first or last stored
   * weld of a mirrored document, this op reads the centreplane distance and
   * switches the boat's end topology accordingly:
   *
   *   |y| <= snap   the weld lands ON the mirror line: `onCentreplane`, its
   *                 normal forced athwartships (+y at the head of the stored
   *                 list, -y at the tail -- the two directions ring traversal
   *                 crosses the centreplane), and the derived ring turns AT the
   *                 weld: a POINTED tip, no bridge span.
   *   |y| >  snap   the weld leaves the mirror line: the ring can no longer
   *                 close there, so it closes through the self-mirroring SPAN
   *                 between the weld and its own reflection: a BRIDGED end.
   *                 The normal becomes the mitre bisector, exactly as a
   *                 template generator would have written it.
   *
   * Deterministic (the snapped state is a function of position alone, not of
   * how the pointer got there) and therefore reversible: drag off, drag back,
   * and every field is the one you started with.
   *
   * No flag exists for this anywhere in the engine. `tipPhaseBow`,
   * `endStyleBow`, `capWidth` and friends all dissolve into "where the welds
   * are", which is the whole point of the weld-first model.
   */
  /**
   * The centreplane rule, applied to one weld that has just been moved.
   *
   * Factored out of `dragSeam` because `moldSeam` moves welds too -- including,
   * when the falloff reaches an end of the boat, the very weld whose position IS
   * the end topology. A soft edit that quietly left a tip weld 3 mm off the
   * mirror line would produce a ring that no longer closes there, so both ops
   * settle every weld they touch through this one function.
   *
   * `wasPointed` is the weld's onCentreplane flag BEFORE the move (the topology
   * transition is reported relative to it); `keepNormal` suppresses the
   * mitre-bisector rewrite when the caller supplied a normal of its own.
   *
   * @returns {string|null} the topology transition, for `detail.topology`.
   */
  function settleCentreplane(d, idx, wasPointed, snap, keepNormal) {
    const w = d.welds[idx];
    const isEnd = idx === 0 || idx === d.welds.length - 1;
    if (d.mirror && isEnd) {
      const nowPointed = Math.abs(w.c[1]) <= snap;
      if (nowPointed) {
        w.c[1] = 0;
        w.onCentreplane = true;
        w.n = idx === 0 ? [0, 1, 0] : [0, -1, 0];
        return wasPointed ? 'pointed' : 'bridged->pointed';
      }
      w.onCentreplane = false;
      if (wasPointed && !keepNormal) w.n = endBisector(d, idx);
      return wasPointed ? 'pointed->bridged' : 'bridged';
    }
    if (w.onCentreplane) {
      // An interior weld may not be on the centreplane (the half-ring cannot
      // express a port half that crosses to starboard and back), and a
      // non-mirrored document has no centreplane to speak of. Keep the flag
      // honest rather than silently dragging it around.
      w.c[1] = 0;
      w.n = V.norm([0, w.n[1] < 0 ? -1 : 1, 0]);
    }
    return null;
  }

  function dragSeam(doc, id, patch, opts) {
    const o = opts || {};
    const idx = indexOfId(doc, id);
    const snap = o.snap == null ? SNAP_MM : o.snap;
    const prev = D.clone(doc.welds[idx]);
    const d = D.clone(doc);
    const w = d.welds[idx];
    if (patch && patch.c) w.c = [+patch.c[0], +patch.c[1], +patch.c[2]];
    if (patch && patch.n) w.n = V.norm([+patch.n[0], +patch.n[1], +patch.n[2]]);

    const topology = settleCentreplane(d, idx, prev.onCentreplane, snap,
      !!(patch && patch.n));

    return result('dragSeam', [id, D.clone(patch || {})], doc, d,
      { op: 'restoreWelds', args: [[{ id, weld: prev }]] },
      { topology, index: idx });
  }

  /**
   * RAKE, as a single number a person can type.
   *
   * The document stores a weld's tilt as a unit normal, which is three numbers
   * with a constraint -- correct, and unusable in a numeric field. A designer
   * looking at the SIDE view means one thing by "rake": how far the weld plane
   * leans out of vertical, fore-and-aft. That is exactly the ELEVATION of the
   * normal, `asin(n.z)`, and it is the angle the demo's rake nudge has been
   * turning since B2 (rotating n about the frame's outboard axis v changes the
   * elevation and nothing else).
   *
   * `normalAtRake` is its inverse: same azimuth, new elevation. Round-trips to
   * machine precision, so typing back the number a field shows is a no-op.
   *
   * DEGENERATE CASE, recorded rather than hidden: a normal pointing straight up
   * or down has no azimuth to preserve. `V.frame` already flags exactly this
   * (`degenerate`), and here the azimuth falls back to +x -- fore-and-aft, the
   * only direction a boat has an opinion about.
   */
  function rakeOf(w) {
    return Math.asin(Math.max(-1, Math.min(1, w.n[2])));
  }

  function normalAtRake(w, rake) {
    const h = Math.hypot(w.n[0], w.n[1]);
    const az = h < 1e-9 ? 0 : Math.atan2(w.n[1], w.n[0]);
    const c = Math.cos(rake);
    return [c * Math.cos(az), c * Math.sin(az), Math.sin(rake)];
  }

  // ------------------------------------------------------------------
  // moldSeam -- the soft edit (plan, "Constraint philosophy")
  // ------------------------------------------------------------------

  /**
   * Smoothstep falloff, 1 at the anchor and 0 at the radius, with zero slope at
   * BOTH ends.
   *
   * The zero slope at t = 1 is what makes the edit fair rather than faceted: a
   * linear (tent) falloff leaves a kink in the centreline exactly at the edge of
   * the influence, and a kink in the centreline is a rake discontinuity, which
   * is a visible crease in the loft. w(t) = (1-t)^2 (1+2t) is the cubic Hermite
   * with w(0)=1, w(1)=0, w'(0)=w'(1)=0 -- the cheapest curve that has neither.
   */
  function falloff(t) {
    if (!(t > 0)) return 1;
    if (t >= 1) return 0;
    const s = 1 - t;
    return s * s * (1 + 2 * t);
  }

  /**
   * Who a soft edit at this weld reaches, and how hard.
   *
   * Distance is ARCLENGTH ALONG THE STORED CENTRELINE -- the polyline through
   * the port weld centres, which is the line the user is actually looking at in
   * the ortho panes -- not straight-line distance in space. On a boat with any
   * curvature to it the two differ, and arclength is the one that behaves: it
   * is symmetric fore and aft, it does not leak across the beam of a strongly
   * curved end, and it is measured on the document BEFORE the edit, so the
   * weights are a function of the starting shape and the result does not depend
   * on how many pointer events the mouse happened to deliver.
   *
   * Exported so an editor can PAINT the influence (the plan's "soft selection,
   * like sculpting tools") from the same numbers the op will use.
   *
   * @returns {Array<{id, index, weight, arc}>} every weld, weight in [0, 1].
   */
  function moldWeights(doc, id, radius) {
    const idx = indexOfId(doc, id);
    const n = doc.welds.length;
    const s = new Array(n);
    s[0] = 0;
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + V.dist(doc.welds[i].c, doc.welds[i - 1].c);
    const R = +radius;
    return doc.welds.map((w, i) => {
      const arc = Math.abs(s[i] - s[idx]);
      const weight = !(R > 0) ? (i === idx ? 1 : 0) : falloff(arc / R);
      return { id: w.id, index: i, weight, arc };
    });
  }

  /**
   * moldSeam: ONE drag, MANY dots -- the soft edit the plan calls "molding".
   *
   * "Dragging one weld distributes attenuated deltas to neighbours within a
   * chosen radius (soft selection, like sculpting tools). This is the designed
   * mechanism for subtle, fair deviations from tubular, rather than per-weld
   * jaggedness." (plan, "Constraint philosophy".)
   *
   * The patch is the ANCHOR's new centre, exactly as `dragSeam` takes it, so a
   * UI switches between hard and soft dragging by changing which function it
   * calls. Every other weld gets `weight * delta`, weight by `moldWeights`.
   *
   * ONE INVERSE FOR THE WHOLE MOLDED EDIT (the brief, and the only way undo can
   * mean anything here): the inverse is a single `restoreWelds` carrying the
   * previous records of every weld the falloff touched, so one undo puts the
   * whole shape back byte-for-byte rather than unpicking it dot by dot.
   *
   * `radius <= 0` reduces EXACTLY to `dragSeam` -- same document, byte for byte,
   * including the end-topology switch -- which is what makes the soft radius a
   * continuous setting rather than a mode.
   *
   * Translation only, deliberately. Carrying a NORMAL through a falloff would
   * fight the thing the falloff is for: the neighbours' rakes are already
   * re-implied by their new centres, and blending a tilt on top of that is two
   * shape decisions wearing one handle. Rake stays a per-weld handle
   * (`dragSeam` with an `n`).
   */
  function moldSeam(doc, id, patch, opts) {
    const o = opts || {};
    const idx = indexOfId(doc, id);
    const snap = o.snap == null ? SNAP_MM : o.snap;
    const radius = o.radius == null ? 0 : +o.radius;
    const anchor = doc.welds[idx];
    const target = (patch && patch.c) ? [+patch.c[0], +patch.c[1], +patch.c[2]]
      : anchor.c.slice();
    const delta = V.sub(target, anchor.c);

    const weights = moldWeights(doc, id, radius);
    // A weight of exactly zero must leave the record ALONE -- not add 0 to it.
    // `c[0] + 0` is `c[0]` for every finite double, but -0 + 0 is +0, and a
    // document whose bytes changed is a document whose undo, permalink and
    // changedSegments diff all changed with it.
    const touched = weights.filter((x) => x.weight > 0);

    const prev = snapshot(doc, touched.map((x) => x.id));
    const d = D.clone(doc);
    let topology = null;
    for (const t of touched) {
      const w = d.welds[t.index];
      const was = w.onCentreplane;
      // The ANCHOR takes the target outright rather than c + delta. They differ:
      // `c + (target - c)` is not `target` in floating point (0.1 + (0.3 - 0.1)
      // is 0.29999999999999993), and "radius 0 molds exactly like dragSeam" is a
      // claim about BYTES -- it is what lets an editor swap between the two ops
      // mid-gesture without the undo stack noticing.
      w.c = t.index === idx ? target.slice() : V.add(w.c, V.scale(delta, t.weight));
      const tp = settleCentreplane(d, t.index, was, snap, false);
      if (t.index === idx) topology = tp;
    }

    return result('moldSeam', [id, D.clone(patch || {}), { radius, snap }], doc, d,
      { op: 'restoreWelds', args: [prev] },
      { topology, index: idx, radius, delta,
        touched: touched.map((x) => ({ id: x.id, weight: x.weight, arc: x.arc })) });
  }

  // ------------------------------------------------------------------
  // Handles
  // ------------------------------------------------------------------

  /** setWidth: the side handle. Holds b -- `a` is per-weld and never locked. */
  function setWidth(doc, id, a) {
    const idx = indexOfId(doc, id);
    const prev = D.clone(doc.welds[idx]);
    const d = D.clone(doc);
    d.welds[idx].a = +a;
    return result('setWidth', [id, +a], doc, d,
      { op: 'restoreWelds', args: [[{ id, weld: prev }]] }, { index: idx });
  }

  /**
   * setHeight: the top handle, and the one op the uniform-b LOCK owns.
   *
   * With the lock engaged (the document default) dragging one weld's height
   * drags every locked weld's height with it -- that is what makes deviation
   * from tubular SUBTLE by default. Release the lock and the same drag moves
   * exactly one weld. The lock lives in the document, so it undoes and travels
   * in a permalink (architecture review 7).
   */
  function setHeight(doc, id, b) {
    const idx = indexOfId(doc, id);
    const d = D.clone(doc);
    const touched = d.locks.uniformB ? d.welds.map((w) => w.id) : [id];
    const prev = snapshot(doc, touched);
    for (const wid of touched) d.welds[indexOfId(d, wid)].b = +b;
    return result('setHeight', [id, +b], doc, d,
      { op: 'restoreWelds', args: [prev] },
      { index: idx, locked: !!d.locks.uniformB, welds: touched });
  }

  /** setRoll: spin the (a, b) axes inside the weld plane. */
  function setRoll(doc, id, roll) {
    const idx = indexOfId(doc, id);
    const prev = D.clone(doc.welds[idx]);
    const d = D.clone(doc);
    d.welds[idx].roll = +roll;
    return result('setRoll', [id, +roll], doc, d,
      { op: 'restoreWelds', args: [[{ id, weld: prev }]] }, { index: idx });
  }

  /** setSeamPoint: rotate where the longitudinal seam sits, GEOMETRIC clock. */
  function setSeamPoint(doc, id, clock) {
    const idx = indexOfId(doc, id);
    const prev = D.clone(doc.welds[idx]);
    const d = D.clone(doc);
    d.welds[idx].seam = +clock;
    return result('setSeamPoint', [id, +clock], doc, d,
      { op: 'restoreWelds', args: [[{ id, weld: prev }]] }, { index: idx });
  }

  // ------------------------------------------------------------------
  // editProfile -- B5's whole edit surface
  // ------------------------------------------------------------------

  /**
   * The shared body of `editProfile` and `clearProfile`.
   *
   * One weld record changes, so the inverse is the same `restoreWelds` every
   * other single-record op uses and undo is byte-exact for free -- including
   * the knot count, which a spec-level inverse ("set the profile back to
   * these coefficients") would have had to carry separately.
   */
  function writeProfile(doc, id, profile, opName, args) {
    const idx = indexOfId(doc, id);
    const prev = D.clone(doc.welds[idx]);
    const d = D.clone(doc);
    d.welds[idx].profile = profile;
    const prep = D.profilePrepare(profile);
    const ex = prep ? prep.extent() : null;
    return result(opName, args, doc, d,
      { op: 'restoreWelds', args: [[{ id, weld: prev }]] },
      {
        index: idx,
        knots: profile ? profile.k.length : 0,
        cleared: !profile,
        rMin: ex ? ex.rMin : 1,
        rMax: ex ? ex.rMax : 1,
        stations: D.profileToStations(profile),
      });
  }

  /**
   * editProfile: replace one weld's section deviation.
   *
   * "Adjust a seam's side profile" -- the plan's last base-engine op, and the
   * one the whole weld-first model was arranged to make small. The section is
   * stored as base + deviation (engine/doc.js header), so this op writes ONE
   * field of ONE weld and everything downstream re-derives: the loft picks its
   * branch again, the development integrates the new geodesic curvature, the
   * floor lands on the same seam clock angle it always did (the deviation is
   * radial, so clock angles are untouched), and `changedSegments` names the two
   * panels that moved.
   *
   * `spec` is whatever `doc.profileSpec` understands -- raw coefficients,
   * deviations AT the knot stations (`{at: [...]}`, what a dragged handle
   * sends), a resolution change (`{knots: m}`), or null to clear.
   *
   * WHAT IT DOES NOT DO, deliberately:
   *
   *   - it does not touch {a, b, roll}. The deviation sits ON TOP of them, so
   *     `setWidth`/`setHeight` keep scaling the moulded section as a whole and
   *     the uniform-b lock keeps meaning what it says. A profile is a shape;
   *     a and b are the size.
   *   - it does not propagate under any lock. There is no "uniform profile"
   *     relation, because a moulded section is by definition the thing that is
   *     NOT uniform down the boat; the soft edit (`moldSeam`) is where fairness
   *     between neighbours lives.
   *   - it does not refuse anything. A profile that folds the section through
   *     its own centre is a WARNING from `doc.validate` (carried back in
   *     `issues`), and the export gate is engine/checks.js's developability
   *     measurement on the resulting surface -- not a guess made here about
   *     coefficients.
   */
  function editProfile(doc, id, spec) {
    const idx = indexOfId(doc, id);
    const profile = D.profileSpec(spec, doc.welds[idx].profile);
    return writeProfile(doc, id, profile, 'editProfile',
      [id, spec == null ? null : D.clone(spec)]);
  }

  /** clearProfile: back to the plain {a, b, roll} ellipse. */
  function clearProfile(doc, id) {
    return writeProfile(doc, id, null, 'clearProfile', [id]);
  }

  /**
   * setLock: engage or release an edit-layer relation.
   *
   * Locks are document fields so a shared permalink opens with the AUTHOR's
   * locks, not the recipient's defaults. Engaging uniform-b does NOT flatten
   * the welds -- it changes what the next setHeight means. `doc.validate`
   * reports the spread so the user can see what the next drag will do.
   */
  function setLock(doc, name, value) {
    if (!Object.prototype.hasOwnProperty.call(doc.locks, name)) {
      throw new Error('ops.setLock: no lock named ' + name);
    }
    const prev = D.clone(doc.locks[name]);
    const d = D.clone(doc);
    d.locks[name] = value;
    return result('setLock', [name, value], doc, d,
      { op: 'setLock', args: [name, prev] }, { lock: name });
  }

  // ==================================================================
  // Replay
  // ==================================================================

  const OPS = {
    addSeam, removeSeam, restoreSeam, restoreWelds,
    dragSeam, moldSeam, setWidth, setHeight, setRoll, setSeamPoint, setLock,
    editProfile, clearProfile,
  };

  /**
   * Replay a descriptor. `apply(doc, r.inverse).doc` undoes `r`, exactly --
   * with the single documented exception that `doc.nextId` does not come back
   * down after an addSeam is undone, because ids are never reused
   * (architecture review 5). That is the whole undo stack: two fields per step.
   */
  function apply(doc, descriptor) {
    const fn = OPS[descriptor.op];
    if (!fn) throw new Error('ops.apply: no op named ' + descriptor.op);
    return fn.apply(null, [doc].concat(descriptor.args || []));
  }

  const api = {
    SNAP_MM, OPS, apply, diffSegments, ringKeys, weldKey,
    slerpUnit, momentEllipse, sectionWeld, radialResidual, seamClockAt, endBisector,
    settleCentreplane, falloff, moldWeights, rakeOf, normalAtRake,
    resampleK, lerpProfile,
    addSeam, removeSeam, restoreSeam, restoreWelds,
    dragSeam, moldSeam, setWidth, setHeight, setRoll, setSeamPoint, setLock,
    editProfile, clearProfile,
  };

  E.ops = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
