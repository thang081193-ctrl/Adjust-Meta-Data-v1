// docs/diagnostics/syntax-check.mjs
// Parse EVERY shipped .js file and fail loudly on a syntax error.
//
// WHY THIS EXISTS (2026-09-21)
// popup/popup.js v0.12.2 shipped with four single-quoted strings broken across
// raw newlines inside checkWorkerBuild(). A single-quoted string cannot contain
// a literal newline, so the file was a SyntaxError — and because popup.js is an
// ES module, a parse error means NOT ONE LINE of it runs. Chrome shows no error
// box, no console banner in the page: the popup simply renders its static HTML
// and stops. Symptom on screen was "Loading…" that never resolved plus an empty
// Adjust account dropdown, which reads like a data/network bug and sent the
// investigation at the Adjust API instead of at the parser.
//
// THE TRAP INSIDE THE TRAP
//   node --check popup/popup.js            -> exit 0   (WRONG, misses it)
//   node --input-type=module --check < f   -> exit 1   (correct)
// Plain `node --check` on a .js path parses as CommonJS first and its ESM
// fallback swallows the error. Always pipe through stdin with --input-type.
//
// USAGE
//   node docs/diagnostics/syntax-check.mjs
// Exit code 0 = every file parses, 1 = at least one is broken.

import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Everything the manifest actually loads. Keep in sync with manifest.json.
const DIRS = ['', 'src', 'content', 'popup'];

async function collect() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.js')) out.push(path.join(d, e.name));
    }
  }
  return out.sort();
}

function checkModule(source) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--check'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ ok: code === 0, stderr }));
    child.stdin.end(source);
  });
}

const files = await collect();
let broken = 0;

for (const rel of files) {
  const source = await readFile(path.join(ROOT, rel), 'utf8');
  const { ok, stderr } = await checkModule(source);
  if (ok) {
    console.log(`  ok      ${rel}`);
    continue;
  }
  broken += 1;
  // Node reports the offending line as "[stdin]:<n>" — rewrite it to the real
  // path so the output is click-through in a terminal.
  const where = stderr.match(/^\[stdin\]:(\d+)/m);
  const reason = stderr.match(/^(SyntaxError:.*)$/m);
  console.log(`  BROKEN  ${rel}:${where ? where[1] : '?'}  ${reason ? reason[1] : ''}`);
  console.log(
    stderr.split('\n').slice(0, 6).map((l) => `            ${l}`).join('\n')
  );
}

console.log(
  broken
    ? `\n${broken}/${files.length} file(s) fail to parse — the extension is BROKEN on load.`
    : `\n${files.length} file(s) parse clean.`
);
process.exit(broken ? 1 : 0);
