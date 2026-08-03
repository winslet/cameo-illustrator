/*
 * Tests for the ExtendScript geometry code, run under Node.
 *
 * flatten.jsx and extract.jsx are plain ES3 that only touch Illustrator's DOM
 * inside functions, so their module bodies load fine outside Illustrator. That
 * lets the maths — which is where the real bugs live — be tested without
 * launching the app.
 *
 *   node --test cep/test/
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const HOST_DIR = path.join(__dirname, "..", "host");

/*
 * Load the .jsx modules into *this* realm.
 *
 * Deliberately not vm.createContext: a separate realm has its own Array, so
 * arrays the modules build would fail deepStrictEqual against ordinary ones.
 * Each file declares `var Cameo*`, which is function-scoped here, so the
 * wrapper returns them explicitly.
 */
function loadHostModules() {
  const sources = ["flatten.jsx", "extract.jsx"]
    .map((file) => fs.readFileSync(path.join(HOST_DIR, file), "utf8"))
    .join("\n");

  return new Function(
    sources + "\nreturn { CameoFlatten: CameoFlatten, CameoExtract: CameoExtract };"
  )();
}

const { CameoFlatten, CameoExtract } = loadHostModules();

// -- helpers ---------------------------------------------------------------

function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]
  ];
}

/** Distance from point p to segment ab. */
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Worst-case distance from the true curve to the flattened polyline. */
function maxDeviation(p0, p1, p2, p3, polyline, samples = 2000) {
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const point = cubicAt(p0, p1, p2, p3, i / samples);
    let nearest = Infinity;
    for (let j = 0; j < polyline.length - 1; j++) {
      nearest = Math.min(nearest, distanceToSegment(point, polyline[j], polyline[j + 1]));
    }
    worst = Math.max(worst, nearest);
  }
  return worst;
}

function flatten(p0, c0, c1, p3, tolerance) {
  const out = [p0];
  CameoFlatten.flattenSegment(p0, c0, c1, p3, tolerance, out);
  return out;
}

// -- flattening accuracy ---------------------------------------------------

test("a straight segment emits no intermediate points", () => {
  const out = flatten([0, 0], [0, 0], [10, 0], [10, 0], 0.05);
  assert.deepStrictEqual(out, [[0, 0], [10, 0]]);
});

test("a collinear curve stays within tolerance", () => {
  const out = flatten([0, 0], [3, 0], [7, 0], [10, 0], 0.05);
  assert.ok(out.length >= 2);
  assert.ok(maxDeviation([0, 0], [3, 0], [7, 0], [10, 0], out) <= 0.05);
});

test("a quarter circle stays within tolerance", () => {
  // Standard cubic approximation of a 90-degree arc, radius 50mm.
  const k = 0.5522847498;
  const p0 = [50, 0];
  const c0 = [50, 50 * k];
  const c1 = [50 * k, 50];
  const p3 = [0, 50];

  const out = flatten(p0, c0, c1, p3, 0.05);
  assert.ok(maxDeviation(p0, c0, c1, p3, out) <= 0.05,
    "flattened arc deviates more than the requested tolerance");
});

test("tighter tolerance produces more points and less error", () => {
  const p0 = [0, 0], c0 = [0, 60], c1 = [60, 60], p3 = [60, 0];

  const coarse = flatten(p0, c0, c1, p3, 0.5);
  const fine = flatten(p0, c0, c1, p3, 0.01);

  assert.ok(fine.length > coarse.length);
  assert.ok(maxDeviation(p0, c0, c1, p3, fine) < maxDeviation(p0, c0, c1, p3, coarse));
  assert.ok(maxDeviation(p0, c0, c1, p3, fine) <= 0.01);
});

test("an S-curve with an inflection stays within tolerance", () => {
  const p0 = [0, 0], c0 = [40, 40], c1 = [-40, 40], p3 = [0, 80];
  const out = flatten(p0, c0, c1, p3, 0.05);
  assert.ok(maxDeviation(p0, c0, c1, p3, out) <= 0.05);
});

test("a degenerate loop returning to its start is not called flat", () => {
  // p0 === p3 collapses the chord, which a naive cross-product test reports as
  // flat, silently turning a teardrop into a zero-length line.
  const p0 = [0, 0], c0 = [30, 30], c1 = [-30, 30], p3 = [0, 0];
  const out = flatten(p0, c0, c1, p3, 0.05);

  assert.ok(out.length > 2, "degenerate loop collapsed to a straight line");
  const ys = out.map((p) => p[1]);
  assert.ok(Math.max(...ys) > 10, "the loop lost its extent");
});

test("a cusp is handled without runaway subdivision", () => {
  const p0 = [0, 0], c0 = [60, 0], c1 = [0, 0], p3 = [60, 0];
  const out = flatten(p0, c0, c1, p3, 0.05);
  assert.ok(out.length < 5000, "subdivision did not terminate sensibly");
});

test("points convert from points to millimetres", () => {
  const [x, y] = CameoFlatten.toMillimetres([72, 144]);
  assert.ok(Math.abs(x - 25.4) < 1e-9);
  assert.ok(Math.abs(y - 50.8) < 1e-9);
});

// -- coordinate mapping ----------------------------------------------------

