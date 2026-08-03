#!/usr/bin/env node
/*
 * Guard the panel's JavaScript against syntax the oldest supported host cannot
 * parse.
 *
 * The manifest advertises Illustrator 2020 (ILST 24.0), which ships **CEP 9 —
 * Chromium 61 and Node 8.6.0**. Not CEP 12's Chromium 99 / Node 17: that is
 * only what the *newest* hosts run.
 *
 * This matters more than a normal compatibility lapse. Optional chaining is a
 * parse error in Chromium 61, so a single `?.` does not degrade a feature — it
 * stops the whole script loading and the panel never appears. CI's Node matrix
 * cannot catch that, because every version it runs is far newer than the floor.
 *
 * A heuristic, not a parser: it strips comments and string literals, then looks
 * for constructs known to postdate the floor. It will not catch everything, so
 * it is a backstop for the guidance in CONTRIBUTING.md rather than a substitute
 * for it.
 *
 *   node scripts/check-panel-syntax.js
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");

// Chromium 61 / Node 8.6 is the floor. Each entry notes where it became
// available, so raising the manifest's minimum host makes the fix obvious.
const FORBIDDEN = [
  { re: /\?\./, name: "optional chaining (?.)", since: "Chromium 80" },
  { re: /\?\?/, name: "nullish coalescing (??)", since: "Chromium 80" },
  { re: /\|\|=|&&=/, name: "logical assignment (||= &&=)", since: "Chromium 85" },
  { re: /\bglobalThis\b/, name: "globalThis", since: "Chromium 71" },
  { re: /\bBigInt\b|\b\d+n\b/, name: "BigInt", since: "Chromium 67" },
  { re: /\bObject\.fromEntries\b/, name: "Object.fromEntries", since: "Chromium 73" },
  { re: /\.flatMap\s*\(|\.flat\s*\(/, name: "Array.flat / flatMap", since: "Chromium 69" },
  { re: /\.matchAll\s*\(/, name: "String.matchAll", since: "Chromium 73" },
  { re: /\.replaceAll\s*\(/, name: "String.replaceAll", since: "Chromium 85" },
  { re: /\bPromise\.allSettled\b/, name: "Promise.allSettled", since: "Chromium 76" },
  { re: /\bstructuredClone\b/, name: "structuredClone", since: "Chromium 98" },
  { re: /\bObject\.groupBy\b/, name: "Object.groupBy", since: "Chromium 117" },
  { re: /\.toSorted\s*\(|\.toReversed\s*\(/, name: "toSorted / toReversed", since: "Chromium 110" },
  { re: /\.findLast\s*\(/, name: "Array.findLast", since: "Chromium 97" },
  { re: /\bArray\.fromAsync\b/, name: "Array.fromAsync", since: "Chromium 121" }
];

// ExtendScript is stricter still: ES3, so even `const` and arrow functions are
// out. Checked separately because the panel's own JS may use ES5+ freely.
const EXTENDSCRIPT_FORBIDDEN = [
  { re: /=>/, name: "arrow functions", since: "ES2015" },
  { re: /\b(const|let)\s+[A-Za-z_$]/, name: "const / let", since: "ES2015" },
  { re: /`/, name: "template literals", since: "ES2015" },
  { re: /\bJSON\.(parse|stringify)\b/, name: "JSON (absent in ExtendScript)", since: "ES5" },
  { re: /\.forEach\s*\(|\.map\s*\(|\.filter\s*\(/, name: "Array iteration methods", since: "ES5" }
];

/** Remove comments and string literals so their contents are not scanned. */
function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function check(file, rules) {
  const source = fs.readFileSync(file, "utf8");
  const stripped = strip(source);
  const problems = [];

  for (const rule of rules) {
    if (!rule.re.test(stripped)) continue;

    // Report the first offending line from the stripped source, so the number
    // still lines up with the original file.
    const lines = stripped.split("\n");
    const index = lines.findIndex((line) => rule.re.test(line));
    problems.push({
      line: index >= 0 ? index + 1 : "?",
      name: rule.name,
      since: rule.since
    });
  }
  return problems;
}

function listFiles(dir, extension) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(extension))
    .map((f) => path.join(dir, f));
}

let failed = false;

const panelFiles = listFiles(path.join(REPO_ROOT, "cep", "js"), ".js")
  // Adobe's own library; we do not control it and do not ship changes to it.
  .filter((f) => !f.endsWith("CSInterface.js"));

for (const file of panelFiles) {
  for (const problem of check(file, FORBIDDEN)) {
    failed = true;
    console.error(
      `${path.relative(REPO_ROOT, file)}:${problem.line}  ${problem.name} ` +
      `needs ${problem.since}, but Illustrator 2020 runs CEP 9 / Chromium 61.`
    );
  }
}

for (const file of listFiles(path.join(REPO_ROOT, "cep", "host"), ".jsx")) {
  for (const problem of check(file, EXTENDSCRIPT_FORBIDDEN)) {
    failed = true;
    console.error(
      `${path.relative(REPO_ROOT, file)}:${problem.line}  ${problem.name} ` +
      `is ${problem.since}; ExtendScript is ES3.`
    );
  }
}

if (failed) {
  console.error(
    "\nThis syntax parses in CI but would stop the panel loading on an " +
    "advertised host.\nSee the runtime section of CONTRIBUTING.md. If you " +
    "intend to drop support for older\nIllustrator versions, raise the Host " +
    "range in cep/CSXS/manifest.xml first."
  );
  process.exit(1);
}

console.log(
  `Panel syntax OK — ${panelFiles.length} panel file(s) against ` +
  "Chromium 61, and the ExtendScript against ES3."
);
