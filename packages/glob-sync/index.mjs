'use strict';
// Only the two repository-owned consumers use this boundary; this is not fast-glob's API.
// Scheduling and pruning follow fast-glob 3.x (MIT; see FAST_GLOB_LICENSE).
import fs from 'node:fs';
import path from 'node:path';
import walk from '@nodelib/fs.walk';
import globParent from 'glob-parent';
import picomatch from 'picomatch';
import { expandPattern } from './braces.mjs';

const negative = pattern => pattern.startsWith('!') && pattern[1] !== '(';
const braceDynamic = pattern => {
  const start = pattern.indexOf('{'), end = pattern.indexOf('}', start + 1);
  return start >= 0 && end >= 0 && /,|\.\./.test(pattern.slice(start, end));
};
const dynamic = pattern => pattern.includes('\\') ||
  /[*?]|^!|\[[^[]*\]|(?:^|[^!*+?@])\([^(]*\|[^|]*\)|[!*+?@]\([^(]*\)/.test(pattern) ||
  braceDynamic(pattern);
const outside = pattern => pattern.startsWith('..') || pattern.startsWith('./..');
const matchOptions = { dot: false, posix: true, strictSlashes: false };
const compile = (patterns, options = matchOptions) => patterns.map(pattern => picomatch.makeRe(pattern, options));
const matches = (value, patterns) => patterns.some(pattern => pattern.test(value));

function tasks(patterns) {
  const result = [];
  for (const isDynamic of [false, true]) {
    const selected = patterns.filter(pattern => dynamic(pattern) === isDynamic);
    for (const isOutside of [true, false]) {
      const members = selected.filter(pattern => outside(pattern) === isOutside);
      const groups = new Map();
      for (const pattern of members) {
        const base = globParent(pattern, { flipBackslashes: false });
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base).push(pattern);
      }
      if (!isOutside && groups.has('.')) result.push({ base: '.', patterns: members, isDynamic });
      else for (const [base, grouped] of groups) result.push({ base, patterns: grouped, isDynamic });
    }
  }
  return result;
}
function partial(patterns) {
  const storage = patterns.map(pattern => {
    let parts = picomatch.scan(pattern, { ...matchOptions, parts: true }).parts;
    if (!parts.length) parts = [pattern];
    if (parts[0].startsWith('/')) parts = ['', parts[0].slice(1), ...parts.slice(1)];
    const segments = parts.map(part => dynamic(part) ? picomatch.makeRe(part, matchOptions) : part);
    const firstStar = parts.findIndex(part => dynamic(part) && part.includes('**'));
    return { segments, firstStar };
  });
  return (value, recursiveOnly = false) => {
    const parts = value.split('/');
    return storage.some(({ segments, firstStar }) => {
      if (recursiveOnly && firstStar < 0) return false;
      if (firstStar < 0 && segments.length <= parts.length) return false;
      if (firstStar >= 0 && parts.length > firstStar) return true;
      return parts.every((part, index) => typeof segments[index] === 'string'
        ? segments[index] === part : segments[index]?.test(part));
    });
  };
}
function globSync(input, options = {}) {
  for (const key of Object.keys(options)) {
    if (!['cwd', 'onlyDirectories', 'fs'].includes(key)) throw new TypeError('Unsupported consumer glob option: ' + key);
  }
  const patterns = (Array.isArray(input) ? input : [input]).flatMap(expandPattern);
  const excludes = patterns.filter(negative).map(pattern => pattern.slice(1));
  const excluded = compile(excludes, { ...matchOptions, dot: true });
  const pruned = compile(excludes.filter(pattern => pattern.endsWith('/**') || !dynamic(path.posix.basename(pattern))));
  const cwd = path.resolve(options.cwd || process.cwd());
  const filesystem = { ...fs, ...options.fs };
  // Scandir tolerates dangling links. Keep that behavior but never hide permission or I/O errors.
  let fatal;
  const checkedFs = {
    ...filesystem,
    statSync(...args) {
      try { return filesystem.statSync(...args); }
      catch (error) { if (error.code !== 'ENOENT') fatal ||= error; throw error; }
    },
  };
  const identity = directory => {
    const stat = filesystem.statSync(directory, { bigint: true });
    if (stat.ino) return String(stat.dev) + ':' + String(stat.ino);
    return filesystem.realpathSync(directory).replace(/^[A-Z]:/, drive => drive.toLowerCase());
  };
  const found = [], seen = new Set();
  const add = value => {
    const key = value.replace(/^\.\//, '');
    if (!seen.has(key)) { seen.add(key); found.push(value); }
  };
  for (const task of tasks(patterns.filter(pattern => !negative(pattern)))) {
    if (!task.isDynamic) {
      for (const pattern of task.patterns) {
        let stat;
        try { stat = filesystem.statSync(path.resolve(cwd, pattern)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const value = pattern.replace(/^\.\//, '');
        if ((options.onlyDirectories ? stat.isDirectory() : stat.isFile()) &&
            !matches(value, excluded) && !(stat.isDirectory() && matches(value + '/', excluded))) add(pattern);
      }
      continue;
    }
    const base = path.resolve(cwd, task.base);
    let rootIdentity;
    try { rootIdentity = identity(base); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const included = compile(task.patterns);
    const descend = partial(task.patterns);
    // Branch-local identities bound globstar cycles; fixed-depth links terminate naturally.
    // Independent aliases retain their own inventories.
    const ancestors = new Map([[task.base, { identity: rootIdentity, parent: null }]]);
    const entries = walk.walkSync(base, {
      basePath: task.base === '.' ? '' : task.base, pathSegmentSeparator: '/',
      followSymbolicLinks: true, throwErrorOnBrokenSymbolicLink: false, fs: checkedFs,
      errorFilter: error => error.code === 'ENOENT',
      entryFilter(entry) {
        const value = entry.path.replace(/^\.\//, '');
        const directory = entry.dirent.isDirectory();
        return (options.onlyDirectories ? directory : entry.dirent.isFile()) &&
          (matches(value, included) || (directory && matches(value + '/', included))) &&
          !matches(value, excluded) && !(directory && matches(value + '/', excluded));
      },
      deepFilter(entry) {
        const value = entry.path.replace(/^\.\//, '');
        if (!descend(value) || matches(value, pruned)) return false;
        const parent = ancestors.get(path.posix.dirname(entry.path));
        const current = identity(path.resolve(cwd, entry.path));
        for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor.identity === current && descend(value, true)) throw Object.assign(new Error('Glob discovery encountered a directory link cycle: ' + entry.path), { code: 'ELOOP' });
        }
        ancestors.set(entry.path, { identity: current, parent });
        return true;
      },
    });
    if (fatal) throw fatal;
    for (const entry of entries) add(entry.path);
  }
  return found;
}
export { globSync, globSync as sync };
const consumerGlob = { globSync, sync: globSync };
export default consumerGlob;
