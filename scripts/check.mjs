import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { root, plan, pack, npm } from './pack.mjs';

const output = path.resolve(process.argv.find(value => value.startsWith('--output='))?.slice(9) ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-package-check-')));
const packed = pack(path.join(output, 'packs'));
const consumer = path.join(output, 'consumer');
fs.mkdirSync(consumer, { recursive: true });
const dependencies = { ...plan.testDependencies };
for (const record of packed) dependencies[record.importKey] = 'file:../packs/' + record.archiveName;
// Keep the same two consumer overrides as the application; do not override the adapter's real version requirement.
const overrides = Object.fromEntries(packed.filter(record => ['@next/eslint-plugin-next', 'vite-plugin-dynamic-import'].includes(record.importKey))
  .map(record => [record.importKey, '$' + record.importKey]));
Object.assign(overrides, plan.testOverrides);
const manifest = { name: 'dependency-compatibility-fixture', version: '0.0.0', private: true, type: 'module', dependencies, overrides };
fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(consumer, 'eslint.config.mjs'),
  "import nextVitals from 'eslint-config-next/core-web-vitals';\nimport nextTs from 'eslint-config-next/typescript';\nexport default [...nextVitals, ...nextTs];\n");
const lockSource = path.join(root, 'tests', 'consumer-lock.json');
if (process.argv.includes('--write-lock')) {
  assert.ok(!fs.existsSync(lockSource), 'An existing reviewed lock must not be overwritten automatically');
  npm(['install', '--ignore-scripts', '--no-audit', '--registry', 'https://registry.npmjs.org'], consumer, { stdio: 'inherit' });
  fs.copyFileSync(path.join(consumer, 'package-lock.json'), lockSource);
} else {
  assert.ok(fs.existsSync(lockSource), 'The reviewed test lock is missing');
  fs.copyFileSync(lockSource, path.join(consumer, 'package-lock.json'));
  npm(['ci', '--strict-peer-deps', '--ignore-scripts', '--no-audit', '--registry', 'https://registry.npmjs.org'], consumer, { stdio: 'inherit' });
}
for (const record of packed) {
  const installed = JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules', record.importKey, 'package.json')));
  assert.equal(installed.name, record.name);
  assert.equal(installed.version, record.version);
  assert.ok(!fs.lstatSync(path.join(consumer, 'node_modules', record.importKey)).isSymbolicLink());
}
execFileSync(process.execPath, ['--test', path.join(root, 'tests', 'compatibility.mjs'), path.join(root, 'tests', 'privacy.mjs'), path.join(root, 'tests', 'sdk-entrypoints.mjs'), path.join(root, 'tests', 'publisher.mjs'), path.join(root, 'tests', 'first-release.mjs')], {
  cwd: consumer, env: { ...process.env, DEPENDENCY_CONSUMER_ROOT: consumer, DEPENDENCY_PACK_ROOT: path.join(output, 'packs') }, stdio: 'inherit',
});
npm(['audit', '--audit-level=high', '--registry', 'https://registry.npmjs.org'], consumer, { stdio: 'inherit' });
console.log(JSON.stringify({ functionalChecks: 'passed', output, packageCount: packed.length,
  registryAuthentication: 'not established for unpublished packages; existing application gate remains required',
  registryAliasTransport: 'not proven by local archive installs; must verify after approved registry publication' }));
