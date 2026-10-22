import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export function verifyDiagnosticTokens(before, after, acorn) {
  const options = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true };
  const tree = acorn.parse(before, options), permitted = new Map(), pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      if (/^__(?:commonJS|esm)[\w$]*$/.test(node.callee.name) && node.arguments[0]?.type === 'ObjectExpression') {
        for (const property of node.arguments[0].properties) if (property.key?.type === 'Literal' && typeof property.key.value === 'string') permitted.set(property.key.start, 'module-label');
      }
      if (/^__name[\w$]*$/.test(node.callee.name) && node.arguments[1]?.type === 'Literal') permitted.set(node.arguments[1].start, 'function-label');
    }
    const target = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : null;
    const value = node.type === 'VariableDeclarator' ? node.init : node.type === 'AssignmentExpression' ? node.right : null;
    if (target?.type === 'Identifier' && target.name === 'version2' && value?.value === '4.148.0+page-ribbon.undici.1') permitted.set(value.start, 'fork-version');
    if (target?.type === 'Identifier' && target.name === 'ProxyServerWorker_default' && value?.type === 'Literal') permitted.set(value.start, 'embedded-worker');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) pending.push(child); }
      else if (value?.type) pending.push(value);
    }
  }
  const a = acorn.tokenizer(before, options), b = acorn.tokenizer(after, options);
  const changes = { moduleLabels: 0, functionLabels: 0, embeddedWorkers: 0, forkVersions: 0 };
  while (true) {
    const left = a.getToken(), right = b.getToken();
    assert.equal(left.type.label, right.type.label); assert.equal(left.start, right.start); assert.equal(left.end, right.end);
    if (!isDeepStrictEqual(left.value, right.value)) {
      assert.equal(left.type.label, 'string', 'Only diagnostic string values may change');
      const kind = permitted.get(left.start); assert.ok(kind, 'A runtime string changed outside a diagnostic position');
      if (kind === 'embedded-worker') { verifyDiagnosticTokens(left.value, right.value, acorn); changes.embeddedWorkers++; }
      else if (kind === 'module-label') changes.moduleLabels++;
      else if (kind === 'fork-version') { assert.equal(right.value,'4.148.0-page-ribbon.undici.1'); changes.forkVersions++; }
      else changes.functionLabels++;
    }
    if (left.type.label === 'eof') break;
  }
  return { tokensPreserved: true, ...changes };
}
