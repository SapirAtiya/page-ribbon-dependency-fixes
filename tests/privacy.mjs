import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { cleanPaths } from '../scripts/clean-paths.mjs';
import { verifyDiagnosticTokens } from '../scripts/verify-diagnostic-tokens.mjs';

const require = createRequire(path.join(process.env.DEPENDENCY_CONSUMER_ROOT, 'package.json'));
const acorn = require('acorn');
const prefix = 'private-test-cache-' + '0'.repeat(64);
const rules = { pattern: new RegExp(prefix, 'g') };

test('diagnostic cleanup retains every token position and line', () => {
  const before = `// ${prefix}/source.js\nconst load = __commonJS({"${prefix}/source.js"(exports){exports.answer=42;}});`;
  const result = cleanPaths(before, rules);
  assert.equal(result.code.length, before.length);
  assert.equal(result.changes.length, 2);
  assert.equal(verifyDiagnosticTokens(before, result.code, acorn).moduleLabels, 1);
});

test('runtime values and executable tokens cannot be changed by the diagnostic verifier', () => {
  const before = `const runtimePath = "${prefix}/source.js";`;
  assert.throws(() => verifyDiagnosticTokens(before, cleanPaths(before, rules).code, acorn), /runtime string/);
  assert.throws(() => verifyDiagnosticTokens('const answer=1;', 'const answer=2;', acorn));
});

test('the embedded proxy worker is checked recursively', () => {
  const worker = `// ${prefix}/source.js\nconst load = __commonJS({"${prefix}/source.js"(exports){exports.answer=42;}});`;
  const before = `var ProxyServerWorker_default = ${JSON.stringify(worker)};`;
  const result = cleanPaths(before, rules);
  assert.equal(verifyDiagnosticTokens(before, result.code, acorn).embeddedWorkers, 1);
});

test('only the exact prepared fork version metadata change is accepted', () => {
  const before = 'version2 = "4.148.0+page-ribbon.undici.1";';
  assert.equal(verifyDiagnosticTokens(before, before.replace('+', '-'), acorn).forkVersions, 1);
  assert.throws(() => verifyDiagnosticTokens(before, before.replace('undici.1', 'undici.2'), acorn));
});
