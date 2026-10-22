import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(fs.readFileSync(path.join(root, 'PUBLISHER.json')));
const digest = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const option = key => process.argv.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3);
export async function bootstrap(output, localArchives = {}) {
  assert.equal(process.version, 'v' + pin.node, 'Use the pinned portable/hosted Node runtime');
  assert.equal(process.versions.undici, '7.30.1');
  assert.ok(!fs.existsSync(output), 'Refuse to overwrite an existing tool capsule');
  fs.mkdirSync(output, { recursive: true });
  for (const [name, record] of [['pnpm', pin], ['npm', pin.auditClient]]) {
    const bytes = localArchives[name] ? fs.readFileSync(localArchives[name]) : Buffer.from(await (await fetch(record.archive)).arrayBuffer());
    assert.equal(digest(bytes), record.sha256);
    assert.equal('sha512-' + digest(bytes, 'sha512'), record.integrity);
    const archive = path.join(output, name + '.tgz'), destination = path.join(output, name);
    fs.writeFileSync(archive, bytes); fs.mkdirSync(destination);
    const members = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    assert.ok(members.every(member => member.startsWith('package/') && !member.includes('\\') && !member.includes(':') && !member.split('/').includes('..')));
    const listings = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/);
    assert.ok(listings.every(line => line[0] === '-' || line[0] === 'd'), 'No archive links or special files');
    execFileSync('tar', ['-xf', archive, '-C', destination, '--strip-components=1'], { windowsHide: true });
  }
  assert.equal(digest(fs.readFileSync(path.join(output, 'pnpm/bin/pnpm.mjs'))), pin.entrySha256);
  assert.equal(digest(fs.readFileSync(path.join(output, 'pnpm/dist/pnpm.mjs'))), pin.bundleSha256);
  const old = path.join(output, 'npm/node_modules/undici'), saved = path.join(output, 'original-npm-undici');
  const fixed = path.join(output, 'pnpm/dist/node_modules/undici');
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'package.json'))).version, '6.28.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixed, 'package.json'))).version, pin.auditClient.replacement.version);
  for (const file of pin.auditClient.replacement.files) assert.equal(digest(fs.readFileSync(path.join(fixed, file.path))), file.sha256);
  fs.renameSync(old, saved); fs.cpSync(fixed, old, { recursive: true });
  const bin = path.join(output, 'bin'); fs.mkdirSync(bin);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\n"' + process.execPath + '" "' + path.join(output, 'npm/bin/npm-cli.js') + '" %*\r\n');
  } else {
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexec "' + process.execPath + '" "' + path.join(output, 'npm/bin/npm-cli.js') + '" "$@"\n', { mode: 0o755 });
  }
  console.log(JSON.stringify({ toolCapsule: output, pnpm: pin.version, npm: pin.auditClient.version, bundledUndici: pin.auditClient.replacement.version, installedToolsChanged: false }));
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bootstrap(path.resolve(option('out') || path.join(root, '.artifacts/tools')), { pnpm: option('pnpm-archive'), npm: option('npm-archive') });
