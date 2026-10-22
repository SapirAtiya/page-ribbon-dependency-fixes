import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root } from '../scripts/pack.mjs';
import { assertPreparationContext, assertStatement, expectedPackages, readRelease, certificatePolicy, signingIdentity } from '../scripts/first-release.mjs';

const repository = 'SapirAtiya/page-ribbon-dependency-fixes';
const expected = { commit: 'a'.repeat(40), runId: '12345', attempt: '1' };
const context = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish.yml@refs/heads/main`, GITHUB_EVENT_NAME: 'workflow_dispatch', RUNNER_ENVIRONMENT: 'github-hosted', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic', ACTIONS_ID_TOKEN_REQUEST_URL: 'synthetic', GITHUB_SHA: expected.commit, GITHUB_RUN_ID: expected.runId, GITHUB_RUN_ATTEMPT: expected.attempt };
const record = expectedPackages()[0];
const statement = { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: record.purl, digest: { sha512: record.sha512 } }], predicate: { buildDefinition: { buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1', externalParameters: { workflow: { ref: 'refs/heads/main', repository: `https://github.com/${repository}`, path: '.github/workflows/publish.yml' } }, internalParameters: { github: { event_name: 'workflow_dispatch' } }, resolvedDependencies: [{ uri: `git+https://github.com/${repository}@refs/heads/main`, digest: { gitCommit: expected.commit } }] }, runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' }, metadata: { invocationId: `https://github.com/${repository}/actions/runs/${expected.runId}/attempts/${expected.attempt}` } } } };

test('proof preparation requires the reviewed hosted workflow without an npm credential', () => {
  assertPreparationContext(context);
  for (const [key, value] of [['GITHUB_ACTIONS', 'false'], ['GITHUB_REPOSITORY', 'other/repo'], ['GITHUB_REF', 'refs/pull/1/merge'], ['GITHUB_WORKFLOW_REF', 'other'], ['GITHUB_EVENT_NAME', 'pull_request'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', ''], ['GITHUB_SHA', 'other'], ['NPM_TOKEN', 'synthetic'], ['NODE_AUTH_TOKEN', 'synthetic']]) assert.throws(() => assertPreparationContext({ ...context, [key]: value }));
});

test('signed subjects must identify the exact reviewed package bytes and protected source run', () => {
  assertStatement(statement, record, expected);
  for (const change of [
    value => { value.subject[0].name = 'pkg:npm/other@1.0.0'; },
    value => { value.subject[0].digest.sha512 = 'b'.repeat(128); },
    value => { value.subject.push(value.subject[0]); },
    value => { value.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/other'; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/other/repo'; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; },
    value => { value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'b'.repeat(40); },
    value => { value.predicate.buildDefinition.internalParameters.github.event_name = 'pull_request'; },
    value => { value.predicate.runDetails.builder.id = 'https://github.com/actions/runner/self-hosted'; },
    value => { value.predicate.runDetails.metadata.invocationId += '2'; },
  ]) {
    const altered = structuredClone(statement); change(altered);
    assert.throws(() => assertStatement(altered, record, expected));
  }
});

test('certificate fields retain exact DER comparisons and the workflow identity is an anchored literal', () => {
  const tools = process.env.DEPENDENCY_PUBLISHER_TOOLS || path.join(root, '.artifacts/tools');
  const require = createRequire(path.join(tools, 'npm/package.json'));
  const policy = require('./node_modules/sigstore/dist/config.js').createVerificationPolicy(certificatePolicy(expected));
  const { verifyOIDs, verifySubjectAlternativeName } = require('./node_modules/@sigstore/verify/dist/policy.js');
  const oid = { id: [1, 3, 6, 1, 4, 1, 57264, 1, 11] };
  const runnerPolicy = policy.oids.filter(item => item.oid.id.join('.') === oid.id.join('.'));
  assert.equal(runnerPolicy.length, 1);
  const certificateValue = Buffer.from('0c0d6769746875622d686f73746564', 'hex');
  verifyOIDs(runnerPolicy, [{ oid, value: certificateValue }]);
  assert.throws(() => verifyOIDs([{ oid, value: Buffer.from('github-hosted') }], [{ oid, value: certificateValue }]));
  assert.throws(() => verifyOIDs(runnerPolicy, [{ oid, value: Buffer.from('0c0b73656c662d686f73746564', 'hex') }]));
  verifySubjectAlternativeName(policy.subjectAlternativeName, signingIdentity);
  for (const identity of [signingIdentity + '/other', 'prefix-' + signingIdentity, signingIdentity.replace('github.com', 'githubXcom'), signingIdentity.replace('publish.yml', 'publishXyml')]) assert.throws(() => verifySubjectAlternativeName(policy.subjectAlternativeName, identity));
});

test('artifact inspection rejects changed bytes, unknown files and an unreviewed run before cryptographic verification', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'first-release-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('first-release-test-'));
    fs.rmSync(directory, { recursive: true });
  });
  const packages = expectedPackages();
  const packRoot = process.env.DEPENDENCY_PACK_ROOT;
  assert.ok(packRoot, 'Run the full package check before the standalone artifact regression test');
  for (const item of packages) {
    fs.copyFileSync(path.join(packRoot, item.archiveName), path.join(directory, item.archiveName));
    const payload = structuredClone(statement);
    payload.subject = [{ name: item.purl, digest: { sha512: item.sha512 } }];
    fs.writeFileSync(path.join(directory, item.bundleName), JSON.stringify({ dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(payload)).toString('base64') } }));
  }
  const manifest = { schemaVersion: 1, repository, workflow: '.github/workflows/publish.yml', ref: 'refs/heads/main', ...expected, packages };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.equal(readRelease(directory, expected).proofs.length, 6, 'This parsing check does not authenticate the synthetic unsigned bundles');
  assert.throws(() => readRelease(directory, { ...expected, runId: '54321' }));
  fs.writeFileSync(path.join(directory, 'unexpected.txt'), 'synthetic');
  assert.throws(() => readRelease(directory, expected), /Unexpected release artifact files/);
  fs.unlinkSync(path.join(directory, 'unexpected.txt'));
  const archive = path.join(directory, packages[0].archiveName);
  const bytes = fs.readFileSync(archive); bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(archive, bytes);
  assert.throws(() => readRelease(directory, expected), /Reviewed archive changed/);
});
