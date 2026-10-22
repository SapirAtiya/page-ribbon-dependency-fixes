import assert from 'node:assert/strict';

// Equal-width replacements preserve generated/source columns. The caller supplies
// private prefixes; this distribution-source repository never stores those inputs.
export function cleanPaths(text, rules) {
  const changes = [];
  const code = text.replace(rules.pattern, (before, offset) => {
    const prefix = before.includes('Users') ? 'upstream-workers-sdk-root-' : 'upstream-dependency-cache-';
    assert.ok(before.length >= prefix.length);
    const after = prefix.padEnd(before.length, '_');
    changes.push({ start: offset, end: offset + before.length, before, after });
    return after;
  });
  assert.equal(code.length, text.length);
  assert.equal(code.split('\n').length, text.split('\n').length);
  return { code, changes };
}
