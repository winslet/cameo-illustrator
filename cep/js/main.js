/*
 * Panel logic: talks to Illustrator through CSInterface and to the cutter
 * through the helper process.
 */

/* global CSInterface, SystemPath, CameoHelper, cep_node */

(function () {
  "use strict";

  var csInterface = new CSInterface();
  var client = null;
  var mediaPresets = [];
  var deviceInfo = null;
  var busy = false;

  var el = {};
  ["device-dot", "device-name", "refresh", "banner", "media", "preset-summary",
   "cap-swatch", "speed", "pressure", "depth", "toolholder", "passes",
   "offset-x", "offset-y", "mat", "margin-note", "matless", "bbox-only",
   "dry-run", "warnings", "status", "progress-track", "progress-bar",
   "preview", "send", "cancel", "preview-overlay", "preview-body",
   "preview-meta", "preview-close"].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var CAP_COLOURS = {
    blue: "#4a90d9", yellow: "#e3c04a", red: "#d95a5a",
    pen: "#888888", custom: "transparent"
  };

  // -- small helpers -------------------------------------------------------

  function setStatus(message, kind) {
    el.status.textContent = message;
    el.status.className = "status" + (kind ? " " + kind : "");
  }

  function showBanner(message, kind) {
    el.banner.textContent = message;
    el.banner.className = "banner" + (kind ? " " + kind : "");
    el.banner.classList.remove("hidden");
  }

  function hideBanner() {
    el.banner.classList.add("hidden");
  }

  function numberOrNull(input) {
    var raw = input.value.trim();
    if (raw === "") return null;
    var value = parseFloat(raw);
    return isNaN(value) ? null : value;
  }

  function setBusy(state) {
    busy = state;
    el.send.disabled = state;
    el.preview.disabled = state;
    el.refresh.disabled = state;
    el.cancel.classList.toggle("hidden", !state);
    el["progress-track"].classList.toggle("hidden", !state);
    if (!state) el["progress-bar"].style.width = "0";
  }

  /* Run an ExtendScript function and parse its JSON reply. */
  function evalScript(code) {
    return new Promise(function (resolve, reject) {
      csInterface.evalScript(code, function (raw) {
        if (raw === "EvalScript error.") {
          reject(new Error("Illustrator could not run the panel's script."));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("Unexpected reply from Illustrator: " + raw));
        }
      });
    });
  }

  // -- theme ---------------------------------------------------------------

  function applyTheme() {
    try {
      var info = csInterface.getHostEnvironment().appSkinInfo;
      var bg = info.panelBackgroundColor.color;
      // CEP reports 0-255 per channel; anything bright is the light theme.
      var luminance = (bg.red + bg.green + bg.blue) / 3;
      document.body.classList.toggle("theme-light", luminance > 127);
    } catch (e) { /* keep the dark default */ }
  }

  // -- populate ------------------------------------------------------------

  function fillMedia(presets) {
    mediaPresets = presets;
    el.media.innerHTML = "";
    presets.forEach(function (preset) {
      var option = document.createElement("option");
      option.value = String(preset.code);
      option.textContent = preset.name;
      if (preset.code === 132) option.selected = true;
      el.media.appendChild(option);
    });
    updatePresetReadout();
  }

  function currentPreset() {
    var code = parseInt(el.media.value, 10);
    for (var i = 0; i < mediaPresets.length; i++) {
      if (mediaPresets[i].code === code) return mediaPresets[i];
    }
    return null;
  }

  function updatePresetReadout() {
    var preset = currentPreset();
    if (!preset) {
      el["preset-summary"].textContent = "—";
      return;
    }

    if (preset.custom) {
      el["preset-summary"].textContent =
        "Set speed, pressure and depth below.";
    } else {
      var bits = [];
      if (preset.pressure !== null) bits.push("pressure " + preset.pressure);
      if (preset.speed !== null) bits.push("speed " + preset.speed);
      if (preset.depth !== null) bits.push("depth " + preset.depth);
      el["preset-summary"].textContent = bits.join(" · ");
    }

    var colour = CAP_COLOURS[preset.cap_color] || "transparent";
    el["cap-swatch"].style.background = colour;
    el["cap-swatch"].style.visibility = colour === "transparent" ? "hidden" : "visible";

    // The device caps pressure per model; do not offer a value it will reject.
    if (deviceInfo && deviceInfo.max_pressure) {
      el.pressure.max = String(deviceInfo.max_pressure);
    }
  }

  function fillMats(mats) {
    el.mat.innerHTML = "";
    var none = document.createElement("option");
    none.value = "";
    none.textContent = "None / not set";
    el.mat.appendChild(none);

    mats.forEach(function (mat) {
      var option = document.createElement("option");
      option.value = mat;
      option.textContent = mat.replace(/_/g, " ");
      el.mat.appendChild(option);
    });
  }

  function showDevice(info, catalog) {
    deviceInfo = info;
    el["device-name"].textContent = info.label;
    el["device-dot"].className = "dot" + (info.connected ? " connected" : "");

    if (!info.connected) {
      el["device-name"].textContent = "No cutter found";
      showBanner(
        "No cutter detected. Connect it by USB and switch it on, then press ↻. " +
        "You can still use Dry run to check a design.",
        ""
      );
    } else {
      hideBanner();
    }

    // Media margins shift where a design lands, and differ per model. Saying so
    // up front beats the user discovering it on their material.
    var entry = null;
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].name === info.name) { entry = catalog[i]; break; }
    }
    if (entry && (entry.margin_left_mm || entry.margin_top_mm)) {
      el["margin-note"].textContent =
        "This model offsets cuts by " + entry.margin_left_mm + "mm across and " +
        entry.margin_top_mm + "mm down, to match its usable media area.";
      el["margin-note"].classList.remove("hidden");
    } else {
      el["margin-note"].classList.add("hidden");
    }

    updatePresetReadout();
  }

  // -- geometry ------------------------------------------------------------

  function readExtractFile(filePath) {
    var nodeRequire = (typeof require === "function")
      ? require
      : (typeof cep_node !== "undefined" ? cep_node.require : null);
    var fs = nodeRequire("fs");
    var text = fs.readFileSync(filePath, "utf8");
    try {
      fs.unlinkSync(filePath);
    } catch (e) { /* a leftover temp file is not worth failing the cut over */ }
    return JSON.parse(text);
  }

  function showWarnings(warnings) {
    if (!warnings || warnings.length === 0) {
      el.warnings.classList.add("hidden");
      return;
    }
    var html = "<ul>";
    warnings.forEach(function (warning) {
      var suffix = warning.count > 1 ? " (×" + warning.count + ")" : "";
      html += "<li>" + warning.message + suffix + "</li>";
    });
    el.warnings.innerHTML = html + "</ul>";
    el.warnings.classList.remove("hidden");
  }

  function extractGeometry() {
    setStatus("Reading artwork from Illustrator…");
    return evalScript('cameoExtractGeometry("{}")').then(function (summary) {
      if (!summary.ok) throw new Error(summary.error || "Could not read the artwork.");
      showWarnings(summary.warnings);

      var payload = readExtractFile(summary.file);
      if (!payload.ok) throw new Error(payload.error || "Could not read the artwork.");
      if (!payload.paths || payload.paths.length === 0) {
        throw new Error(
          "Nothing to cut. Select some paths, or check the artwork is not " +
          "hidden, locked, or a placed image."
        );
      }
      return payload;
    });
  }

  // -- cutting -------------------------------------------------------------

  function buildParams(payload, extra) {
    var params = {
      paths: payload.paths,
      media_width: payload.artboard.width_mm,
      media_height: payload.artboard.height_mm,
      offset_x: numberOrNull(el["offset-x"]) || 0,
      offset_y: numberOrNull(el["offset-y"]) || 0,
      media: parseInt(el.media.value, 10),
      speed: numberOrNull(el.speed),
      pressure: numberOrNull(el.pressure),
      depth: numberOrNull(el.depth),
      toolholder: parseInt(el.toolholder.value, 10),
      cutting_mat: el.mat.value || null,
      passes: parseInt(el.passes.value, 10) || 1,
      matless: el.matless.checked,
      bbox_only: el["bbox-only"].checked,
      dry_run: el["dry-run"].checked
    };

    for (var key in extra) {
      if (extra.hasOwnProperty(key)) params[key] = extra[key];
    }
    return params;
  }

  function onProgress(event) {
    if (event.event !== "progress") return;
    el["progress-bar"].style.width = event.percent + "%";
    setStatus("Cutting… " + event.percent + "%");
  }

  function send() {
    if (busy) return;
    setBusy(true);
    hideBanner();

    extractGeometry()
      .then(function (payload) {
        var params = buildParams(payload, {});
        var verb = params.dry_run ? "Simulating" : "Sending";
        setStatus(verb + " " + payload.stats.paths + " paths…");
        return client.call("cut", params, onProgress);
      })
      .then(function (result) {
        if (result.cancelled) {
          setStatus("Cancelled. The cutter was sent home.", "");
          return;
        }
        var where = result.bbox && result.bbox.llx !== undefined
          ? " at " + result.bbox.llx.toFixed(1) + "," + result.bbox.ury.toFixed(1) + "mm"
          : "";
        setStatus(
          (el["dry-run"].checked ? "Simulated " : "Cut ") +
          result.path_count + " paths" + where + ".", "ok"
        );
      })
      .catch(function (error) {
        setStatus(error.message, "error");
      })
      .then(function () {
        setBusy(false);
      });
  }

  function preview() {
    if (busy) return;
    setBusy(true);
    hideBanner();

    extractGeometry()
      .then(function (payload) {
        setStatus("Simulating…");
        // Always a dry run: preview must never move the machine.
        var params = buildParams(payload, {
          dry_run: true,
          return_preview: true
        });
        return client.call("cut", params).then(function (result) {
          return { result: result, payload: payload };
        });
      })
      .then(function (bundle) {
        el["preview-body"].innerHTML = bundle.result.preview_svg || "";
        el["preview-meta"].textContent =
          bundle.result.preview_paths + " paths, " +
          bundle.payload.stats.points + " points, on " +
          bundle.result.device.replace(/_/g, " ") + ".";
        el["preview-overlay"].classList.remove("hidden");
        setStatus("Preview ready.", "ok");
      })
      .catch(function (error) {
        setStatus(error.message, "error");
      })
      .then(function () {
        setBusy(false);
      });
  }

  function refreshDevice() {
    setStatus("Looking for a cutter…");
    return client.call("list_devices", {})
      .then(function (info) {
        showDevice(info.attached, info.catalog);
        fillMats(info.cutting_mats);
        setStatus(info.attached.connected ? "Ready" : "Ready (no cutter attached)");
      })
      .catch(function (error) {
        el["device-dot"].className = "dot error";
        el["device-name"].textContent = "Helper error";
        showBanner(error.message, "error");
        setStatus(error.message, "error");
      });
  }

  // -- startup -------------------------------------------------------------

  function start() {
    applyTheme();

    var extensionRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    client = new CameoHelper.Client(extensionRoot);

    if (!client.isSupported()) {
      showBanner(
        "This panel needs Node, which Illustrator did not enable. Reinstall the " +
        "extension, or check --enable-nodejs in its manifest.", "error"
      );
      setStatus("Cannot start", "error");
      return;
    }

    setStatus("Starting helper…");
    client.start()
      .then(function () {
        return client.call("ping", {});
      })
      .then(function (info) {
        // A helper that started but cannot reach USB is the most likely
        // misconfiguration, and it must not look like "no cutter plugged in".
        if (!info.driver_available) {
          throw new Error(
            "The helper is running on Python " + info.python + ", which cannot " +
            "reach USB: " + (info.driver_error || "unknown reason") +
            " Try: brew install libusb, then re-run scripts/dev-install.sh."
          );
        }
        return client.call("list_media", {});
      })
      .then(function (media) {
        fillMedia(media.media);
        return refreshDevice();
      })
      .catch(function (error) {
        showBanner(error.message, "error");
        setStatus("Could not start the helper", "error");
      });

    el.media.addEventListener("change", updatePresetReadout);
    el.refresh.addEventListener("click", refreshDevice);
    el.send.addEventListener("click", send);
    el.preview.addEventListener("click", preview);
    el.cancel.addEventListener("click", function () {
      client.call("cancel", {});
      setStatus("Cancelling…");
    });
    el["preview-close"].addEventListener("click", function () {
      el["preview-overlay"].classList.add("hidden");
    });

    // Illustrator does not always tear the panel down cleanly, so make sure the
    // helper does not outlive it and hold the USB device open.
    window.addEventListener("beforeunload", function () {
      if (client) client.stop();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
