/**
 * Skeleton construction (spec §3.3, §3.4, §3.4b):
 * curves -> per-side station chain -> optimal joint placement -> mirror ->
 * tip closure per tipPhase -> one closed frustum chain.
 *
 * ---------------------------------------------------------------------------
 * THE MITRE CONSTRUCTION -- a correction to §3.3, worth reading before editing
 * ---------------------------------------------------------------------------
 * §3.3 says "the mitre plane bisects the angle between adjacent segments".
 * That is exactly right when both segments are cylinders or share a taper, but
 * it does NOT close the hull when the tapers differ. Two cones of different
 * half-angle, cut by the plane that bisects their axes, produce two DIFFERENT
 * conics -- the panels do not butt, and the mated-edge mismatch runs to
 * millimetres at a 40 deg tip joint. That would fail the §2b tolerance table
 * by two orders of magnitude.
 *
 * The classical fix (Monge: two quadrics inscribed in a common sphere meet in
 * two plane conics) is to hang a SPHERE at each joint and make every frustum
 * the common tangent cone of the two spheres at its ends. Then:
 *
 *     sin(alpha) = (rho_start - rho_end) / L        <- the frustum half-angle
 *     R_perp     = rho / cos(alpha)                 <- perpendicular radius
 *
 * and consecutive cones, both tangent to the shared sphere, intersect in a
 * single plane conic. That conic's plane is the true mitre plane. It reduces
 * to the bisecting plane through the joint whenever alpha_A = -alpha_B (both
 * tips, by symmetry) and to a bisector-normal plane offset by rho*sin(alpha)
 * when the tapers match. So this generalises §3.3 rather than contradicting
 * it, and it is what makes G0.6 achievable at all.
 *
 * Consequence for the curves: r(t) from §3.2 is read as the INSCRIBED SPHERE
 * radius at each joint. The tube's perpendicular radius there is rho/cos(alpha),
 * at most 3% larger given the §3.2 taper-rate ceiling of 0.25.
 */
