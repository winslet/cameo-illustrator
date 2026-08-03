/*
 * Walk an Illustrator document and produce cut geometry.
 *
 * Output is a list of polylines in millimetres, y-down, with the origin at the
 * top-left of the active artboard — exactly the shape the vendored driver's
 * plot(pathlist=...) expects, so no SVG or unit conversion happens downstream.
 *
 * The user's artwork is never modified. Outlining text needs a temporary
 * duplicate, which is always removed again in a finally block.
 *
 * ExtendScript is ES3: no const/let, no JSON, no Array.prototype.forEach.
 */

/* global CameoExtract:true, CameoFlatten, app, Folder, File,
   CoordinateSystem, ElementPlacement */
var CameoExtract = (function () {
  "use strict";

  // 0.05mm is the device's own resolution (20 units/mm); finer is wasted work.
  var DEFAULT_FLATNESS_MM = 0.05;
  var COORD_DECIMALS = 4;

  // ---- JSON output -----------------------------------------------------
  // ExtendScript has no JSON object. The payload shape is fully under our
  // control, so a small serialiser beats pulling in json2.js.

  function escapeString(value) {
    var out = "";
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      var code = value.charCodeAt(i);
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (code < 0x20 || code > 0x7e) {
        var hex = code.toString(16);
        while (hex.length < 4) hex = "0" + hex;
        out += "\\u" + hex;
      } else out += ch;
    }
    return '"' + out + '"';
  }

  function num(value) {
    // toFixed then strip trailing zeros: keeps files small and diffs stable.
    var s = value.toFixed(COORD_DECIMALS);
    if (s.indexOf(".") >= 0) {
      s = s.replace(/0+$/, "").replace(/\.$/, "");
    }
    return s === "-0" ? "0" : s;
  }

  function serialise(value) {
    if (value === null || value === undefined) return "null";
    var type = typeof value;
    if (type === "number") return isFinite(value) ? num(value) : "null";
    if (type === "boolean") return value ? "true" : "false";
    if (type === "string") return escapeString(value);
    if (value instanceof Array) {
      var items = [];
      for (var i = 0; i < value.length; i++) items.push(serialise(value[i]));
      return "[" + items.join(",") + "]";
    }
    var pairs = [];
    for (var key in value) {
      if (value.hasOwnProperty(key)) {
        pairs.push(escapeString(key) + ":" + serialise(value[key]));
      }
    }
    return "{" + pairs.join(",") + "}";
  }

  // ---- coordinate mapping ---------------------------------------------

  /*
   * Illustrator's scripting space puts the origin at the top-left of the first
   * artboard with y increasing UPWARD, so artboardRect is [left, top, right,
   * bottom] with top > bottom. Mapping through the active artboard's own rect
   * gives millimetres, y-down, from that artboard's top-left corner.
   */
  function makeMapper(artboardRect) {
    var left = artboardRect[0];
    var top = artboardRect[1];
    var mm = CameoFlatten.MM_PER_POINT;
    return function (point) {
      return [(point[0] - left) * mm, (top - point[1]) * mm];
    };
  }

  // ---- geometry --------------------------------------------------------

  function pathToPolyline(pathItem, mapper, flatnessMm) {
    var points = pathItem.pathPoints;
    var count = points.length;
    if (count < 2) return null;

    // Tolerance is applied in millimetre space, so convert it once here rather
    // than converting every generated point back and forth.
    var toleranceMm = flatnessMm;

    var anchors = [];
    var lefts = [];
    var rights = [];
    for (var i = 0; i < count; i++) {
      // One property read each: ExtendScript DOM access dominates runtime.
      var p = points[i];
      anchors.push(mapper(p.anchor));
      lefts.push(mapper(p.leftDirection));
      rights.push(mapper(p.rightDirection));
    }

    var out = [anchors[0]];
    for (var j = 0; j < count - 1; j++) {
      CameoFlatten.flattenSegment(
        anchors[j], rights[j], lefts[j + 1], anchors[j + 1], toleranceMm, out
      );
    }

    if (pathItem.closed && count > 2) {
      CameoFlatten.flattenSegment(
        anchors[count - 1], rights[count - 1], lefts[0], anchors[0], toleranceMm, out
      );
    }

    return out.length >= 2 ? out : null;
  }

  // ---- document walk ---------------------------------------------------

  function Collector(mapper, flatnessMm) {
    this.mapper = mapper;
    this.flatness = flatnessMm;
    this.paths = [];
    this.warnings = [];
    this.skipped = {};
  }

  Collector.prototype.warn = function (kind, message) {
    // Collapse repeats: one "3 text frames skipped" beats three identical rows.
    if (this.skipped[kind]) {
      this.skipped[kind].count++;
      return;
    }
    var entry = { type: kind, message: message, count: 1 };
    this.skipped[kind] = entry;
    this.warnings.push(entry);
  };

  Collector.prototype.addPath = function (pathItem) {
    if (pathItem.guides) return;
    if (pathItem.clipping) {
      // A clipping path defines a mask, it is not itself artwork to cut.
      this.warn("clipping_path",
        "Clipping paths were ignored. Cut geometry is not clipped to masks.");
      return;
    }
    var polyline = pathToPolyline(pathItem, this.mapper, this.flatness);
    if (polyline) this.paths.push(polyline);
  };

  Collector.prototype.visit = function (item) {
    // hidden/locked art is not what the user is looking at, so it is not cut.
    if (item.hidden || item.locked) return;

    var type = item.typename;

    if (type === "PathItem") {
      this.addPath(item);
    } else if (type === "CompoundPathItem") {
      var sub = item.pathItems;
      for (var i = 0; i < sub.length; i++) this.addPath(sub[i]);
    } else if (type === "GroupItem") {
      if (item.clipped) {
        this.warn("clipped_group",
          "Clipping masks were ignored; all art inside the group was cut.");
      }
      var kids = item.pageItems;
      for (var j = 0; j < kids.length; j++) this.visit(kids[j]);
    } else if (type === "TextFrame") {
      this.visitText(item);
    } else if (type === "PlacedItem" || type === "RasterItem") {
      this.warn("raster",
        "Placed and raster images cannot be cut and were skipped. " +
        "Trace them to vector paths first.");
    } else if (type === "SymbolItem") {
      this.warn("symbol",
        "Symbols were skipped. Expand them (Object > Expand) to cut them.");
    } else if (type === "PluginItem") {
      this.warn("plugin_item",
        "Blends, envelopes and similar live objects were skipped. " +
        "Expand them (Object > Expand) to cut them.");
    } else if (type === "MeshItem" || type === "GraphItem") {
      this.warn("unsupported",
        type + " objects cannot be cut and were skipped.");
    }
  };

  /*
   * Text has to be outlined to have any path geometry at all.
   *
   * The duplicate is made in the same document so its position is preserved,
   * then removed again. createOutline() consumes the duplicate and returns a
   * group, so only that group needs removing — and only if we got that far,
   * which is what the two-variable dance in the finally block is for.
   */
  Collector.prototype.visitText = function (textFrame) {
    var duplicate = null;
    var outlined = null;
    try {
      duplicate = textFrame.duplicate();
      outlined = duplicate.createOutline();
      duplicate = null; // consumed by createOutline
      this.visit(outlined);
    } catch (e) {
      this.warn("text_outline",
        "Some text could not be converted to outlines and was skipped: " + e);
    } finally {
      try { if (outlined) outlined.remove(); } catch (e2) {}
      try { if (duplicate) duplicate.remove(); } catch (e3) {}
    }
  };

  // ---- entry point -----------------------------------------------------

  function collect(options) {
    options = options || {};
    var flatness = options.flatness_mm || DEFAULT_FLATNESS_MM;

    if (app.documents.length === 0) {
      return { ok: false, error: "No document is open." };
    }

    var doc = app.activeDocument;

    // Pin the coordinate system so artboardRect and pathPoints agree, whatever
    // the user's preference is set to, and put it back afterwards.
    var previousCoordinateSystem = null;
    try {
      previousCoordinateSystem = app.coordinateSystem;
      app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;
    } catch (e) {
      // Older Illustrator has no app.coordinateSystem; its behaviour matches
      // the document system already.
      previousCoordinateSystem = null;
    }

    try {
      var index = doc.artboards.getActiveArtboardIndex();
      var artboard = doc.artboards[index];
      var rect = artboard.artboardRect; // [left, top, right, bottom]
      var widthMm = (rect[2] - rect[0]) * CameoFlatten.MM_PER_POINT;
      var heightMm = (rect[1] - rect[3]) * CameoFlatten.MM_PER_POINT;

      var collector = new Collector(makeMapper(rect), flatness);

      var selection = doc.selection;
      var usedSelection = selection && selection.length > 0;
      var source = usedSelection ? selection : doc.pageItems;

      for (var i = 0; i < source.length; i++) {
        // Top-level page items include the children of groups, so when walking
        // the whole document we take only items whose parent is a layer —
        // otherwise grouped art would be collected twice.
        if (!usedSelection) {
          var parentType = source[i].parent.typename;
          if (parentType !== "Layer" && parentType !== "Document") continue;
        }
        collector.visit(source[i]);
      }

      var pointCount = 0;
      for (var k = 0; k < collector.paths.length; k++) {
        pointCount += collector.paths[k].length;
      }

      return {
        ok: true,
        units: "mm",
        source: usedSelection ? "selection" : "document",
        artboard: {
          name: artboard.name,
          width_mm: widthMm,
          height_mm: heightMm
        },
        stats: {
          paths: collector.paths.length,
          points: pointCount,
          flatness_mm: flatness
        },
        warnings: collector.warnings,
        paths: collector.paths
      };
    } finally {
      if (previousCoordinateSystem !== null) {
        try { app.coordinateSystem = previousCoordinateSystem; } catch (e4) {}
      }
    }
  }

  /*
   * Extract, write the payload to a temp file, and return only the path.
   *
   * evalScript returns a string with a size limit that a real document blows
   * straight through, so the geometry travels via the filesystem and only the
   * filename comes back through CEP.
   */
  function collectToFile(options) {
    var result;
    try {
      result = collect(options);
    } catch (e) {
      result = { ok: false, error: String(e) };
    }

    var file = new File(
      Folder.temp.fsName + "/cameo-extract-" + new Date().getTime() + ".json"
    );
    file.encoding = "UTF-8";
    if (!file.open("w")) {
      return serialise({ ok: false, error: "Could not open a temporary file." });
    }
    try {
      file.write(serialise(result));
    } finally {
      file.close();
    }

    return serialise({
      ok: result.ok,
      error: result.error || null,
      file: file.fsName,
      stats: result.stats || null,
      artboard: result.artboard || null,
      warnings: result.warnings || [],
      source: result.source || null
    });
  }

  return {
    collect: collect,
    collectToFile: collectToFile,
    serialise: serialise,
    pathToPolyline: pathToPolyline,
    makeMapper: makeMapper
  };
})();
