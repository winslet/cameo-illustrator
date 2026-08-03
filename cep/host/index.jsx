/*
 * ExtendScript entry point, loaded by the panel via manifest ScriptPath.
 *
 * Everything the panel calls goes through here. Each function returns a JSON
 * string, because that is all evalScript can carry back.
 */

//@include "flatten.jsx"
//@include "extract.jsx"

/* global CameoExtract, app */

/*
 * Extract cut geometry and write it to a temp file.
 * Returns JSON: { ok, file, stats, artboard, warnings, source, error }
 */
function cameoExtractGeometry(optionsJson) {
  var options = {};
  try {
    if (optionsJson) {
      // eval rather than JSON.parse: ExtendScript is ES3 and has no JSON.
      // The argument is built by our own panel code, never by the document.
      options = eval("(" + optionsJson + ")");
    }
  } catch (e) {
    options = {};
  }
  return CameoExtract.collectToFile(options);
}

/*
 * Cheap summary for the panel's status line, without extracting anything.
 */
function cameoDocumentInfo() {
  try {
    if (app.documents.length === 0) {
      return CameoExtract.serialise({ ok: false, error: "No document is open." });
    }
    var doc = app.activeDocument;
    var index = doc.artboards.getActiveArtboardIndex();
    var artboard = doc.artboards[index];
    var rect = artboard.artboardRect;
    var mm = 25.4 / 72.0;

    return CameoExtract.serialise({
      ok: true,
      name: doc.name,
      artboard: {
        name: artboard.name,
        width_mm: (rect[2] - rect[0]) * mm,
        height_mm: (rect[1] - rect[3]) * mm
      },
      selection_count: doc.selection ? doc.selection.length : 0
    });
  } catch (e) {
    return CameoExtract.serialise({ ok: false, error: String(e) });
  }
}