;(function (root) {
  'use strict';
  if (typeof require === 'function') {
    require('./vec3.js');
    require('./constants.js');
    require('./curves.js');
  }
  const P = root.Packraft || (root.Packraft = {});
  const V = P.vec3;
  const C = P.constants;
  const CURVES = P.curves;

  // =========================================================================
  // THE MIRROR (spec §3.4b, §7.7)
  //
  // Port geometry is authoritative; starboard is its reflection in y = 0.
  // This is the ONLY place the skeleton reflects anything. `panels` (Phase 2)
  // performs the panel-level mirror and must call through here, not
  // reimplement it, so that an asymmetric mode later has exactly one seam to
  // unpick.
  // =========================================================================
  function mirrorNode(node) {
    return { p: V.mirrorY(node.p), rho: node.rho, t: node.t, side: 'starboard' };
  }

  /**
   * Optimal joint placement (§3.3): choose the interior joint positions that
   * minimise the MAXIMUM deviation of the faceted chain from the designed
   * centreline. Exact, by dynamic programming over the sample grid -- not
   * constant arc length, not constant turning angle.
   *
   * The port curve is divided into `budget` pieces by `budget - 1` interior
   * joints. What happens at the two ends depends on tipPhase:
   *
   *   seam-on-axis   the first piece runs from the tip sample itself, so a
   *                  mitre plane lands ON the centreplane and L1 butts R1.
   *   panel-on-axis  the first piece is the port half of a segment that
   *                  STRADDLES the centreplane, so it is costed against the
   *                  athwartships chord from mirror(P_j) to P_j -- which is
   *                  what truncates the designed tip, and is exactly the
   *                  deviation the min-max objective must see.
   *
   * Both tips carry the same interior joint count, so panel-on-axis yields two
   * fewer segments (and two fewer seams) around the loop, per §3.4.
   *
   * @returns {{joints: number[], deviation: number}} sample indices, mm
   */
  function placeJoints(samples, budget, tipPhaseBow, tipPhaseStern, opts) {
    const K = samples.length - 1;
    const pieces = budget;
    if (pieces < 2) throw new Error('placeJoints: budget must be >= 2');
    if (pieces - 1 > K - 1) throw new Error('placeJoints: not enough samples for the budget');

    // Joints are CHOSEN on a decimated grid but every partition is SCORED
    // against all samples, so the reported deviation stays exact and
    // chainDeviation() reproduces it. Only the search is coarsened. The cost
    // matrix is O(K^3 / stride^2), which is the whole regenerate budget at
    // stride 1 and a few ms at stride 2.
    const stride = Math.max(1, (opts && opts.stride) || C.JOINT_DP_STRIDE);

    // Single-section ends (§3.5, and every DIY build photograph): no interior
    // joint may land strictly inside an excluded end region, so the whole
    // region is one elongated frustum from the tip to wherever the DP puts the
    // first joint at or beyond the region boundary. The tip-piece cost still
    // scores that long chord against every sample it spans, so the deviation a
    // single cone costs against a curvy end design is reported, not hidden.
    // Ranges are [lo, hi] pairs; candidates strictly inside a range are
    // dropped, the boundaries stay reachable. The old excludeBefore/After
    // form maps onto them; the ring path needs true ranges because a
    // single-piece end must exclude only the SIDE part of the end region
    // while leaving the turn free to take fanned seams.
    const ranges = ((opts && opts.excludeRanges) || []).slice();
    if (opts && opts.excludeBefore) ranges.push([0, opts.excludeBefore]);
    if (opts && opts.excludeAfter != null && opts.excludeAfter < K) ranges.push([opts.excludeAfter, K]);
    const excluded = (i) => ranges.some(([lo, hi]) => i > lo && i < hi);
    const candSet = new Set([0, K]);
    for (let i = 0; i <= K; i += stride) {
      if (!excluded(i)) candSet.add(i);
    }
    // Range boundaries themselves must be reachable exactly.
    for (const [lo, hi] of ranges) {
      if (lo > 0) candSet.add(lo);
      if (hi < K) candSet.add(hi);
    }
    const cand = Array.from(candSet).sort((a, b) => a - b);
    const M = cand.length - 1;
    if (pieces - 1 > M - 1) throw new Error('placeJoints: stride too coarse for the budget');

    // Flat coordinates for the hot loop.
    const xyz = new Float64Array(3 * (K + 1));
    for (let i = 0; i <= K; i++) {
      xyz[3 * i] = samples[i].p[0];
      xyz[3 * i + 1] = samples[i].p[1];
      xyz[3 * i + 2] = samples[i].p[2];
    }

    function segDist(s, ax, ay, az, bx, by, bz) {
      const px = xyz[3 * s], py = xyz[3 * s + 1], pz = xyz[3 * s + 2];
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const l2 = abx * abx + aby * aby + abz * abz;
      let u = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2 : 0;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      const dx = px - (ax + abx * u), dy = py - (ay + aby * u), dz = pz - (az + abz * u);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /** Max deviation of samples i..j from the chord P_i -> P_j. */
    function chordCost(i, j) {
      const ax = xyz[3 * i], ay = xyz[3 * i + 1], az = xyz[3 * i + 2];
      const bx = xyz[3 * j], by = xyz[3 * j + 1], bz = xyz[3 * j + 2];
      let m = 0;
      for (let s = i + 1; s < j; s++) {
        const d = segDist(s, ax, ay, az, bx, by, bz);
        if (d > m) m = d;
      }
      return m;
    }

    /**
     * Max deviation of samples 0..j (bow) or i..K (stern) from the
     * athwartships chord of a straddling tip segment, which runs from
     * mirror(P_j) to P_j. Only y flips, so the chord is the y-interval at
     * fixed (x, z).
     */
    function spanCost(edge, lo, hi) {
      const ax = xyz[3 * edge], ay = -xyz[3 * edge + 1], az = xyz[3 * edge + 2];
      const bx = xyz[3 * edge], by = xyz[3 * edge + 1], bz = xyz[3 * edge + 2];
      let m = 0;
      for (let s = lo; s <= hi; s++) {
        const d = segDist(s, ax, ay, az, bx, by, bz);
        if (d > m) m = d;
      }
      return m;
    }

    // All costs below take CANDIDATE indices and score against every sample
    // in the spanned range.
    const firstCost = tipPhaseBow === 'panel-on-axis'
      ? (b) => spanCost(cand[b], 0, cand[b] - 1)
      : (b) => chordCost(0, cand[b]);
    const lastCost = tipPhaseStern === 'panel-on-axis'
      ? (a) => spanCost(cand[a], cand[a] + 1, K)
      : (a) => chordCost(cand[a], K);

    const row = M + 1;
    const cost = new Float64Array(row * row);
    for (let a = 0; a <= M; a++) {
      for (let b = a + 1; b <= M; b++) cost[a * row + b] = chordCost(cand[a], cand[b]);
    }

    const INF = Infinity;
    // Minimum pieces separation, in candidate steps. Keeps zero-length
    // segments out of the search; real buildability is checked in
    // buildSkeleton against the §3.4 rule, which this cannot express.
    const GAP = 1;
    // f[m][b]: best achievable max-deviation using m pieces to cover 0..cand[b].
    //
    // TIE-BREAK: the min-max objective is flat wherever one piece's deviation
    // dominates -- every partition of the remaining straight-ish run scores
    // the same. The plain backtrack then picks the earliest tie, which can
    // put two joints a few samples apart (seen: a 22 mm sliver next to a
    // pinned end-region boundary). Among equal-deviation partitions, prefer
    // the one whose SHORTEST piece is longest, tracked lexicographically.
    const TIE = 1e-9;
    let prev = new Float64Array(row).fill(INF);
    let prevLen = new Float64Array(row).fill(0);
    const back = [null];
    for (let b = GAP; b <= M - GAP * (pieces - 1); b++) {
      prev[b] = firstCost(b);
      prevLen[b] = cand[b];
    }

    for (let m = 2; m <= pieces; m++) {
      const cur = new Float64Array(row).fill(INF);
      const curLen = new Float64Array(row).fill(0);
      const from = new Int32Array(row).fill(-1);
      const isLast = (m === pieces);
      const bLo = isLast ? M : GAP * m;
      const bHi = isLast ? M : M - GAP * (pieces - m);
      for (let b = bLo; b <= bHi; b++) {
        let best = INF, bestLen = -1, bestA = -1;
        for (let a = GAP * (m - 1); a <= b - GAP; a++) {
          const f = prev[a];
          if (f === INF) continue;
          const c = isLast ? lastCost(a) : cost[a * row + b];
          const v = f > c ? f : c;
          const pieceLen = (isLast ? K : cand[b]) - cand[a];
          const minLen = prevLen[a] < pieceLen ? prevLen[a] : pieceLen;
          if (v < best - TIE || (v <= best + TIE && minLen > bestLen)) {
            best = v; bestLen = minLen; bestA = a;
          }
        }
        cur[b] = best;
        curLen[b] = bestLen;
        from[b] = bestA;
      }
      prev = cur;
      prevLen = curLen;
      back.push(from);
    }

    // Walk the backpointers to recover the interior joints, mapping candidate
    // indices back to sample indices.
    const joints = [];
    let b = M;
    for (let m = pieces; m >= 2; m--) {
      const a = back[m - 1][b];
      if (a < 0) throw new Error('placeJoints: no feasible partition');
      joints.push(cand[a]);
      b = a;
    }
    joints.reverse();
    return { joints, deviation: prev[M] };
  }

  /**
   * Max deviation of a faceted chain from the designed centreline, in mm
   * (§3.3, §5.7b: the only metric that justifies spending another seam).
   * Same cost model as placeJoints, exposed so any joint set can be scored --
   * which is what makes "optimal beats evenly-spaced" a testable claim.
   */
  function chainDeviation(samples, jointIdx, tipPhaseBow, tipPhaseStern) {
    const K = samples.length - 1;
    const bounds = [0].concat(jointIdx, [K]);
    let worst = 0;
    for (let k = 0; k < bounds.length - 1; k++) {
      const i = bounds[k], j = bounds[k + 1];
      const first = k === 0, last = k === bounds.length - 2;
      let a, b, lo, hi;
      if (first && tipPhaseBow === 'panel-on-axis') {
        a = V.mirrorY(samples[j].p); b = samples[j].p; lo = 0; hi = j - 1;
      } else if (last && tipPhaseStern === 'panel-on-axis') {
        a = samples[i].p; b = V.mirrorY(samples[i].p); lo = i + 1; hi = K;
      } else {
        a = samples[i].p; b = samples[j].p; lo = i + 1; hi = j - 1;
      }
      for (let s = lo; s <= hi; s++) {
        const d = V.distToSegment(samples[s].p, a, b);
        if (d > worst) worst = d;
      }
    }
    return worst;
  }

  /**
   * Frustum between two joint spheres: the common tangent cone.
   * @param {{p:number[], rho:number}} a start node
   * @param {{p:number[], rho:number}} b end node
   */
  function makeFrustum(a, b) {
    const d = V.sub(b.p, a.p);
    const L = V.len(d);
    const dRho = a.rho - b.rho;
    if (L <= Math.abs(dRho)) {
      throw new Error(`makeFrustum: segment length ${L.toFixed(2)} mm cannot span a radius change of ${Math.abs(dRho).toFixed(2)} mm -- no tangent cone exists`);
    }
    const axis = V.scale(d, 1 / L);
    const alpha = Math.asin(dRho / L); // signed: >0 narrows along travel
    const cosA = Math.cos(alpha);
    return {
      A: a.p, B: b.p, axis, length: L,
      rhoA: a.rho, rhoB: b.rho,
      alpha,
      RA: a.rho / cosA,   // perpendicular radius at A
      RB: b.rho / cosA,   // perpendicular radius at B
      frame: V.frame(axis),
    };
  }

  /**
   * The mitre plane at a joint, from the two adjacent tangent cones.
   * See the header note. `rho` is the joint's inscribed sphere radius.
   *
   * In the plane containing both axes, the two cones' matching extreme
   * generators cross at two points; those points, plus the direction normal to
   * that plane, define the intersection conic's plane.
   */
  function mitrePlane(node, inc, out) {
    const aA = inc.axis, aB = out.axis;
    const phi = V.angleBetween(aA, aB);
    const bHat = V.norm(V.add(aA, aB));
    let hHat;
    try {
      hHat = V.norm(V.sub(aB, aA));
    } catch (e) {
      // Collinear axes: the plane is normal to bHat and hHat drops out.
      const f = V.frame(bHat);
      hHat = f.u;
    }
    const beta = (inc.alpha + out.alpha) / 2;
    const delta = (out.alpha - inc.alpha) / 2;
    const rho = node.rho;

    // The construction locates the mitre plane from where the two cones'
    // matching extreme generators cross. Those crossings only exist on the
    // physical nappes while both half-angles below stay inside a quarter
    // turn; past that the cones diverge instead of meeting and there is no
    // plane conic to find. Without this guard the formula still returns a
    // plane -- a meaningless one, off by metres, with no complaint. Not
    // reachable from the synthesised curves (worst measured joint is ~70 deg
    // against a 90 deg limit) but mitrePlane is public API and hand-edited
    // curves (L2, Phase 5) move toward it.
    const cLo = Math.cos(phi / 2 - delta);
    const cHi = Math.cos(phi / 2 + delta);
    if (cLo <= 1e-9 || cHi <= 1e-9) {
      throw new Error(
        `mitrePlane: joint turns ${(phi * 180 / Math.PI).toFixed(1)} deg with half-angles `
        + `${(inc.alpha * 180 / Math.PI).toFixed(1)}/${(out.alpha * 180 / Math.PI).toFixed(1)} deg -- `
        + 'the adjacent cones no longer intersect in an ellipse, so no mitre plane exists. '
        + 'Reduce the turn at this joint or the taper either side of it (§3.4).');
    }

    const lambda = rho / cLo;
    const mu = rho / cHi;

    const normal = V.norm(V.sub(
      V.scale(bHat, (lambda + mu) * Math.cos(beta)),
      V.scale(hHat, (lambda - mu) * Math.sin(beta)),
    ));
    const point = V.add(node.p, V.add(
      V.scale(bHat, lambda * Math.sin(beta)),
      V.scale(hHat, lambda * Math.cos(beta)),
    ));
    return { normal, point, turn: phi, lambda, mu, beta, delta };
  }

  /**
   * Build the closed skeleton for a derived params object.
   * @returns {{nodes, segments, joints, deviation, totalTurn, issues}}
   */
  function buildSkeleton(params, opts) {
    const pr = params.primary;
    const cn = params.construction;
    const hc = CURVES.hullCurves(params.curves, pr.loa);
    // THE RING PATH: turns included. Joint placement runs over the whole
    // half-ring, so seams fan around the turns and stretch down the sides on
    // their own -- see curves.ringPath for the model rethink this encodes.
    // A capped end is BRIDGED under panel-on-axis (a straddling tube spans
    // the terminus) and WRAPPED under seam-on-axis (the ring curls around).
    const bridgeBow = cn.tipPhaseBow === 'panel-on-axis' && (pr.bowCapWidth || 0) > 0;
    const bridgeStern = cn.tipPhaseStern === 'panel-on-axis' && (pr.sternCapWidth || 0) > 0;
    const ring = CURVES.ringPath(hc, {
      sideSamples: C.SIDE_SAMPLES,
      wrapBow: !bridgeBow, wrapStern: !bridgeStern,
    });
    const samples = ring.samples;
    const K = samples.length - 1;
    const sideN = C.SIDE_SAMPLES;

    // opts.joints forces an explicit interior joint set instead of running the
    // DP. Exists so alternative placements can be scored against the optimal
    // one from outside this module -- the buildability/deviation trade-off the
    // min-max objective cannot express (§3.4 is a check, not a constraint).
    // 'single' end style keeps girth seams out of the SIDE part of that end
    // region; the turn stays free to take fanned seams, which is where a
    // wrapped end genuinely needs them. 'auto' (default) lets the DP spend
    // seams anywhere.
    const dpOpts = { excludeRanges: [] };
    // Keep SLIVERS out of a wrapped turn. The min-max objective is happy to
    // park a joint a few samples from the apex: deviation barely moves, but
    // the resulting 40 mm piece cannot survive its own mitre cuts (it needs
    // 2*rho*tan(turn/2), over 100 mm on a fat tube). Reserving the inner
    // half of each turn for the apex piece fixes it for both tip phases --
    // the straddling tube for panel-on-axis, the two halves meeting on the
    // centreplane for seam-on-axis.
    const APEX = 0.5;
    if (ring.bowTurnEnd > 0) {
      dpOpts.excludeRanges.push([0, Math.max(1, Math.round(ring.bowTurnEnd * APEX))]);
    }
    if (ring.sternTurnStart < K) {
      dpOpts.excludeRanges.push([K - Math.max(1, Math.round((K - ring.sternTurnStart) * APEX)), K]);
    }
    if (cn.endStyleBow === 'single') {
      dpOpts.excludeRanges.push([ring.bowTurnEnd, ring.bowTurnEnd + Math.round(pr.bowLengthFrac * sideN)]);
    }
    if (cn.endStyleStern === 'single') {
      dpOpts.excludeRanges.push([ring.bowTurnEnd + Math.round((1 - pr.sternLengthFrac) * sideN), ring.sternTurnStart]);
    }

    const forced = opts && opts.joints;
    const placed = forced
      ? { joints: forced.slice(), deviation: chainDeviation(samples, forced, cn.tipPhaseBow, cn.tipPhaseStern) }
      : placeJoints(samples, cn.segmentBudget,
        bridgeBow ? 'seam-on-axis' : cn.tipPhaseBow,
        bridgeStern ? 'seam-on-axis' : cn.tipPhaseStern, dpOpts);
    const jointIdx = placed.joints;

    const portNode = (i) => ({
      p: samples[i].p, rho: samples[i].r, t: samples[i].t, side: 'port',
    });

    // Nodes in traversal order around the ring: bow -> port -> stern ->
    // starboard -> back to bow. Segments join consecutive nodes cyclically.
    // With the turns inside the sampled path, both tip closures work at both
    // pointed and wrapped ends and no other assembly exists: sample 0 IS the
    // bow apex on the centreplane, sample K the stern apex.
    const nodes = [];
    if (bridgeBow) {
      // The terminus and its mirror both enter the ring; the closing segment
      // between them IS the bridge tube.
      nodes.push(Object.assign(portNode(0), { tip: 'bow' }));
    } else if (cn.tipPhaseBow === 'seam-on-axis') {
      nodes.push(Object.assign(portNode(0), { side: 'centreplane', tip: 'bow' }));
    }
    for (const i of jointIdx) nodes.push(portNode(i));
    if (bridgeStern) {
      nodes.push(Object.assign(portNode(K), { tip: 'stern' }));
      nodes.push(Object.assign(mirrorNode(portNode(K)), { tip: 'stern' }));
    } else if (cn.tipPhaseStern === 'seam-on-axis') {
      nodes.push(Object.assign(portNode(K), { side: 'centreplane', tip: 'stern' }));
    }
    for (let k = jointIdx.length - 1; k >= 0; k--) nodes.push(mirrorNode(portNode(jointIdx[k])));
    if (bridgeBow) nodes.push(Object.assign(mirrorNode(portNode(0)), { tip: 'bow' }));

    const n = nodes.length;
    const segments = [];
    for (let i = 0; i < n; i++) {
      const a = nodes[i], b = nodes[(i + 1) % n];
      const seg = makeFrustum(a, b);
      seg.startNode = i;
      seg.endNode = (i + 1) % n;
      segments.push(seg);
    }

    // Mitre planes: node i sits between segment i-1 (incoming) and i (outgoing).
    for (let i = 0; i < n; i++) {
      const inc = segments[(i - 1 + n) % n];
      const out = segments[i];
      const plane = mitrePlane(nodes[i], inc, out);
      nodes[i].plane = plane;
      nodes[i].turn = plane.turn;
      out.planeStart = plane;
      inc.planeEnd = plane;
    }

    classify(segments, nodes, cn);

    // §3.4 buildability: a segment must survive the oblique cuts at both ends.
    const issues = [];
    let totalTurn = 0;
    for (const nd of nodes) totalTurn += nd.turn;
    for (const seg of segments) {
      const phiA = nodes[seg.startNode].turn;
      const phiB = nodes[seg.endNode].turn;
      const need = seg.rhoA * Math.tan(phiA / 2) + seg.rhoB * Math.tan(phiB / 2);
      seg.minLength = need;
      seg.buildable = seg.length > need;
      if (!seg.buildable) {
        issues.push({
          level: 'error', code: 'buildability', field: 'construction.segmentBudget',
          message: `Segment ${seg.id} is ${seg.length.toFixed(0)} mm long but its end cuts consume ${need.toFixed(0)} mm (§3.4). Spend another segment, widen the end turn (cap width), or thin the tube there (taper).`,
        });
      }
    }
    if (placed.deviation > C.OUTLINE_DEVIATION_SUGGEST) {
      const pinned = cn.endStyleBow === 'single' || cn.endStyleStern === 'single';
      issues.push({
        level: 'warn', code: 'outline-deviation', field: 'construction.segmentBudget',
        message: `Faceted chain deviates up to ${placed.deviation.toFixed(1)} mm from the designed centreline, above the ${C.OUTLINE_DEVIATION_SUGGEST} mm threshold -- `
          + (pinned
            ? 'note that with single-piece ends extra segments only help the midbody; if the deviation lives in an end, it is the cost of building that end as one straight cone, and the levers are its taper and fullness (or allowing seams there).'
            : 'consider spending another segment.'),
      });
    }

    return {
      hullCurves: hc, samples, nodes, segments,
      joints: jointIdx, deviation: placed.deviation,
      totalTurn, issues,
    };
  }

  /** Part IDs (§8.6): L1..Ln / R1..Rn fore to aft, BOW / STERN unsided. */
  function classify(segments, nodes, cn) {
    let portCount = 0;
    for (const seg of segments) {
      const a = nodes[seg.startNode], b = nodes[seg.endNode];
      const spansCentreplane = (a.p[1] < 0 && b.p[1] > 0) || (a.p[1] > 0 && b.p[1] < 0);
      if (spansCentreplane) {
        seg.role = 'span';
        seg.id = b.p[1] > 0 ? 'BOW' : 'STERN';
        seg.selfMirroring = true;
      } else if (a.p[1] >= 0 && b.p[1] >= 0) {
        seg.role = 'port';
        seg.id = 'L' + (++portCount);
        seg.selfMirroring = false;
      } else {
        seg.role = 'starboard';
        seg.selfMirroring = false;
      }
    }
    // Starboard IDs mirror port IDs, numbered fore to aft on their own side.
    const stb = segments.filter((s) => s.role === 'starboard');
    for (let i = 0; i < stb.length; i++) stb[i].id = 'R' + (stb.length - i);
    return segments;
  }

  const api = {
    placeJoints, chainDeviation, makeFrustum, mitrePlane, buildSkeleton, mirrorNode,
  };

  P.skeleton = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
