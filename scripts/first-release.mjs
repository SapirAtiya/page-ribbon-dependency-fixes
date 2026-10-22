import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, plan, pack, inventory } from './pack.mjs';
import { assertClient } from './publisher.mjs';

const repository = 'SapirAtiya/page-ribbon-dependency-fixes';
const workflow = '.github/workflows/publish.yml';
export const signingIdentity = `https://github.com/${repository}/${workflow}@refs/heads/main`;
export const signingIssuer = 'https://token.actions.githubusercontent.com';
const hash = (bytes, algorithm) => crypto.createHash(algorithm).update(bytes).digest('hex');

export function expectedPackages() {
  assert.equal(plan.firstRelease?.approved, true, 'The one-time method requires owner approval');
  assert.equal(plan.firstRelease.method, 'local-publish-with-workflow-provenance');
  assert.equal(plan.firstRelease.archives.length, plan.packages.length);
  return plan.packages.map(record => {
    const pinned = plan.firstRelease.archives.find(value => value.folder === record.folder);
    assert.ok(pinned);
    assert.equal(pinned.name, record.name);
    assert.equal(pinned.version, record.version);
    assert.equal(pinned.archiveName, record.name.slice(1).replace('/', '-') + '-' + record.version + '.tgz');
    assert.equal(pinned.bundleName, pinned.archiveName + '.sigstore.json');
    assert.match(pinned.sha256, /^[a-f0-9]{64}$/);
    assert.match(pinned.sha512, /^[a-f0-9]{128}$/);
    assert.ok(Number.isSafeInteger(pinned.bytes) && pinned.bytes > 0);
    return pinned;
  });
}

export function assertPreparationContext(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflow}@refs/heads/main`);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(!env.NPM_TOKEN && !env.NODE_AUTH_TOKEN, 'No npm credential belongs in proof preparation');
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/);
}

export function assertStatement(statement, record, expected) {
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1');
  assert.deepEqual(statement.subject, [{ name: record.purl, digest: { sha512: record.sha512 } }]);
  const { buildDefinition, runDetails } = statement.predicate;
  assert.equal(buildDefinition.buildType, 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1');
  assert.deepEqual(buildDefinition.externalParameters.workflow, { ref: 'refs/heads/main', repository: `https://github.com/${repository}`, path: workflow });
  assert.equal(buildDefinition.internalParameters.github.event_name, 'workflow_dispatch');
  assert.deepEqual(buildDefinition.resolvedDependencies, [{ uri: `git+https://github.com/${repository}@refs/heads/main`, digest: { gitCommit: expected.commit } }]);
  assert.equal(runDetails.builder.id, 'https://github.com/actions/runner/github-hosted');
  assert.equal(runDetails.metadata.invocationId, `https://github.com/${repository}/actions/runs/${expected.runId}/attempts/${expected.attempt}`);
}

export function readRelease(directory, expected) {
  assert.match(expected.commit, /^[a-f0-9]{40}$/);
  assert.match(String(expected.runId), /^[1-9][0-9]*$/);
  assert.match(String(expected.attempt), /^[1-9][0-9]*$/);
  const packages = expectedPackages();
  assert.deepEqual(inventory(directory), ['manifest.json', ...packages.flatMap(record => [record.archiveName, record.bundleName])].sort(), 'Unexpected release artifact files');
  const readJson = filename => {
    const full = path.join(directory, filename);
    assert.ok(fs.statSync(full).size <= 256 * 1024, 'Oversized proof/manifest');
    return JSON.parse(fs.readFileSync(full));
  };
  const manifest = readJson('manifest.json');
  assert.deepEqual(manifest, { schemaVersion: 1, repository, workflow, ref: 'refs/heads/main', ...expected, packages });
  const proofs = packages.map(record => {
    const archive = path.join(directory, record.archiveName);
    assert.equal(fs.statSync(archive).size, record.bytes);
    const bytes = fs.readFileSync(archive);
    assert.equal(hash(bytes, 'sha256'), record.sha256, 'Reviewed archive changed');
    assert.equal(hash(bytes, 'sha512'), record.sha512, 'Reviewed archive changed');
    const bundle = readJson(record.bundleName);
    assert.equal(bundle.dsseEnvelope.payloadType, 'application/vnd.in-toto+json');
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    assertStatement(statement, record, expected);
    return { record, archive, bundle, bundlePath: path.join(directory, record.bundleName) };
  });
  return { manifest, proofs };
}

export async function verifyRelease(directory, expected, tools) {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'PUBLISHER.json')));
  assertClient(pin, tools);
  const release = readRelease(directory, expected);
  const require = createRequire(path.join(tools, 'npm/package.json'));
  // Fulcio's signed extensions bind the proof to the source commit as well as the workflow identity.
  const verifier = await require('sigstore').createVerifier({ certificateIssuer: signingIssuer, certificateIdentityURI: signingIdentity,
    certificateOIDs: { '1.3.6.1.4.1.57264.1.11': 'github-hosted', '1.3.6.1.4.1.57264.1.12': `https://github.com/${repository}`,
      '1.3.6.1.4.1.57264.1.13': expected.commit, '1.3.6.1.4.1.57264.1.14': 'refs/heads/main' } });
  for (const proof of release.proofs) {
    verifier.verify(proof.bundle);
  }
  return release;
}

async function prepare() {
  assertPreparationContext(process.env);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Use a clean reviewed commit');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), process.env.GITHUB_SHA);
  const tools = path.resolve(process.env.DEPENDENCY_PUBLISHER_TOOLS || path.join(root, '.artifacts/tools'));
  assertClient(JSON.parse(fs.readFileSync(path.join(root, 'PUBLISHER.json'))), tools);
  const output = path.join(root, '.artifacts/first-release');
  assert.ok(!fs.existsSync(output), 'Refuse to reuse proof output');
  const packages = expectedPackages();
  const packed = pack(output);
  const require = createRequire(path.join(tools, 'npm/package.json'));
  const { generateProvenance } = require('./node_modules/libnpmpublish/lib/provenance.js');
  for (const record of packages) {
    const actual = packed.find(value => value.folder === record.folder);
    const bytes = fs.readFileSync(actual.archive);
    assert.equal(bytes.length, record.bytes);
    assert.equal(hash(bytes, 'sha256'), record.sha256);
    assert.equal(hash(bytes, 'sha512'), record.sha512);
    const bundle = await generateProvenance([{ name: record.purl, digest: { sha512: record.sha512 } }], {});
    fs.writeFileSync(path.join(output, record.bundleName), JSON.stringify(bundle) + '\n', { flag: 'wx' });
  }
  const expected = { commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, repository, workflow, ref: 'refs/heads/main', ...expected, packages }, null, 2) + '\n', { flag: 'wx' });
  await verifyRelease(output, expected, tools);
  console.log(JSON.stringify({ prepared: packages.length, verified: true, npmUploads: 0, output }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--prepare'], 'This public helper only prepares signed proofs; it cannot publish');
  await prepare();
}
