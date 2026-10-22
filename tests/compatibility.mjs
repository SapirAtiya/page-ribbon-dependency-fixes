import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { after, test } from 'node:test';





const consumer = process.env.DEPENDENCY_CONSUMER_ROOT;
if (!consumer) throw new Error('Run scripts/check.mjs to create the isolated consumer');
const require = createRequire(path.join(consumer, 'package.json'));
const { ESLint } = require('eslint');
const { globSync } = require('@page-and-ribbon/glob-sync');
const { parseExpressionAt } = require('acorn');
const commonjs = require('vite-plugin-commonjs').default;
const dynamicEsm = await import(pathToFileURL(require.resolve('vite-plugin-dynamic-import').replace(/index\.js$/, 'index.mjs')));

const dynamicCjs = require('vite-plugin-dynamic-import');
const { getRootDirs } = require('@next/eslint-plugin-next/dist/utils/get-root-dirs.js');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'page-ribbon-glob-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const fixtures = [
  'a.js', 'z.js', '.hidden.js', 'one/a.js', 'one/sub/b.js', 'two/c.js',
  'app/account/page.ts', 'app/[id]/page.ts', 'modules/item.js', 'modules/item.ts',
  'modules/item/index.js', 'modules/other/index.ts', 'modules/sub/nested.js',
  ...Array.from({ length: 21 }, (_, i) => 'migrations/' + String(i + 1).padStart(4, '0') + '_migration.sql'),
];
for (const relative of fixtures) {
  const full = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'export default 1;\n');
}
const glob = (patterns, options = {}) => globSync(patterns, { cwd, ...options });

test('consumer discovery preserves static priority, base order, duplicates and dot exclusion', () => {
  assert.deepEqual(glob(['two/*.js', 'one/*.js', 'a.js', './a.js']), ['a.js', 'two/c.js', 'one/a.js']);
  assert.deepEqual(glob('./one/*.js'), ['./one/a.js']);
  assert.deepEqual(glob(['**/*.js', '!modules/**', '!app/**']), ['a.js', 'z.js', 'one/a.js', 'two/c.js', 'one/sub/b.js']);
});

test('brace alternatives and padded, descending and stepped ranges retain exact file sets', () => {
  assert.deepEqual(glob('modules/*.{ts,js}'), ['modules/item.js', 'modules/item.ts']);
  assert.equal(glob('migrations/00{01..21}_*.sql').length, 21);
  assert.deepEqual(glob('migrations/000{9..1..2}_*.sql'), [1, 3, 5, 7, 9].map(n => 'migrations/000' + n + '_migration.sql'));
  assert.deepEqual(glob('modules/@(item|missing).js'), ['modules/item.js']);
});

test('directories retain literal spelling, suffixes, absolute paths and parent paths', () => {
  assert.deepEqual(glob('app/account', { onlyDirectories: true }), ['app/account']);
  assert.deepEqual(glob('app/account/', { onlyDirectories: true }), ['app/account/']);
  assert.deepEqual(glob('./', { onlyDirectories: true }), ['./']);
  assert.deepEqual(glob('modules/**/'), []);
  const absolute = path.join(cwd, 'app/account').replace(/\\/g, '/');
  assert.deepEqual(glob(absolute, { onlyDirectories: true }), [absolute]);
  const parent = '../' + path.basename(cwd) + '/one/*.js';
  assert.deepEqual(glob(parent), ['../' + path.basename(cwd) + '/one/a.js']);
  assert.deepEqual(glob('app/[[]id]/*.ts'), ['app/[id]/page.ts']);
});

test('symlink or junction directories and their children remain discoverable in order', () => {
  const link = path.join(cwd, 'alias');
  fs.symlinkSync(path.join(cwd, 'modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.deepEqual(glob('*', { onlyDirectories: true }), ['alias', 'app', 'migrations', 'modules', 'one', 'two']);
    assert.deepEqual(glob('alias/**/*.js'), ['alias/item.js', 'alias/item/index.js', 'alias/sub/nested.js']);
  } finally { fs.unlinkSync(link); }
});

test('permission errors fail discovery instead of returning a partial inventory', () => {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const error = Object.assign(new Error(code), { code });
    assert.throws(() => glob('**/*.js', { fs: { readdirSync() { throw error; } } }), observed => observed === error);
    assert.throws(() => glob('a.js', { fs: { statSync() { throw error; } } }), observed => observed === error);
  }
  assert.deepEqual(glob('**/*.js', { fs: { readdirSync() { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } } }), []);
});

