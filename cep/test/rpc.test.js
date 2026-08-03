/*
 * Integration test for the panel <-> helper link.
 *
 * Loads the real js/helper.js and drives the real Python helper, so it covers
 * the actual spawn, the JSON-lines framing, request correlation and progress
 * events — everything between the panel and the driver except Illustrator
 * itself.
 *
 *   node --test cep/test/rpc.test.js
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CEP_ROOT = path.join(__dirname, "..");

/* helper.js declares `var CameoHelper` and expects a browser-ish global scope. */
function loadClientModule() {
  const source = fs.readFileSync(path.join(CEP_ROOT, "js", "helper.js"), "utf8");
  return new Function("require", "process", source + "\nreturn CameoHelper;")(
    require, process
  );
}

const CameoHelper = loadClientModule();

/* A 20mm square, as the extractor would produce it. */
const SQUARE = [[[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]]];

async function withClient(fn) {
  const client = new CameoHelper.Client(CEP_ROOT);
  client.onLog = () => {}; // the driver is chatty on stderr; ignore it here
  await client.start();
  try {
    return await fn(client);
  } finally {
    client.stop();
  }
}

test("the helper starts and reports a usable driver", async () => {
  await withClient(async (client) => {
    const result = await client.call("ping", {});
    assert.strictEqual(result.protocol, 1);
    assert.strictEqual(result.driver_available, true, result.driver_error || "");
  });
});

test("media presets come back from the driver's own table", async () => {
  await withClient(async (client) => {
    const { media } = await client.call("list_media", {});
    assert.ok(media.length >= 20);

    const custom = media.find((m) => m.code === 300);
    assert.ok(custom && custom.custom, "the custom sentinel should be flagged");

    const vinyl = media.find((m) => m.name.includes("Vinyl Sticker"));
    assert.strictEqual(vinyl.pressure, 10);
    assert.strictEqual(vinyl.speed, 5);
  });
});

test("the device catalog covers every supported model", async () => {
  await withClient(async (client) => {
    const info = await client.call("list_devices", {});
    assert.ok(info.catalog.length >= 19);
    assert.ok(info.cutting_mats.includes("cameo_12x12"));
    // No hardware attached in CI or on this machine.
    assert.strictEqual(typeof info.attached.connected, "boolean");
  });
});

test("a dry-run cut round-trips geometry and reports its bbox", async () => {
  await withClient(async (client) => {
    const result = await client.call("cut", {
      paths: SQUARE,
      dry_run: true,
      media_width: 210,
      media_height: 297
    });

    assert.strictEqual(result.path_count, 1);
    assert.strictEqual(result.point_count, 5);
    assert.strictEqual(result.cancelled, false);
    assert.ok(Math.abs(result.bbox.llx - 10) < 0.01);
    assert.ok(Math.abs(result.bbox.urx - 30) < 0.01);
  });
});

test("preview returns renderable SVG", async () => {
  await withClient(async (client) => {
    const result = await client.call("cut", {
      paths: SQUARE,
      dry_run: true,
      return_preview: true,
      media_width: 210,
      media_height: 297
    });

    assert.ok(result.preview_svg.startsWith("<svg"));
    assert.strictEqual(result.preview_paths, 1);
  });
});

test("a dry run completes without progress events", async () => {
  // The driver reports progress from inside its USB write loop, which a dry run
  // skips entirely — there is nothing to wait for, so there is nothing to
  // report. Progress with real hardware is covered by the Python tests, which
  // drive the callback directly. This test pins the dry-run contract so the
  // panel is not written expecting events that will never arrive.
  await withClient(async (client) => {
    const many = [];
    for (let i = 0; i < 200; i++) {
      const y = 10 + i * 0.5;
      many.push([[10, y], [100, y]]);
    }

    const events = [];
    const result = await client.call(
      "cut",
      { paths: many, dry_run: true, media_width: 210, media_height: 297 },
      (event) => events.push(event)
    );

    assert.strictEqual(result.path_count, 200);
    assert.strictEqual(events.length, 0);
  });
});

test("bbox comes back flat, not nested in the driver's raw dict", async () => {
  await withClient(async (client) => {
    const result = await client.call("cut", {
      paths: SQUARE, dry_run: true, media_width: 210, media_height: 297
    });

    assert.strictEqual(result.bbox.bbox, undefined, "raw driver shape leaked");
    assert.ok(Math.abs(result.bbox.width_mm - 20) < 0.01);
    assert.ok(Math.abs(result.bbox.height_mm - 20) < 0.01);
  });
});

test("concurrent requests are matched to the right reply", async () => {
  await withClient(async (client) => {
    const [ping, media, devices] = await Promise.all([
      client.call("ping", {}),
      client.call("list_media", {}),
      client.call("list_devices", {})
    ]);

    assert.strictEqual(ping.protocol, 1);
    assert.ok(Array.isArray(media.media));
    assert.ok(Array.isArray(devices.catalog));
  });
});

test("a bad request rejects without killing the helper", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.call("cut", { paths: [], dry_run: true }),
      /path list is empty/
    );
    // The connection must survive an application-level error.
    const result = await client.call("ping", {});
    assert.strictEqual(result.protocol, 1);
  });
});

test("an unknown method is reported as a protocol error", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.call("no_such_method", {}),
      (error) => error.kind === "protocol"
    );
  });
});

test("a second cut is refused while one is running", async () => {
  await withClient(async (client) => {
    const many = [];
    for (let i = 0; i < 400; i++) many.push([[10, 10 + i * 0.2], [100, 10 + i * 0.2]]);

    const first = client.call("cut", { paths: many, dry_run: true });
    const second = client.call("cut", { paths: SQUARE, dry_run: true });

    await assert.rejects(() => second, (error) => error.kind === "busy");
    await first;
  });
});
