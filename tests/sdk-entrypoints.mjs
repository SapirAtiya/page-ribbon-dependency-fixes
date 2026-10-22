import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = process.env.DEPENDENCY_CONSUMER_ROOT;
const require = createRequire(path.join(consumer, 'package.json'));
const plan = JSON.parse(fs.readFileSync(path.join(root, 'PUBLICATION_PLAN.json')));

test('all six real installed identities and publication guards match the reviewed plan', () => {
  for (const record of plan.packages) {
    const directory = path.join(consumer, 'node_modules', record.importKey);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    assert.equal(pkg.name, record.name); assert.equal(pkg.version, record.version);
    assert.equal(pkg.private, false); assert.equal(pkg.publishConfig.provenance, true); assert.equal(plan.publishingEnabled, false); assert.ok(!fs.lstatSync(directory).isSymbolicLink());
  }
});

test('actual Wrangler API, CLI version and ESM Vite plugin remain usable', async () => {
  assert.equal(typeof require('wrangler').unstable_dev, 'function');
  const entry = path.join(consumer, 'actual-plugin-entry.mjs');
  fs.writeFileSync(entry, 'export * from "@cloudflare/vite-plugin";\n');
  const plugin = await import(pathToFileURL(entry));
  assert.equal(typeof plugin.cloudflare, 'function'); assert.ok(Array.isArray(plugin.cloudflare()));
  const version = execFileSync(process.execPath, [path.join(consumer, 'node_modules/wrangler/bin/wrangler.js'), '--version'], {cwd: consumer, env: process.env, encoding: 'utf8', windowsHide: true});
  assert.equal(version.trim(), plan.packages.find(p => p.importKey === 'wrangler').version);
});