test('excessive expansion, nesting, and rewritten brace inputs fail explicitly', () => {
  for (const pattern of ['{1..999999999}', '{a,b}'.repeat(20), '{'.repeat(5000) + 'x' + '}'.repeat(5000), '{a}' + '}'.repeat(3000) + ',z}']) {
    assert.throws(() => glob(pattern), { name: 'RangeError', message: /supported build-pattern budget/ });
  }
  assert.throws(() => glob('*.js', { ignore: '*.ts' }), /Unsupported consumer glob option/);
});

test('the real lint helper preserves fallback roots, normalization and separate array entries', () => {
  assert.deepEqual(getRootDirs({ cwd: 'context-root', settings: {} }), ['context-root']);
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    assert.deepEqual(getRootDirs({ cwd, settings: { next: { rootDir: 'app\\account' } } }), ['app/account']);
    assert.deepEqual(getRootDirs({ cwd, settings: { next: { rootDir: ['app/account', 12, 'app/account'] } } }), ['app/account', 'app/account']);
  } finally { process.chdir(previous); }
});

test('both dynamic-import module formats preserve strict and loose import file priority', async () => {
  for (const plugin of [dynamicEsm, dynamicCjs]) for (const loose of [false, true]) {
    const expression = '`./modules/${name}`';
    const result = await plugin.globFiles({
      importeeNode: parseExpressionAt(expression, 0, { ecmaVersion: 'latest' }),
      importExpression: 'import(' + expression + ')',
      importer: path.join(cwd, 'entry.js'), resolve: { async tryResolve() {} },
      extensions: ['.ts', '.js'], loose,
    });
    assert.deepEqual(result.files, loose
      ? ['./modules/item.js', './modules/item.ts', './modules/item/index.js', './modules/other/index.ts', './modules/sub/nested.js']
      : ['./modules/item.js', './modules/item.ts', './modules/item/index.js', './modules/other/index.ts']);
  }
});

test('the real CommonJS plugin retains dynamic require aliases and missing-module failure', async () => {
  const plugin = commonjs({ dynamic: { loose: false } });
  plugin.configResolved({ root: cwd, resolve: { extensions: ['.js', '.ts'], alias: [] }, optimizeDeps: {}, createResolver: () => async () => undefined });
  const result = await plugin.transform('module.exports = require(`./modules/${name}`);', path.join(cwd, 'entry.js'));
  assert.ok(result?.code.includes('./modules/item.js'));
  assert.ok(result.code.includes('./modules/other/index.ts'));
  assert.ok(result.code.includes("default: throw new Error"));
});

test('the Next package and vulnerable glob components are absent from the installed lock graph', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json')));
  assert.deepEqual(Object.keys(lock.packages).filter(key => /(?:^|\/)node_modules\/(?:next|fast-glob|micromatch|braces)$/.test(key)), []);
  assert.throws(() => require.resolve('next/package.json'), { code: 'MODULE_NOT_FOUND' });
  for (const [key, name] of [['eslint-config-next','@page-and-ribbon/eslint-config-next'], ['@next/eslint-plugin-next','@page-and-ribbon/eslint-plugin-next'], ['vite-plugin-dynamic-import','@page-and-ribbon/vite-plugin-dynamic-import']]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules', key, 'package.json'))).name, name);
  }
});

// Baseline rule fingerprints were measured independently before Next removal.
test('all measured consumer lint rules remain identical and the link rule still reports', async () => {
  const web = consumer;
  const engine = new ESLint({ cwd: web, overrideConfigFile: path.join(web, 'eslint.config.mjs') });
  for (const [file, count, hash] of [
    ['fixtures/page.tsx', 112, 'e4406d7155aed8793185a34e3b32cec1c7363c7a44c0c06d7bc80a180d224789'],
    ['fixtures/module.ts', 112, 'e4406d7155aed8793185a34e3b32cec1c7363c7a44c0c06d7bc80a180d224789'],
    ['fixtures/task.mjs', 89, '5b898cf396a01b4b8c84d9f92a8a27e2d661707514415dc72f81c5064af4dc65'],
  ]) {
    const config = await engine.calculateConfigForFile(path.join(web, file));
    const rules = Object.fromEntries(Object.entries(config.rules).sort(([a], [b]) => a.localeCompare(b)));
    assert.equal(Object.keys(rules).length, count);
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex'), hash);
    assert.equal(config.languageOptions.parser.meta.name, 'typescript-eslint/parser');
  }
  fs.mkdirSync(path.join(cwd, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'pages/account.js'), 'export default 1;');
  const scoped = new ESLint({ cwd: web, overrideConfigFile: path.join(web, 'eslint.config.mjs'), overrideConfig: { settings: { next: { rootDir: cwd } } } });
  const [result] = await scoped.lintText('export default function Fixture() { return <a href="/account">Account</a>; }', { filePath: path.join(web, 'tests/dependency-link-fixture.tsx') });
  assert.ok(result.messages.some(message => message.ruleId === '@next/next/no-html-link-for-pages'));
});

function reviewFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-ribbon-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'export default 1;');
  }
  return root;
}
async function discoveredImports(plugin, root, expression, loose) {
  const result = await plugin.globFiles({
    importeeNode: parseExpressionAt(expression, 0, { ecmaVersion: 'latest' }),
    importExpression: 'import(' + expression + ')', importer: path.join(root, 'entry.js'),
    resolve: { async tryResolve() {} }, extensions: ['.js', '.ts'], loose,
  });
  return result.files;
}

// Baseline-backed regression controls from the independent compatibility review.
test('nested brace ranges retain every lint root and the actual link rule', async t => {
  const root = reviewFixture(t, ['{a1}/pages/account.js', '{a2}/pages/contact.js', '{a3}/pages/index.js']);
  const rootDir = root.replace(/\\/g, '/') + '/{a{1..3}}';
  assert.deepEqual(getRootDirs({ cwd: root, settings: { next: { rootDir } } }),
    ['{a1}', '{a2}', '{a3}'].map(name => root.replace(/\\/g, '/') + '/' + name));
  const web = consumer;
  const engine = new ESLint({ cwd: web, overrideConfigFile: path.join(web, 'eslint.config.mjs'), overrideConfig: { settings: { next: { rootDir } } } });
  const [result] = await engine.lintText('export default function Fixture(){ return <a href="/account">Account</a>; }', { filePath: path.join(web, 'tests/nested-range-fixture.tsx') });
  assert.ok(result.messages.some(message => message.ruleId === '@next/next/no-html-link-for-pages'));
});

test('literal brace-named import folders are never rewritten to different folders', async t => {
  const root = reviewFixture(t, ['{a},b}/one.js', 'a}/one.js', 'b/one.js']);
  for (const plugin of [dynamicEsm, dynamicCjs]) for (const loose of [false, true]) {
    assert.deepEqual(await discoveredImports(plugin, root, '`./{a},b}/${name}.js`', loose), ['./{a},b}/one.js']);
  }
});

test('parent segments after variables preserve both original import-discovery modes', async t => {
  const root = reviewFixture(t, ['modules/a.js', 'modules/b.ts', 'modules/deep/c.js']);
  for (const plugin of [dynamicEsm, dynamicCjs]) for (const loose of [false, true]) {
    assert.deepEqual(await discoveredImports(plugin, root, '`./modules/${name}.js`', loose),
      loose ? ['./modules/a.js', './modules/deep/c.js'] : ['./modules/a.js']);
    assert.deepEqual(await discoveredImports(plugin, root, '`./modules/${name}/../${other}.js`', loose), []);
  }
});

