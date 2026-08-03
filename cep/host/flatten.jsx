/*
 * Cubic bezier -> polyline, by adaptive subdivision.
 *
 * The cutter only understands straight moves at a resolution of 1/20 mm, so
 * curves have to be flattened somewhere. Doing it here rather than in the helper
 * keeps the wire format a plain list of points and avoids shipping a bezier
 * implementation on both sides.
 *
 * ExtendScript is ES3: no const/let, no Array.prototype.map, no JSON.
 */

/* global CameoFlatten:true */
var CameoFlatten = (function () {
  "use strict";

  // Illustrator works in points; the driver wants mm.
  var MM_PER_POINT = 25.4 / 72.0;

  // Subdivision is halving, so depth 16 is a 65536x reduction in segment
  // length. Anything still not flat by then is pathological and would only
  // cost time.
  var MAX_DEPTH = 16;

  function toMillimetres(pt) {
    return [pt[0] * MM_PER_POINT, pt[1] * MM_PER_POINT];
  }

  /*
   * Flatness test: the sum of the control points' distances from the chord.
   *
   * Compared squared to avoid a sqrt per test. When the chord is degenerate
   * (the curve starts and ends at the same point, e.g. a closed teardrop) the
   * cross-product test collapses to zero and would wrongly report "flat", so
   * that case falls back to measuring the control arms directly.
   */
  function isFlat(p0, p1, p2, p3, tolerance) {
    var dx = p3[0] - p0[0];
    var dy = p3[1] - p0[1];
    var chordSq = dx * dx + dy * dy;

    if (chordSq < 1e-12) {
      var a1 = (p1[0] - p0[0]) * (p1[0] - p0[0]) + (p1[1] - p0[1]) * (p1[1] - p0[1]);
      var a2 = (p2[0] - p0[0]) * (p2[0] - p0[0]) + (p2[1] - p0[1]) * (p2[1] - p0[1]);
      var maxArm = a1 > a2 ? a1 : a2;
      return maxArm <= tolerance * tolerance;
    }

    var d1 = Math.abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx);
    var d2 = Math.abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx);
    var sum = d1 + d2;

    return sum * sum <= tolerance * tolerance * chordSq;
  }

  function midpoint(a, b) {
    return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
  }

  /*
   * de Casteljau subdivision. Appends every point after p0, so the caller is
   * responsible for having already emitted the start of the curve.
   */
  function subdivide(p0, p1, p2, p3, tolerance, out, depth) {
    if (depth >= MAX_DEPTH || isFlat(p0, p1, p2, p3, tolerance)) {
      out.push(p3);
      return;
    }

    var p01 = midpoint(p0, p1);
    var p12 = midpoint(p1, p2);
    var p23 = midpoint(p2, p3);
    var p012 = midpoint(p01, p12);
    var p123 = midpoint(p12, p23);
    var mid = midpoint(p012, p123);

    subdivide(p0, p01, p012, mid, tolerance, out, depth + 1);
    subdivide(mid, p123, p23, p3, tolerance, out, depth + 1);
  }

  /*
   * Flatten one cubic segment into `out`.
   *
   * A segment whose handles both sit on their anchors is a straight line, and
   * emitting the endpoint directly avoids pointless recursion — which matters,
   * because most artwork is mostly straight lines.
   */
  function flattenSegment(p0, c0, c1, p3, tolerance, out) {
    var straight =
      p0[0] === c0[0] && p0[1] === c0[1] &&
      p3[0] === c1[0] && p3[1] === c1[1];

    if (straight) {
      out.push(p3);
      return;
    }

    subdivide(p0, c0, c1, p3, tolerance, out, 0);
  }

  return {
    MM_PER_POINT: MM_PER_POINT,
    toMillimetres: toMillimetres,
    isFlat: isFlat,
    flattenSegment: flattenSegment
  };
})();
