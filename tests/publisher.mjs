import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { publicationBlockers, publicationArguments, runPublisher } from '../scripts/publisher.mjs';
import { parsePackInfo } from '../scripts/pack.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('../PUBLICATION_PLAN.json', import.meta.url)));
const pin = JSON.parse(fs.readFileSync(new URL('../PUBLISHER.json', import.meta.url)));
const context = { repository: plan.repository, ref: 'refs/heads/main', workflowRef: plan.repository + '/' + plan.publisher.workflow + '@refs/heads/main', oidcToken: 'synthetic', oidcUrl: 'synthetic' };
test('all current approval/ownership/authentication holds block publication even in the expected workflow', () => {
  assert.deepEqual(publicationBlockers(plan, pin, context), ['publication approval', 'scope ownership', 'public identity', 'first-publication authentication']);
  assert.throws(() => runPublisher(['--publish'], {}), /Publishing remains blocked/);
});
test('the reviewed workflow identity and token boundaries are checked independently', () => {
  const approved = structuredClone(plan), authenticated = structuredClone(pin);
  approved.publishingEnabled = approved.scopeOwnershipVerified = approved.publisher.publicIdentityVerified = true;
  authenticated.publishingEnabled = authenticated.accountOwnershipVerified = authenticated.liveAuthenticationVerified = true;
  assert.deepEqual(publicationBlockers(approved, authenticated, context), []);
  for (const [field, value, expected] of [['repository', 'other/repo', 'exact repository'], ['ref', 'refs/pull/1/merge', 'main branch'], ['workflowRef', 'other/workflow', 'exact publishing workflow'], ['oidcToken', '', 'OIDC identity token permission'], ['npmToken', 'synthetic', 'no fallback publishing token'], ['nodeToken', 'synthetic', 'no fallback publishing token']]) assert.ok(publicationBlockers(approved, authenticated, { ...context, [field]: value }).includes(expected));
});
test('publisher arguments retain provenance, strict destination and disabled lifecycle scripts', () => {
  const args = publicationArguments('reviewed.tgz', true);
  assert.ok(args.includes('--dry-run') && args.includes('--provenance') && args.includes('--ignore-scripts'));
  assert.ok(!args.includes('--force') && !args.includes('--no-git-checks'));
  assert.equal(args[args.indexOf('--registry') + 1], 'https://registry.npmjs.org/');
});
test('unknown flags and credentials cannot turn a dry run into publishing', () => {
  for (const args of [[], ['--force'], ['--publish', '--dry-run']]) assert.throws(() => runPublisher(args, {}));
  assert.throws(() => runPublisher(['--dry-run'], { NODE_AUTH_TOKEN: 'synthetic' }), /no publishing credentials/);
});
test('the pinned npm pack response identifies exactly one matching safe archive', () => {
  const record = { name: '@page-and-ribbon/glob-sync', version: '0.1.4' };
  const info = { ...record, filename: 'page-and-ribbon-glob-sync-0.1.4.tgz', files: [] };
  const output = value => JSON.stringify({ [record.name]: value });
  assert.deepEqual(parsePackInfo(output(info), record), info);
  assert.throws(() => parsePackInfo(JSON.stringify([info]), record));
  assert.throws(() => parsePackInfo(JSON.stringify({ [record.name]: info, other: info }), record));
  for (const invalid of [{ name: 'other' }, { version: '0.1.5' }, { filename: '../other.tgz' }, { files: null }]) {
    assert.throws(() => parsePackInfo(output({ ...info, ...invalid }), record));
  }
});