test('noncyclic nested junctions retain modules when target names share a prefix', async t => {
  const root = reviewFixture(t, ['packages/pkg/first.js', 'packages/pkg-other/second.js']);
  fs.mkdirSync(path.join(root, 'linked'));
  fs.symlinkSync(path.join(root, 'packages/pkg'), path.join(root, 'linked/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.join(root, 'packages/pkg-other'), path.join(root, 'packages/pkg/child'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const plugin of [dynamicEsm, dynamicCjs]) {
    assert.deepEqual(await discoveredImports(plugin, root, '`./linked/${name}.js`', true),
      ['./linked/alias/first.js', './linked/alias/child/second.js']);
  }
});

test('literal wrappers, escaped commas and zero-step ranges retain baseline roots', t => {
  const root = reviewFixture(t, ['{1}/x.js', '{2}/x.js', '{3}/x.js', '{a}xb/x.js', '{a}xc/x.js', 'a,b/x.js', 'c/x.js']);
  const discover = pattern => globSync(pattern, { cwd: root, onlyDirectories: true });
  assert.deepEqual(discover('{{1..3}}'), ['{1}', '{2}', '{3}']);
  assert.deepEqual(discover('{a}x{b,c}'), ['{a}xb', '{a}xc']);
  assert.deepEqual(discover(String.raw`{a\,b,c}`), ['c', 'a,b']);
  assert.deepEqual(discover('{{1..3..0}}'), ['{1}', '{2}', '{3}']);
  for (const pattern of ['{9007199254740992..9007199254740993}', '{1..3..9007199254740992}', '{1..10000}{1..10000}']) {
    assert.throws(() => discover(pattern), { name: 'RangeError', message: /supported build-pattern budget/ });
  }
});

test('finite descendant links and independent aliases retain every module', async t => {
  const root = reviewFixture(t, ['packages/pkg/first.js', 'packages/pkg/sub/second.js']);
  fs.mkdirSync(path.join(root, 'linked'));
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  for (const alias of ['one', 'two']) fs.symlinkSync(path.join(root, 'packages/pkg'), path.join(root, 'linked', alias), kind);
  fs.symlinkSync(path.join(root, 'packages/pkg/sub'), path.join(root, 'packages/pkg/shortcut'), kind);
  for (const plugin of [dynamicEsm, dynamicCjs]) {
    assert.deepEqual(await discoveredImports(plugin, root, '`./linked/${name}.js`', true), [
      './linked/one/first.js', './linked/two/first.js',
      './linked/one/shortcut/second.js', './linked/one/sub/second.js',
      './linked/two/shortcut/second.js', './linked/two/sub/second.js',
    ]);
  }
});

test('real directory cycles fail explicitly while dangling links preserve good siblings', t => {
  const root = reviewFixture(t, ['modules/first.js', 'modules/sub/second.js']);
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'modules/broken'), kind);
  assert.deepEqual(globSync('modules/**/*.js', { cwd: root }), ['modules/first.js', 'modules/sub/second.js']);
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const fault = Object.assign(new Error(code), { code });
    assert.throws(() => globSync('modules/**/*.js', { cwd: root, fs: {
      statSync(full, ...args) {
        if (path.basename(String(full)) === 'broken') throw fault;
        return fs.statSync(full, ...args);
      },
    } }), error => error === fault);
  }
  fs.symlinkSync(path.join(root, 'modules'), path.join(root, 'modules/sub/back'), kind);
  assert.throws(() => globSync('modules/**/*.js', { cwd: root }), { code: 'ELOOP' });
  if (process.platform === 'win32') {
    fs.unlinkSync(path.join(root, 'modules/sub/back'));
    const lowerDrive = path.join(root, 'modules').replace(/^[A-Z]:/, drive => drive.toLowerCase());
    fs.symlinkSync(lowerDrive, path.join(root, 'modules/sub/back'), kind);
    assert.throws(() => globSync('modules/**/*.js', { cwd: root }), { code: 'ELOOP' });
  }
});

test('pruning avoids irrelevant and explicitly excluded directories without hiding errors', t => {
  const root = reviewFixture(t, ['allowed/first.js', 'blocked/nested/second.js', 'unrelated/third.js']);
  const fault = Object.assign(new Error('denied'), { code: 'EACCES' });
  const filesystem = { readdirSync(full, ...args) {
    if (['blocked', 'unrelated'].includes(path.basename(String(full)))) throw fault;
    return fs.readdirSync(full, ...args);
  } };
  assert.deepEqual(globSync('allowed/*.js', { cwd: root, fs: filesystem }), ['allowed/first.js']);
  assert.deepEqual(globSync(['**/*.js', '!blocked/**', '!unrelated/**'], { cwd: root, fs: filesystem }), ['allowed/first.js']);
  assert.throws(() => globSync('**/*.js', { cwd: root, fs: filesystem }), error => error === fault);
});

test('literal brace-and-dot lint roots retain spelling and expansion order', t => {
  const root = reviewFixture(t, ['{a.a}/x.js', '{b.b}/x.js']);
  const previous = process.cwd();
  process.chdir(root);
  try {
    assert.deepEqual(getRootDirs({ cwd: root, settings: { next: { rootDir: './{a.a}/' } } }), ['./{a.a}/']);
    assert.deepEqual(getRootDirs({ cwd: root, settings: { next: { rootDir: '{{b.b},{a.a}}' } } }), ['{b.b}', '{a.a}']);
  } finally { process.chdir(previous); }
});

test('fixed-depth ancestor links terminate naturally and preserve strict imports', async t => {
  const root = reviewFixture(t, ['modules/top.js']);
  fs.mkdirSync(path.join(root, 'modules/sub'));
  fs.symlinkSync(path.join(root, 'modules'), path.join(root, 'modules/sub/back'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(globSync('modules/*/*/*.js', { cwd: root }), ['modules/sub/back/top.js']);
  for (const plugin of [dynamicEsm, dynamicCjs]) {
    assert.deepEqual(await discoveredImports(plugin, root, '`./modules/${first}/${second}/${name}.js`', false), ['./modules/sub/back/top.js']);
    await assert.rejects(() => discoveredImports(plugin, root, '`./modules/${first}/${second}/${name}.js`', true), { code: 'ELOOP' });
  }
});
