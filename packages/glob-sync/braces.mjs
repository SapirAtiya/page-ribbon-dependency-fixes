// Bounded glob brace grammar. Literal wrappers stay literal while nested groups expand.
// This tree has no parent references; every concatenation is checked before allocation.
import fillRange from 'fill-range';

const limit = () => new RangeError('Glob expansion exceeds the supported build-pattern budget');
function checked(values) {
  if (values.length > 10000 || values.reduce((n, value) => n + value.length, 0) > 4000000) throw limit();
  return values;
}
function product(left, right) {
  const size = left.length * right.length;
  const bytes = right.length * left.reduce((n, value) => n + value.length, 0) +
    left.length * right.reduce((n, value) => n + value.length, 0);
  if (size > 10000 || bytes > 4000000) throw limit();
  return left.flatMap(prefix => right.map(value => prefix + value));
}
function range(raw) {
  const match = /^([^.{}(),]+)\.\.([^.{}(),]+)(?:\.\.([^.{}(),]+))?$/.exec(raw);
  if (!match) return;
  const [, start, end, step = '1'] = match;
  const numeric = value => Number.isInteger(Number(value));
  if (!numeric(step)) return;
  for (const value of [start, end, step]) if (numeric(value) && !Number.isSafeInteger(Number(value))) throw limit();
  if ((!numeric(start) && start.length !== 1) || (!numeric(end) && end.length !== 1)) return;
  const increment = Math.max(Math.abs(Number(step)), 1);
  const numbers = numeric(start) && numeric(end);
  const first = numbers ? BigInt(Number(start)) : BigInt(start.charCodeAt(0));
  const last = numbers ? BigInt(Number(end)) : BigInt(end.charCodeAt(0));
  const count = ((first > last ? first - last : last - first) / BigInt(increment)) + 1n;
  if (count > 10000n || Number(count) * Math.max(start.length, end.length, step.length) > 4000000) throw limit();
  return checked(fillRange(start, end, step));
}
export function expandPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new TypeError('Expected non-empty glob strings');
  if (pattern.length > 16384 || (pattern.match(/[{}]/g) || []).length > 256) throw limit();
  const finish = values => [...new Set(values)].sort((a, b) => a.length - b.length)
    .filter(Boolean).map(value => value.replace(/(?!^)\/{2,}/g, '/'));
  if (pattern.indexOf('{') < 0 || pattern.indexOf('}', pattern.indexOf('{')) < 0) return finish([pattern]);

  let position = 0;
  function parse(open = '', depth = 0, dollar = false) {
    if (depth > 128) throw limit();
    const node = { open, close: '', nodes: [], raw: '', dollar };
    const start = position;
    const text = value => {
      const previous = node.nodes.at(-1);
      if (typeof previous === 'string') node.nodes[node.nodes.length - 1] += value;
      else node.nodes.push(value);
    };
    while (position < pattern.length) {
      const char = pattern[position++];
      if ((open === '{' && char === '}') || (open === '(' && char === ')')) {
        node.close = char;
        node.raw = pattern.slice(start, position - 1);
        return node;
      }
      if (char === '\\') { text(pattern[position++] || ''); continue; }
      if (char === '\uFEFF' || char === '\u00A0') continue;
      if ('"\x27\x60'.includes(char)) {
        let value = '';
        while (position < pattern.length) {
          const next = pattern[position++];
          if (next === char) break;
          value += next;
          if (next === '\\') value += pattern[position++] || '';
        }
        text(value);
        continue;
      }
      if (char === '[') {
        let value = char, brackets = 1;
        while (position < pattern.length && brackets) {
          const next = pattern[position++];
          value += next;
          if (next === '\\') value += pattern[position++] || '';
          else if (next === '[') brackets++;
          else if (next === ']') brackets--;
        }
        text(value);
        continue;
      }
      if (char === '{' || char === '(') {
        const inherited = dollar || (typeof node.nodes.at(-1) === 'string' && node.nodes.at(-1).endsWith('$'));
        node.nodes.push(parse(char, depth + 1, inherited));
      } else if (char === ',' && open === '{') node.nodes.push({ comma: true });
      else text(char === ']' ? '\\]' : char);
    }
    node.raw = pattern.slice(start);
    return node;
  }
  const render = node => typeof node === 'string' ? node : node.comma ? ',' :
    node.open + node.nodes.map(render).join('') + node.close;
  function expand(node) {
    if (typeof node === 'string') return [node];
    if (node.comma) return [','];
    if (node.dollar) return [render(node)];
    if (node.open === '{' && node.close && !/[\\'"\x60[\](){}]/.test(node.raw)) {
      const values = range(node.raw);
      if (values?.length) return values;
    }
    const alternatives = node.open === '{' && node.close && node.nodes.some(child => child.comma);
    let values = [], current = [''];
    for (const child of node.nodes) {
      if (alternatives && child.comma) {
        values = checked(values.concat(current));
        current = [''];
      } else current = product(current, expand(child));
    }
    values = checked(values.concat(current));
    return alternatives ? values : product([node.open], product(values, [node.close]));
  }
  return finish(expand(parse()));
}
