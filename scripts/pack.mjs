import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const plan = JSON.parse(fs.readFileSync(path.join(root, 'PUBLICATION_PLAN.json')));
export function npm(args, cwd, options = {}) {
  if (process.platform !== 'win32') return execFileSync('npm', args, { cwd, encoding: 'utf8', ...options });
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '& npm.cmd ' + args.map(quote).join(' ') + '; exit $LASTEXITCODE'], { cwd, encoding: 'utf8', ...options });
}
export function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Links are not permitted in publication source: ' + entry.name);
    const full = path.join(directory, entry.name), name = prefix + entry.name;
    return entry.isDirectory() ? inventory(full, name + '/') : [name];
  }).sort();
}
export function pack(output) {
  fs.mkdirSync(output, { recursive: true });
  return plan.packages.map(record => {
    const directory = path.join(root, 'packages', record.folder);
    assert.deepEqual(inventory(directory), record.files, 'Unexpected package source files: ' + record.name);
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'UPSTREAM.json'))).packages.find(pkg => pkg.name === record.name).files;
    for (const file of record.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex'), expected[file], 'Reviewed package bytes changed: ' + file);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    assert.equal(manifest.name, record.name);
    assert.equal(manifest.version, record.version);
    assert.ok(!manifest.scripts, 'Reviewed distributions have no lifecycle/build scripts');
    const info = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', output], directory))[0];
    assert.deepEqual(info.files.map(file => file.path).sort(), record.files, 'Actual npm payload differs: ' + record.name);
    return { ...record, archive: path.join(output, info.filename), archiveName: info.filename, pack: info };
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-package-pack-')));
  console.log(JSON.stringify(pack(output), null, 2));
}
