/*
 * Client for the local helper process.
 *
 * Runs in the panel using CEP's Node integration. The helper is a child process
 * spoken to over stdin/stdout with newline-delimited JSON — no socket, no port,
 * no listener on the user's machine.
 */

/* global require, cep_node */

var CameoHelper = (function () {
  "use strict";

  // Under --mixed-context, Node's require is on the window; older CEP builds
  // expose it as cep_node.require.
  var nodeRequire = (typeof require === "function")
    ? require
    : (typeof cep_node !== "undefined" ? cep_node.require : null);

  var childProcess = nodeRequire ? nodeRequire("child_process") : null;
  var fs = nodeRequire ? nodeRequire("fs") : null;
  var path = nodeRequire ? nodeRequire("path") : null;

  function Client(extensionRoot) {
    this.extensionRoot = extensionRoot;
    this.process = null;
    this.nextId = 1;
    this.pending = {};      // id -> {resolve, reject, onEvent}
    this.buffer = "";
    this.ready = false;
    this.onLog = null;      // set by the UI to surface stderr
  }

  Client.prototype.isSupported = function () {
    return !!childProcess;
  };

  /*
   * Does this interpreter actually have the USB bindings the driver needs?
   *
   * Existing on disk is not enough. macOS ships a system python3 with no pyusb,
   * and picking it silently produces a helper that starts fine and then cannot
   * talk to any cutter. Probing costs ~100ms once at startup and turns a
   * confusing runtime failure into picking the right interpreter.
   */
  Client.prototype._canDriveUsb = function (command, helperDir) {
    // Probe with the vendored packages on the path, exactly as the helper will
    // run. Without this, an interpreter that has no system-wide pyusb — such as
    // macOS's own python3 — would be rejected even though the vendored copy
    // would make it work perfectly well.
    var env = Object.assign({}, process.env);
    var pydeps = path.join(helperDir, "vendor", "pydeps");
    env.PYTHONPATH = fs.existsSync(pydeps) ? pydeps + ":" + helperDir : helperDir;

    try {
      childProcess.execFileSync(command, ["-c", "import usb1, usb.core"], {
        stdio: "ignore",
        timeout: 5000,
        env: env
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  /*
   * Locate the helper.
   *
   * A packaged install has a self-contained binary at helper/bin/. In
   * development the panel is symlinked from the repo, so the helper directory
   * has to be resolved through the symlink — path.join collapses ".." textually
   * and would look beside the *link* rather than beside the real directory.
   */
  Client.prototype._resolveCommand = function () {
    var helperDir = path.join(this.extensionRoot, "helper");

    var realHelperDir = helperDir;
    try {
      realHelperDir = fs.realpathSync(helperDir);
    } catch (e) { /* not a symlink, or missing; handled below */ }

    var bundled = path.join(realHelperDir, "bin", "cameo-helper");
    if (fs.existsSync(bundled)) {
      return { command: bundled, args: [], cwd: realHelperDir, mode: "bundled" };
    }

    // A Python runtime shipped by the .pkg installer, so that install has no
    // Python prerequisite at all. Per-architecture, because the upstream
    // standalone builds are not universal binaries.
    var arch = process.arch === "arm64" ? "arm64" : "x86_64";
    var bundledRuntime = path.join(
      realHelperDir, "runtime", "macos-" + arch, "bin", "python3"
    );

    var candidates = [
      bundledRuntime,
      path.join(realHelperDir, "..", ".venv", "bin", "python3"),
      path.join(realHelperDir, ".venv", "bin", "python3"),
      path.join(this.extensionRoot, "..", ".venv", "bin", "python3"),
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      "python3"
    ];

    var existing = [];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (candidate.indexOf("/") < 0 || fs.existsSync(candidate)) {
        existing.push(candidate);
      }
    }

    // Prefer an interpreter that can actually reach USB.
    for (var j = 0; j < existing.length; j++) {
      if (this._canDriveUsb(existing[j], realHelperDir)) {
        return {
          command: existing[j],
          args: ["-m", "cameo_helper"],
          cwd: realHelperDir,
          mode: "python"
        };
      }
    }

    // None can. Still start the best guess, so the helper comes up and reports
    // a precise reason over RPC rather than the panel just saying "failed".
    if (existing.length > 0) {
      return {
        command: existing[0],
        args: ["-m", "cameo_helper"],
        cwd: realHelperDir,
        mode: "python-no-usb"
      };
    }

    return null;
  };

  Client.prototype.start = function () {
    var self = this;

    return new Promise(function (resolve, reject) {
      if (!self.isSupported()) {
        reject(new Error(
          "Node is not available in this panel. Check that --enable-nodejs is " +
          "present in the extension manifest."
        ));
        return;
      }

      if (self.process) {
        resolve({ alreadyRunning: true });
        return;
      }

      var resolved = self._resolveCommand();
      if (!resolved) {
        reject(new Error("Could not find Python 3 or a bundled helper binary."));
        return;
      }

      var env = {};
      for (var key in process.env) {
        if (process.env.hasOwnProperty(key)) env[key] = process.env[key];
      }
      // Running as `python -m cameo_helper` from the helper directory.
      env.PYTHONPATH = resolved.cwd;
      // Unbuffered, or responses would sit in a pipe buffer until it filled.
      env.PYTHONUNBUFFERED = "1";
      // Fallback only. A packaged build (and any checkout that has run
      // scripts/vendor-pydeps.sh) carries its own libusb, which usb1 finds
      // first. This keeps a bare checkout working against a Homebrew or
      // /usr/local libusb, neither of which is on the default loader path for a
      // process launched by Illustrator.
      env.DYLD_FALLBACK_LIBRARY_PATH =
        "/opt/homebrew/lib:/usr/local/lib:" + (env.DYLD_FALLBACK_LIBRARY_PATH || "");

      var child;
      try {
        child = childProcess.spawn(resolved.command, resolved.args, {
          cwd: resolved.cwd,
          env: env,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (e) {
        reject(new Error("Could not start the helper: " + e.message));
        return;
      }

      self.process = child;
      self.mode = resolved.mode;

      var settled = false;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", function (chunk) {
        self._onData(chunk);
        if (!settled && self.ready) {
          settled = true;
          resolve({ mode: resolved.mode, command: resolved.command });
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", function (chunk) {
        // The driver logs plenty here; it is diagnostics, not errors.
        if (self.onLog) self.onLog(chunk);
      });

      child.on("error", function (err) {
        self.process = null;
        if (!settled) {
          settled = true;
          reject(new Error("Helper failed to start: " + err.message));
        }
      });

      child.on("exit", function (code) {
        self.process = null;
        self.ready = false;
        var error = new Error("The helper process exited (code " + code + ").");
        for (var id in self.pending) {
          if (self.pending.hasOwnProperty(id)) self.pending[id].reject(error);
        }
        self.pending = {};
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error("The helper did not respond within 15 seconds."));
        }
      }, 15000);
    });
  };

  Client.prototype._onData = function (chunk) {
    this.buffer += chunk;

    var newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      var line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this._onMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  };

  Client.prototype._onMessage = function (line) {
    var message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      if (this.onLog) this.onLog("unparseable line from helper: " + line + "\n");
      return;
    }

    if (message.event === "ready") {
      this.ready = true;
      this.driverAvailable = message.driver_available;
      return;
    }

    var entry = this.pending[message.id];
    if (!entry) return;

    if (message.event) {
      if (entry.onEvent) entry.onEvent(message);
      return;
    }

    delete this.pending[message.id];
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      var error = new Error(message.error ? message.error.message : "Unknown error");
      error.kind = message.error ? message.error.kind : "unknown";
      entry.reject(error);
    }
  };

  Client.prototype.call = function (method, params, onEvent) {
    var self = this;

    return new Promise(function (resolve, reject) {
      if (!self.process) {
        reject(new Error("The helper is not running."));
        return;
      }
      var id = self.nextId++;
      self.pending[id] = { resolve: resolve, reject: reject, onEvent: onEvent };
      self.process.stdin.write(
        JSON.stringify({ id: id, method: method, params: params || {} }) + "\n"
      );
    });
  };

  Client.prototype.stop = function () {
    if (!this.process) return;
    try {
      this.call("shutdown", {});
    } catch (e) { /* the process may already be gone */ }

    var child = this.process;
    this.process = null;
    setTimeout(function () {
      try { child.kill(); } catch (e) {}
    }, 500);
  };

  return { Client: Client };
})();