test("artboard mapping puts the origin at the top-left, y down", () => {
  // A4 at 72dpi: 595.28 x 841.89 points. Illustrator's y increases upward, so
  // artboardRect is [left, top, right, bottom] with top > bottom.
  const rect = [0, 0, 595.28, -841.89];
  const map = CameoExtract.makeMapper(rect);

  const topLeft = map([0, 0]);
  assert.ok(Math.abs(topLeft[0]) < 1e-9);
  assert.ok(Math.abs(topLeft[1]) < 1e-9);

  const bottomRight = map([595.28, -841.89]);
  assert.ok(Math.abs(bottomRight[0] - 210) < 0.01, "width should be ~210mm");
  assert.ok(Math.abs(bottomRight[1] - 297) < 0.01, "height should be ~297mm");
});

test("mapping is relative to the artboard, not the canvas origin", () => {
  // A second artboard offset to the right and down.
  const rect = [1000, -500, 1595.28, -1341.89];
  const map = CameoExtract.makeMapper(rect);

  const topLeft = map([1000, -500]);
  assert.ok(Math.abs(topLeft[0]) < 1e-9);
  assert.ok(Math.abs(topLeft[1]) < 1e-9);
});

test("y increases downward", () => {
  const map = CameoExtract.makeMapper([0, 0, 595.28, -841.89]);
  const upper = map([0, -100]);
  const lower = map([0, -200]);
  assert.ok(lower[1] > upper[1], "a point lower on the artboard must have a larger y");
});

// -- hidden and locked containers ------------------------------------------

/*
 * Illustrator does not push a layer's state down onto its children: a path on
 * a hidden layer still reports hidden === false. Confirmed empirically — a
 * document with art on a hidden layer and a locked layer extracted all three
 * paths before this was fixed, so hidden artwork would have been cut.
 *
 * Mock nodes here mirror the shape of the real DOM: layers carry `visible`,
 * page items carry `hidden`, and both carry `locked`.
 */
function doc() {
  return { typename: "Document" };
}
function layer(props, parent) {
  return Object.assign({ typename: "Layer", visible: true, locked: false,
                         parent: parent || doc() }, props);
}
function group(props, parent) {
  return Object.assign({ typename: "GroupItem", hidden: false, locked: false,
                         parent: parent || doc() }, props);
}
function pathItem(parent) {
  return { typename: "PathItem", hidden: false, locked: false, parent: parent };
}

test("art on a visible unlocked layer is collected", () => {
  assert.strictEqual(
    CameoExtract.inHiddenOrLockedContainer(pathItem(layer({}))), false);
});

test("art on a hidden layer is excluded", () => {
  assert.strictEqual(
    CameoExtract.inHiddenOrLockedContainer(pathItem(layer({ visible: false }))), true);
});

test("art on a locked layer is excluded", () => {
  assert.strictEqual(
    CameoExtract.inHiddenOrLockedContainer(pathItem(layer({ locked: true }))), true);
});

test("a hidden parent sublayer excludes art several levels down", () => {
  const outer = layer({ visible: false });
  const inner = layer({}, outer);
  const g = group({}, inner);
  assert.strictEqual(CameoExtract.inHiddenOrLockedContainer(pathItem(g)), true);
});

test("a hidden group excludes its children", () => {
  assert.strictEqual(
    CameoExtract.inHiddenOrLockedContainer(pathItem(group({ hidden: true }))), true);
});

test("an item directly on the document is not excluded", () => {
  assert.strictEqual(CameoExtract.inHiddenOrLockedContainer(pathItem(doc())), false);
});

test("a missing parent does not throw", () => {
  // Illustrator can raise when reading .parent on some items; the walk must
  // fail open rather than aborting the whole extraction.
  const item = { typename: "PathItem" };
  Object.defineProperty(item, "parent", {
    get() { throw new Error("no parent"); }
  });
  assert.strictEqual(CameoExtract.inHiddenOrLockedContainer(item), false);
});

// -- JSON serialisation ----------------------------------------------------

test("serialiser escapes strings safely", () => {
  const out = CameoExtract.serialise({ message: 'he said "hi"\n\\path\ttab' });
  assert.strictEqual(JSON.parse(out).message, 'he said "hi"\n\\path\ttab');
});

test("serialiser escapes non-ASCII", () => {
  const out = CameoExtract.serialise({ name: "Café — ÿ" });
  assert.strictEqual(JSON.parse(out).name, "Café — ÿ");
});

test("serialiser round-trips the payload shape", () => {
  const payload = {
    ok: true,
    units: "mm",
    stats: { paths: 2, points: 9, flatness_mm: 0.05 },
    warnings: [{ type: "raster", message: "skipped", count: 3 }],
    paths: [[[0, 0], [10, 0]], [[1.23456789, -2.5]]]
  };
  const parsed = JSON.parse(CameoExtract.serialise(payload));

  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.stats.paths, 2);
  assert.strictEqual(parsed.warnings[0].count, 3);
  assert.deepStrictEqual(parsed.paths[0], [[0, 0], [10, 0]]);
});

test("coordinates are rounded to a sane precision", () => {
  // 4 decimal places in mm is 0.0001mm — far below the device's 0.05mm step,
  // and keeps the temp file small on big documents.
  const out = CameoExtract.serialise({ paths: [[[1.123456789, 2.0]]] });
  assert.ok(!out.includes("1.123456789"), "coordinate was not rounded");
  assert.strictEqual(JSON.parse(out).paths[0][0][1], 2);
});

test("non-finite coordinates serialise as null rather than breaking JSON", () => {
  const parsed = JSON.parse(CameoExtract.serialise({ x: NaN, y: Infinity }));
  assert.strictEqual(parsed.x, null);
  assert.strictEqual(parsed.y, null);
});
