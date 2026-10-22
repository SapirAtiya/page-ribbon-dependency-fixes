import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, pack } from './pack.mjs';

export function publicationBlockers(plan, pin, context) {
  const blockers = [];
  for (const [label, value] of [
    ['publication approval', plan.publishingEnabled === true && pin.publishingEnabled === true],
    ['scope ownership', plan.scopeOwnershipVerified === true && pin.accountOwnershipVerified === true],
    ['public identity', plan.publisher.publicIdentityVerified === true],
    ['first-publication authentication', pin.liveAuthenticationVerified === true],
    ['exact repository', context.repository === plan.repository],
    ['main branch', context.ref === 'refs/heads/main'],
    ['exact publishing workflow', context.workflowRef === plan.repository + '/' + plan.publisher.workflow + '@refs/heads/main'],
    ['OIDC identity token permission', Boolean(context.oidcToken && context.oidcUrl)],
    ['no fallback publishing token', !context.npmToken && !context.nodeToken],
  ]) if (!value) blockers.push(label);
  return blockers;
}
export function publicationArguments(archive, dryRun) {
  return ['publish', archive, '--access', 'public', '--tag', 'language-fixes', '--provenance', '--ignore-scripts', '--registry', 'https://registry.npmjs.org/', ...(dryRun ? ['--dry-run'] : [])];
}
export function assertClient(pin, toolRoot) {
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(process.version, 'v' + pin.node);
  assert.equal(hash(path.join(toolRoot, 'pnpm/bin/pnpm.mjs')), pin.entrySha256);
  assert.equal(hash(path.join(toolRoot, 'pnpm/dist/pnpm.mjs')), pin.bundleSha256);
  for (const file of pin.auditClient.replacement.files) assert.equal(hash(path.join(toolRoot, 'npm/node_modules/undici', file.path)), file.sha256);
}
export function runPublisher(args = process.argv.slice(2), env = process.env) {
  assert.ok(args.length === 1 && ['--dry-run', '--publish'].includes(args[0]), 'Choose exactly --dry-run or --publish');
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'PUBLICATION_PLAN.json')));
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'PUBLISHER.json')));
  const dryRun = args[0] === '--dry-run';
  if (!dryRun) {
    const blockers = publicationBlockers(plan, pin, { repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, workflowRef: env.GITHUB_WORKFLOW_REF, oidcToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, oidcUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL, npmToken: env.NPM_TOKEN, nodeToken: env.NODE_AUTH_TOKEN });
    assert.deepEqual(blockers, [], 'Publishing remains blocked: ' + blockers.join(', '));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Publishing requires a clean reviewed commit');
  } else {
    assert.ok(!env.NPM_TOKEN && !env.NODE_AUTH_TOKEN && !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && !env.ACTIONS_ID_TOKEN_REQUEST_URL, 'Dry runs must have no publishing credentials or OIDC request capability');
  }
  const tools = path.resolve(env.DEPENDENCY_PUBLISHER_TOOLS || path.join(root, '.artifacts/tools'));
  assertClient(pin, tools);
  const output = path.join(root, '.artifacts', dryRun ? 'dry-run-packs' : 'publish-packs');
  const packages = pack(output);
  const order = ['glob-sync', 'eslint-plugin-next', 'eslint-config-next', 'vite-plugin-dynamic-import', 'wrangler', 'cloudflare-vite-plugin'];
  for (const folder of order) {
    const record = packages.find(p => p.folder === folder); assert.ok(record);
    execFileSync(process.execPath, [path.join(tools, 'pnpm/bin/pnpm.mjs'), ...publicationArguments(record.archive, dryRun)], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  }
  console.log(JSON.stringify({ dryRun, packages: packages.length, uploaded: !dryRun, publishingApproved: !dryRun }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runPublisher();
