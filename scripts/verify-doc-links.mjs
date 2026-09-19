#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const excludedDirectories = new Set([
  '.git', '.github', '.micro-ecf', '.ecf-core', 'node_modules', 'coverage', 'dist', 'build', 'vendor', 'out',
]);

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(absolute);
  }
  return files;
}

function withoutFencedCode(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const character = marker[1][0];
      const length = marker[1].length;
      if (!fence) fence = { character, length };
      else if (character === fence.character && length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

function inlineDestinationClose(text, start) {
  let cursor = start;
  while (/\s/.test(text[cursor] || '')) cursor += 1;
  if (text[cursor] === ')') return cursor;

  const opening = text[cursor];
  if (!['"', "'", '('].includes(opening)) return -1;
  const closing = opening === '(' ? ')' : opening;
  cursor += 1;
  let escaped = false;
  for (; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== closing) continue;
    cursor += 1;
    while (/\s/.test(text[cursor] || '')) cursor += 1;
    return text[cursor] === ')' ? cursor : -1;
  }
  return -1;
}

function inlineDestinations(text) {
  const found = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== ']' || text[index + 1] !== '(') continue;

    let cursor = index + 2;
    while (/\s/.test(text[cursor] || '')) cursor += 1;

    if (text[cursor] === '<') {
      let target = '';
      let escaped = false;
      cursor += 1;
      for (; cursor < text.length; cursor += 1) {
        const character = text[cursor];
        if (escaped) {
          target += character;
          escaped = false;
          continue;
        }
        if (character === '\\') {
          escaped = true;
          continue;
        }
        if (character !== '>') {
          target += character;
          continue;
        }
        const close = inlineDestinationClose(text, cursor + 1);
        if (close !== -1) {
          found.push(`<${target}>`);
          index = close;
        }
        break;
      }
      continue;
    }

    let target = '';
    let depth = 0;
    let escaped = false;
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (escaped) {
        target += character;
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '(') {
        depth += 1;
        target += character;
        continue;
      }
      if (character === ')') {
        if (depth > 0) {
          depth -= 1;
          target += character;
          continue;
        }
        if (target) found.push(target);
        index = cursor;
        break;
      }
      if (/\s/.test(character) && depth === 0) {
        const close = inlineDestinationClose(text, cursor);
        if (target && close !== -1) {
          found.push(target);
          index = close;
        }
        break;
      }
      target += character;
    }
  }
  return found;
}

function slugBase(heading) {
  return heading
    .replace(/<[^>]*>/g, '')
    // A malformed nested tag can leave a new angle-bracket pair after removal.
    .replace(/[<>]/g, '')
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function anchorsFor(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of withoutFencedCode(markdown).split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const base = slugBase(heading[1]);
      const count = counts.get(base) || 0;
      anchors.add(count === 0 ? base : `${base}-${count}`);
      counts.set(base, count + 1);
    }
    for (const match of line.matchAll(/<(?:a\s+[^>]*(?:id|name)|[^>]+\sid)=["']([^"']+)["'][^>]*>/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function destinations(markdown) {
  const text = withoutFencedCode(markdown);
  const found = inlineDestinations(text);
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)) found.push(match[1]);
  for (const match of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) found.push(match[1]);
  return found;
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function anchorDocument(targetFile) {
  let anchorFile = path.extname(targetFile).toLowerCase() === '.md'
    ? targetFile
    : path.join(targetFile, 'README.md');
  try {
    return { file: anchorFile, contents: fs.readFileSync(anchorFile, 'utf8') };
  } catch (error) {
    if (error.code === 'EISDIR' && anchorFile === targetFile) {
      anchorFile = path.join(targetFile, 'README.md');
      try {
        return { file: anchorFile, contents: fs.readFileSync(anchorFile, 'utf8') };
      } catch (readmeError) {
        if (readmeError.code !== 'ENOENT' && readmeError.code !== 'ENOTDIR') throw readmeError;
      }
    } else if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw error;
    }
    // This check follows a failed read only; no later read depends on it.
    try {
      fs.statSync(targetFile);
      return null;
    } catch (targetError) {
      if (targetError.code !== 'ENOENT' && targetError.code !== 'ENOTDIR') throw targetError;
      return { missing: true };
    }
  }
}

const markdownFiles = walk(root).sort();
const contents = new Map(markdownFiles.map((file) => [file, fs.readFileSync(file, 'utf8')]));
const anchorCache = new Map();
const failures = [];

for (const sourceFile of markdownFiles) {
  for (let rawTarget of destinations(contents.get(sourceFile))) {
    rawTarget = rawTarget.replace(/^<|>$/g, '').trim();
    if (!rawTarget || rawTarget.startsWith('/') || rawTarget.startsWith('//')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    if (/[{}*]/.test(rawTarget)) continue;

    const hashIndex = rawTarget.indexOf('#');
    const rawPath = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : decode(rawTarget.slice(hashIndex + 1));
    const cleanPath = decode(rawPath.split('?')[0]);
    const targetFile = cleanPath ? path.resolve(path.dirname(sourceFile), cleanPath) : sourceFile;
    const relativeToRoot = path.relative(root, targetFile);

    if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      failures.push(`${path.relative(root, sourceFile)} -> escapes repository ${rawTarget}`);
      continue;
    }

    if (!fragment) {
      try {
        fs.statSync(targetFile);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        failures.push(`${path.relative(root, sourceFile)} -> missing ${rawTarget}`);
      }
      continue;
    }

    if (!anchorCache.has(targetFile)) {
      const document = anchorDocument(targetFile);
      anchorCache.set(targetFile, document?.contents == null
        ? document
        : { anchors: anchorsFor(document.contents) });
    }
    const target = anchorCache.get(targetFile);
    if (target?.missing) {
      failures.push(`${path.relative(root, sourceFile)} -> missing ${rawTarget}`);
      continue;
    }
    if (!target) continue;
    if (!target.anchors.has(fragment)) {
      failures.push(`${path.relative(root, sourceFile)} -> missing anchor ${rawTarget}`);
    }
  }
}

if (failures.length) {
  console.error(`Documentation link contract failed with ${failures.length} error(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation link contract passed for ${markdownFiles.length} Markdown files.`);
