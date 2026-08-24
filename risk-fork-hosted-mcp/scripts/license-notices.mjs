import { createHash } from 'node:crypto';

const COMPLETE_README_LICENSE_FALLBACKS = new Map([
  ['pg-types@2.2.0', Object.freeze({
    file: 'README.md',
    license: 'MIT',
    sourceBytes: 3831,
    sourceSha256: 'sha256:ecda9bca71d3f0cee4e600d1dd2bef336213f39ef2e8fca6a1a1c1c8723f643a',
    noticeBytes: 1082,
    noticeSha256: 'sha256:a3a081597284cb155888f951f1b74579d7ed3ceccc69ff5da66db24feb3d0597',
  })],
  ['pgpass@1.0.5', Object.freeze({
    file: 'README.md',
    license: 'MIT',
    sourceBytes: 3294,
    sourceSha256: 'sha256:62549909404b5a0dcb2b4b74c9a930baf8095dbcfa1543c4ffc79378acd22b57',
    noticeBytes: 1060,
    noticeSha256: 'sha256:7a69666f39f8ad8b5574b60fb0443407abd3e2651b5cae8b559d640d5ff14e84',
  })],
]);

const REQUIRED_MIT_NOTICE_FRAGMENTS = Object.freeze([
  'permission is hereby granted, free of charge, to any person obtaining a copy',
  'the above copyright notice and this permission notice shall be included in',
  'the software is provided "as is", without warranty of any kind',
  'in no event shall the authors or copyright holders be liable for any claim',
]);

function packageKey(packageName, version) {
  return `${packageName}@${version}`;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizedUtf8(bytes, label) {
  const text = Buffer.from(bytes).toString('utf8');
  if (text.includes('\u0000') || text.includes('\uFFFD')) {
    throw new Error(`${label} is not valid bounded UTF-8 text`);
  }
  return text.replace(/\r\n?/g, '\n');
}

function markdownHeading(line) {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function assertCompleteMitNotice(notice, key) {
  if (!/^copyright \(c\) .+/im.test(notice)) {
    throw new Error(`${key} README license section omits the copyright notice`);
  }
  const collapsed = notice.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const fragment of REQUIRED_MIT_NOTICE_FRAGMENTS) {
    if (!collapsed.includes(fragment)) {
      throw new Error(`${key} README license section is incomplete`);
    }
  }
}

export function getCompleteReadmeLicenseFallback(packageName, version) {
  return COMPLETE_README_LICENSE_FALLBACKS.get(packageKey(packageName, version)) ?? null;
}

export function extractCompleteReadmeLicense({
  bytes,
  packageName,
  version,
  declaredLicense,
}) {
  const key = packageKey(packageName, version);
  const fallback = getCompleteReadmeLicenseFallback(packageName, version);
  if (!fallback) {
    throw new Error(`${key} has no reviewed README license fallback`);
  }
  if (declaredLicense !== fallback.license || fallback.license !== 'MIT') {
    throw new Error(`${key} README license fallback does not match the declared license`);
  }

  const sourceBytes = Buffer.from(bytes);
  const lines = normalizedUtf8(sourceBytes, `${key} ${fallback.file}`).split('\n');
  const licenseHeadings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = markdownHeading(lines[index]);
    if (heading && /^licen[cs]e$/i.test(heading.title)) {
      licenseHeadings.push({ ...heading, index });
    }
  }
  if (licenseHeadings.length !== 1) {
    throw new Error(`${key} ${fallback.file} must contain exactly one license heading`);
  }

  const heading = licenseHeadings[0];
  let end = lines.length;
  for (let index = heading.index + 1; index < lines.length; index += 1) {
    const nextHeading = markdownHeading(lines[index]);
    if (nextHeading && nextHeading.level <= heading.level) {
      end = index;
      break;
    }
  }
  const notice = lines.slice(heading.index + 1, end).join('\n').trim();
  if (notice.length === 0) {
    throw new Error(`${key} ${fallback.file} license section is empty`);
  }
  assertCompleteMitNotice(notice, key);
  const noticeBytes = Buffer.from(notice, 'utf8');
  if (sourceBytes.byteLength !== fallback.sourceBytes
    || sha256(sourceBytes) !== fallback.sourceSha256) {
    throw new Error(`${key} ${fallback.file} source bytes or SHA-256 do not match the reviewed fallback`);
  }
  if (noticeBytes.byteLength !== fallback.noticeBytes
    || sha256(noticeBytes) !== fallback.noticeSha256) {
    throw new Error(`${key} ${fallback.file} extracted notice bytes or SHA-256 do not match the reviewed fallback`);
  }
  return {
    file: fallback.file,
    method: 'markdown_license_section',
    text: notice,
  };
}
