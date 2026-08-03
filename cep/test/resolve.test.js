/*
 * Regression tests for locating the Python that runs the helper.
 *
 * This went wrong in a way worth pinning down: dev-install.sh symlinks
 * <extension>/helper to the repo, and path.join collapses ".." textually, so
 * the venv lookup searched beside the *symlink* rather than beside the real
 * directory. Every venv candidate missed and the panel silently fell through to
 * macOS's system python3 — which has no pyusb, so the helper started fine and
 * then could not reach any cutter.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CEP_ROOT = path.join(__dirname, "..");

function loadClientModule() {
  const source = fs.readFileSync(path.join(CEP_ROOT, "js", "helper.js"), "utf8");
  return new Function("require", "process", source + "\nreturn CameoHelper;")(
    require, process
  );
}

const CameoHelper = loadClientModule();

/*
 * Build a throwaway layout mirroring a dev install:
 *
 *   repo/.venv/bin/python3      (a stub that reports it can reach USB)
 *   repo/helper/
 *   extensions/<id>/helper  ->  repo/helper       (symlink)
 */
function makeFixture({ venvWorks = true, bundled = false, runtime = false } = {}) {
  // realpath the root: on macOS os.tmpdir() is /var/..., itself a symlink to
  // /private/var/..., and the resolver returns realpath'd paths.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cameo-resolve-")));
  const repo = path.join(root, "repo");
  const helper = path.join(repo, "helper");
  const venvBin = path.join(repo, ".venv", "bin");
  const extension = path.join(root, "extensions", "com.example.panel");

  fs.mkdirSync(helper, { recursive: true });
  fs.mkdirSync(venvBin, { recursive: true });
  fs.mkdirSync(extension, { recursive: true });

  const python = path.join(venvBin, "python3");
  fs.writeFileSync(python, `#!/bin/sh\nexit ${venvWorks ? 0 : 1}\n`);
  fs.chmodSync(python, 0o755);

  if (bundled) {
    const bin = path.join(helper, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "cameo-helper"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(bin, "cameo-helper"), 0o755);
  }

  let bundledRuntime = null;
  if (runtime) {
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const runtimeBin = path.join(helper, "runtime", "macos-" + arch, "bin");
    fs.mkdirSync(runtimeBin, { recursive: true });
    bundledRuntime = path.join(runtimeBin, "python3");
    fs.writeFileSync(bundledRuntime, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bundledRuntime, 0o755);
  }

  fs.symlinkSync(helper, path.join(extension, "helper"));

  return { root, repo, helper, extension, python, bundledRuntime };
}

test("the venv is found through a symlinked helper directory", () => {
  const fixture = makeFixture();
  const resolved = new CameoHelper.Client(fixture.extension)._resolveCommand();

  assert.strictEqual(resolved.command, fixture.python,
    "should use the repo's venv, not a system python");
  assert.deepStrictEqual(resolved.args, ["-m", "cameo_helper"]);
});

test("the working directory is the real helper directory, not the symlink", () => {
  const fixture = makeFixture();
  const resolved = new CameoHelper.Client(fixture.extension)._resolveCommand();

  assert.strictEqual(resolved.cwd, fs.realpathSync(fixture.helper));
});

test("an interpreter that cannot reach USB is not chosen", () => {
  // The stub exits non-zero for `import usb1`, standing in for macOS's system
  // python3. With no working candidate the resolver still returns something so
  // the helper can start and explain itself.
  const fixture = makeFixture({ venvWorks: false });
  const resolved = new CameoHelper.Client(fixture.extension)._resolveCommand();

  assert.strictEqual(resolved.mode, "python-no-usb");
});

test("a runtime shipped by the installer is preferred over any system Python", () => {
  // The .pkg installer bundles its own interpreter precisely so the install has
  // no Python prerequisite. Falling back to a system Python would silently
  // reintroduce the dependency the installer exists to remove.
  const fixture = makeFixture({ runtime: true });
  const resolved = new CameoHelper.Client(fixture.extension)._resolveCommand();

  assert.strictEqual(resolved.command, fixture.bundledRuntime);
});

test("a bundled binary wins over any interpreter", () => {
  const fixture = makeFixture({ bundled: true });
  const resolved = new CameoHelper.Client(fixture.extension)._resolveCommand();

  assert.strictEqual(resolved.mode, "bundled");
  assert.deepStrictEqual(resolved.args, []);
});

test("the real dev install resolves to a working interpreter", () => {
  // Guards the actual layout on this machine, not just the synthetic fixture.
  const resolved = new CameoHelper.Client(CEP_ROOT)._resolveCommand();

  assert.ok(resolved, "nothing resolved");
  assert.strictEqual(resolved.mode, "python",
    "the installed layout should yield an interpreter that can reach USB");
});
