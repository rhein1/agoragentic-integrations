import {
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalize, sha256Ref } from '../canonical.mjs';
import { sha256BytesRef, sha256FileRef } from '../e2b-qualification.mjs';
import {
  AGORAGENTIC_API_KEY_PATTERN,
  BEARER_CREDENTIAL_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  cloneJson,
  deepFreeze,
  normalizeRelativePath,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
  securityPatternMatches,
  securityPatternsMatch,
  securityTextVariants,
} from '../util.mjs';
import { readImmutableWorkspaceExport } from './e2b-workspace-export.mjs';

const REQUEST_SCHEMA = 'agoragentic.risk-fork.authority-free-source-request.v1';
const ATTESTATION_SCHEMA = 'agoragentic.risk-fork.authority-free-source-attestation.v1';
const EVIDENCE_SCHEMA = 'agoragentic.risk-fork.e2b-source-verification-evidence.v1';
export const E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA =
  'agoragentic.risk-fork.e2b-independent-source-attestation.v1';
const REQUEST_KEYS = Object.freeze([
  'schema',
  'provider',
  'cleanup_ref',
  'capsule_hash',
  'workspace_digest',
  'workspace_manifest_hash',
  'file_count',
  'total_bytes',
  'files',
  'clean_template_id_hash',
  'clean_template_evidence_hash',
  'trusted_bootstrap_command_hash',
  'trusted_runner_command_hash',
  'trusted_bootstrap_artifact_hash',
  'trusted_runner_artifact_hash',
  'request_hash',
]);
const SECRET_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|\.aws|\.azure|\.config\/gcloud|\.docker\/config\.json|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.ssh|credentials?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|private[_-]?key(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|wallet(?:\.[^/]*)?)(?:$|\/)/i;
const SECRET_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  BEARER_CREDENTIAL_PATTERN,
  AGORAGENTIC_API_KEY_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  /\be2b_[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^/\s:@]+:[^@\s/]{3,}@/i,
]);
const SECRET_ASSIGNMENT_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|npm[_-]?token|slack[_-]?token|database[_-]?url|authorization|credential|password|passphrase|private[_-]?key|client[_-]?secret|seed[_-]?phrase|mnemonic|wallet[_-]?(?:key|secret))`;
const SECRET_ASSIGNMENT_KEY_PATTERN = new RegExp(`^(?:${SECRET_ASSIGNMENT_KEY})$`, 'i');
const SECRET_ASSIGNMENT_EXACT_SYNTAX_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?:"(${SECRET_ASSIGNMENT_KEY})"|'(${SECRET_ASSIGNMENT_KEY})'|(${SECRET_ASSIGNMENT_KEY}))\s*[=:]`,
  'giu',
);
const NON_ASCII_PATTERN = /[^\x00-\x7f]/u;
const MAX_SECRET_ASSIGNMENT_KEY_UTF16 = 120;
const MAX_SECURITY_SYNTAX_PROFILE_CACHE_ENTRIES = 4096;
const SECURITY_SYNTAX_PROFILE_CACHE = new Map();
const MIN_SECRET_ASSIGNMENT_BYTES = 8;
const BASE64_CANDIDATE_PATTERN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const MIME_BASE64_BLOCK_PATTERN = /(?:[A-Za-z0-9+/_-]{4,76}[ \t]*\r?\n){1,}[A-Za-z0-9+/_-]{2,76}={0,2}/g;

function exactPatternMatches(pattern, value) {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function sourceCharacterAt(text, index) {
  if (index >= text.length) return null;
  const character = String.fromCodePoint(text.codePointAt(index));
  return { character, nextIndex: index + character.length };
}

function isSecretAssignmentWhitespace(character) {
  const codePoint = character.charCodeAt(0);
  return (codePoint >= 0x0009 && codePoint <= 0x000d)
    || codePoint === 0x0020
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000
    || codePoint === 0xfeff;
}

function isSecretAssignmentKeyFragment(value) {
  if (value.length === 0) return false;
  for (const character of value) {
    if (!((character >= 'A' && character <= 'Z')
      || (character >= 'a' && character <= 'z')
      || (character >= '0' && character <= '9')
      || character === '_'
      || character === '-')) {
      return false;
    }
  }
  return true;
}

function inspectSecretAssignmentSyntaxVariants(variants) {
  const structuralForms = [];
  const quoteForms = [];
  const mixedQuoteOpeners = [];
  const mixedQuoteClosers = [];
  let normalizedWhitespace = false;
  let foldedAway = false;
  let hasSingleDelimiter = false;
  let hasMultiDelimiterFold = false;
  let hasOddEscapeFold = false;
  let hasEvenEscapeFold = false;
  let hasMixedStructuralVariant = false;
  let hasNonQuoteVariant = false;
  let identifierTail = false;
  let potentialKeyStart = false;

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    if (variant.length === 0) {
      foldedAway = true;
      continue;
    }
    let onlyWhitespace = true;
    let onlyQuotes = true;
    let onlyDelimiters = true;
    let onlyEscapes = true;
    let onlyStructural = true;
    let hasStructuralToken = false;
    for (const character of variant) {
      if (!isSecretAssignmentWhitespace(character)) onlyWhitespace = false;
      if (character !== "'" && character !== '"') onlyQuotes = false;
      if (character !== '=' && character !== ':') onlyDelimiters = false;
      if (character !== '\\') onlyEscapes = false;
      if (character === "'"
        || character === '"'
        || character === '\\'
        || character === '='
        || character === ':') {
        hasStructuralToken = true;
      } else {
        onlyStructural = false;
      }
    }
    if (!onlyQuotes) hasNonQuoteVariant = true;
    if (hasStructuralToken && !onlyStructural) {
      hasMixedStructuralVariant = true;
      const openingQuoteForm = variant[0];
      const openingKeyFragment = variant.slice(1);
      if ((openingQuoteForm === "'" || openingQuoteForm === '"')
        && isSecretAssignmentKeyFragment(openingKeyFragment)) {
        mixedQuoteOpeners.push(Object.freeze({
          keyFragment: openingKeyFragment,
          quoteForm: openingQuoteForm,
        }));
      }
      const closingQuoteForm = variant[variant.length - 1];
      const closingKeyFragment = variant.slice(0, -1);
      if ((closingQuoteForm === "'" || closingQuoteForm === '"')
        && isSecretAssignmentKeyFragment(closingKeyFragment)) {
        mixedQuoteClosers.push(Object.freeze({
          keyFragment: closingKeyFragment,
          quoteForm: closingQuoteForm,
        }));
      }
    }
    if (onlyWhitespace) normalizedWhitespace = true;
    if (onlyStructural && !structuralForms.includes(variant)) structuralForms.push(variant);
    if (onlyQuotes && !quoteForms.includes(variant)) quoteForms.push(variant);
    if (onlyDelimiters) {
      if (variant.length === 1) hasSingleDelimiter = true;
      else hasMultiDelimiterFold = true;
    }
    if (onlyEscapes) {
      if (variant.length % 2 === 0) hasEvenEscapeFold = true;
      else hasOddEscapeFold = true;
    }
    const first = variant[0].toLowerCase();
    if ('acdmnprsw'.includes(first)) potentialKeyStart = true;
    const tail = variant[variant.length - 1];
    if ((tail >= 'A' && tail <= 'Z')
      || (tail >= 'a' && tail <= 'z')
      || (tail >= '0' && tail <= '9')
      || tail === '_') {
      identifierTail = true;
    }
  }

  return Object.freeze({
    ambiguousStructuralForms: structuralForms.length > 1,
    delimiterKind: hasMultiDelimiterFold
      ? 'fail_closed_multi'
      : (hasSingleDelimiter ? 'single' : null),
    escapeParity: hasOddEscapeFold && hasEvenEscapeFold
      ? 'ambiguous'
      : (hasOddEscapeFold ? 'odd' : (hasEvenEscapeFold ? 'even' : null)),
    foldedAway,
    hasMixedStructuralVariant,
    hasQuoteLiteralAmbiguity: quoteForms.length > 0 && hasNonQuoteVariant,
    identifierTail,
    mixedQuoteClosers: Object.freeze(mixedQuoteClosers),
    mixedQuoteOpeners: Object.freeze(mixedQuoteOpeners),
    normalizedWhitespace,
    potentialKeyStart,
    quoteForms: Object.freeze(quoteForms),
  });
}

function secretAssignmentSyntaxProfile(character, normalizeUnicode) {
  if (!normalizeUnicode) return inspectSecretAssignmentSyntaxVariants([character]);
  let profile = SECURITY_SYNTAX_PROFILE_CACHE.get(character);
  if (profile) return profile;
  profile = inspectSecretAssignmentSyntaxVariants(securityTextVariants(character));
  if (SECURITY_SYNTAX_PROFILE_CACHE.size < MAX_SECURITY_SYNTAX_PROFILE_CACHE_ENTRIES) {
    SECURITY_SYNTAX_PROFILE_CACHE.set(character, profile);
  }
  return profile;
}

function isNormalizedSecretAssignmentWhitespace(character, normalizeUnicode) {
  return secretAssignmentSyntaxProfile(character, normalizeUnicode).normalizedWhitespace;
}

function isFoldedAway(character, normalizeUnicode) {
  return normalizeUnicode
    && secretAssignmentSyntaxProfile(character, true).foldedAway;
}

function secretAssignmentQuoteForms(character, normalizeUnicode) {
  return secretAssignmentSyntaxProfile(character, normalizeUnicode).quoteForms;
}

function classifySecretAssignmentDelimiter(character, normalizeUnicode) {
  return secretAssignmentSyntaxProfile(character, normalizeUnicode).delimiterKind;
}

function isInterTokenWhitespace(character, normalizeUnicode, allowQuoteRole = false) {
  const profile = secretAssignmentSyntaxProfile(character, normalizeUnicode);
  if ((!allowQuoteRole && profile.quoteForms.length > 0)
    || profile.delimiterKind) {
    return false;
  }
  return profile.normalizedWhitespace || profile.foldedAway;
}

function isUnquotedSecretAssignmentTerminator(character, normalizeUnicode) {
  return isNormalizedSecretAssignmentWhitespace(character, normalizeUnicode)
    || secretAssignmentQuoteForms(character, normalizeUnicode).length > 0
    || character === '&'
    || character === ','
    || character === ';'
    || character === '{'
    || character === '}'
    || character === ']';
}

function readQuotedSecretAssignmentValue(
  text,
  valueStart,
  valueEncoding,
  normalizeUnicode,
  quoteForm,
) {
  let index = valueStart;
  let escapePending = false;
  let matchedShortClose = null;
  while (index < text.length) {
    const token = sourceCharacterAt(text, index);
    const profile = secretAssignmentSyntaxProfile(token.character, normalizeUnicode);
    if (profile.ambiguousStructuralForms || profile.hasMixedStructuralVariant) {
      return { matched: true, hasMinimumBytes: true, nextIndex: token.nextIndex };
    }
    if (!escapePending && profile.quoteForms.includes(quoteForm)) {
      const close = { matched: true, hasMinimumBytes: false, nextIndex: token.nextIndex };
      if (!profile.hasQuoteLiteralAmbiguity) return close;
      matchedShortClose ??= close;
    }
    index = token.nextIndex;
    if (Buffer.byteLength(text.slice(valueStart, index), valueEncoding)
      >= MIN_SECRET_ASSIGNMENT_BYTES) {
      return { matched: true, hasMinimumBytes: true, nextIndex: index };
    }
    if (profile.escapeParity === 'ambiguous') {
      return { matched: true, hasMinimumBytes: true, nextIndex: index };
    }
    if (profile.escapeParity) {
      escapePending = profile.escapeParity === 'odd' ? !escapePending : escapePending;
    } else if (!profile.foldedAway) {
      escapePending = false;
    }
  }
  return matchedShortClose
    ?? { matched: false, hasMinimumBytes: false, nextIndex: index };
}

function readUnquotedSecretAssignmentValue(text, valueStart, valueEncoding, normalizeUnicode) {
  let index = valueStart;
  for (let token = sourceCharacterAt(text, index); token;
    token = sourceCharacterAt(text, index)) {
    const profile = secretAssignmentSyntaxProfile(token.character, normalizeUnicode);
    if (profile.ambiguousStructuralForms || profile.hasMixedStructuralVariant) {
      return { matched: true, hasMinimumBytes: true, nextIndex: token.nextIndex };
    }
    const quoteLiteralAmbiguity = profile.hasQuoteLiteralAmbiguity
      && profile.quoteForms.length > 0;
    if (!quoteLiteralAmbiguity
      && isUnquotedSecretAssignmentTerminator(token.character, normalizeUnicode)) {
      break;
    }
    index = token.nextIndex;
    if (Buffer.byteLength(text.slice(valueStart, index), valueEncoding)
      >= MIN_SECRET_ASSIGNMENT_BYTES) {
      return { matched: true, hasMinimumBytes: true, nextIndex: index };
    }
  }
  return {
    matched: index > valueStart,
    hasMinimumBytes: false,
    nextIndex: index,
  };
}

function readSecretAssignmentValue(text, startIndex, valueEncoding, normalizeUnicode) {
  let index = startIndex;
  for (let token = sourceCharacterAt(text, index);
    token && isInterTokenWhitespace(token.character, normalizeUnicode);
    token = sourceCharacterAt(text, index)) {
    index = token.nextIndex;
  }
  if (index >= text.length) {
    return { matched: false, hasMinimumBytes: false, nextIndex: index };
  }

  const openingToken = sourceCharacterAt(text, index);
  const openingProfile = secretAssignmentSyntaxProfile(
    openingToken.character,
    normalizeUnicode,
  );
  const openingQuoteForms = openingProfile.quoteForms;
  if (openingProfile.hasMixedStructuralVariant) {
    return { matched: true, hasMinimumBytes: true, nextIndex: openingToken.nextIndex };
  }
  if (openingQuoteForms.length > 0) {
    if (openingProfile.ambiguousStructuralForms) {
      return { matched: true, hasMinimumBytes: true, nextIndex: openingToken.nextIndex };
    }
    const valueStart = openingToken.nextIndex;
    let matchedShortValue = null;
    for (const quoteForm of openingQuoteForms) {
      const result = readQuotedSecretAssignmentValue(
        text,
        valueStart,
        valueEncoding,
        normalizeUnicode,
        quoteForm,
      );
      if (result.hasMinimumBytes) return result;
      if (result.matched) matchedShortValue = result;
    }
    if (openingProfile.hasQuoteLiteralAmbiguity) {
      const literalResult = readUnquotedSecretAssignmentValue(
        text,
        index,
        valueEncoding,
        normalizeUnicode,
      );
      if (literalResult.hasMinimumBytes) return literalResult;
      matchedShortValue ??= literalResult;
    }
    return matchedShortValue
      ?? { matched: false, hasMinimumBytes: false, nextIndex: text.length };
  }

  return readUnquotedSecretAssignmentValue(text, index, valueEncoding, normalizeUnicode);
}

function secretAssignmentKeyMatches(key, normalizeUnicode) {
  return normalizeUnicode
    ? securityPatternMatches(SECRET_ASSIGNMENT_KEY_PATTERN, key)
    : exactPatternMatches(SECRET_ASSIGNMENT_KEY_PATTERN, key);
}

function finishSecretAssignmentSyntax(text, key, index, normalizeUnicode) {
  if (!secretAssignmentKeyMatches(key, normalizeUnicode)) return null;
  let token = sourceCharacterAt(text, index);
  while (token && isInterTokenWhitespace(token.character, normalizeUnicode, true)) {
    index = token.nextIndex;
    token = sourceCharacterAt(text, index);
  }
  if (!token) return null;
  const delimiterProfile = secretAssignmentSyntaxProfile(token.character, normalizeUnicode);
  const delimiterKind = delimiterProfile.delimiterKind;
  if (!delimiterKind) return null;
  return {
    failClosed: delimiterProfile.ambiguousStructuralForms,
    delimiterKind,
    valueStart: token.nextIndex,
  };
}

function readQuotedSecretAssignmentSyntax(
  text,
  keyStart,
  openingQuoteForm,
  normalizeUnicode,
  keyPrefix = '',
) {
  let index = keyStart;
  while (index < text.length) {
    const token = sourceCharacterAt(text, index);
    const closingProfile = secretAssignmentSyntaxProfile(token.character, normalizeUnicode);
    const closingQuoteForms = closingProfile.quoteForms;
    if (closingQuoteForms.includes(openingQuoteForm)) {
      if (index === keyStart && keyPrefix.length === 0) return null;
      if (keyPrefix.length + index - keyStart > MAX_SECRET_ASSIGNMENT_KEY_UTF16) return null;
      const syntax = finishSecretAssignmentSyntax(
        text,
        `${keyPrefix}${text.slice(keyStart, index)}`,
        token.nextIndex,
        normalizeUnicode,
      );
      return syntax && closingProfile.ambiguousStructuralForms
        ? { ...syntax, failClosed: true }
        : syntax;
    }
    for (const mixedCloser of closingProfile.mixedQuoteClosers) {
      if (mixedCloser.quoteForm !== openingQuoteForm) continue;
      if (keyPrefix.length + index - keyStart + mixedCloser.keyFragment.length
        > MAX_SECRET_ASSIGNMENT_KEY_UTF16) {
        return null;
      }
      const syntax = finishSecretAssignmentSyntax(
        text,
        `${keyPrefix}${text.slice(keyStart, index)}${mixedCloser.keyFragment}`,
        token.nextIndex,
        normalizeUnicode,
      );
      if (syntax) return { ...syntax, failClosed: true };
    }
    if (keyPrefix.length + token.nextIndex - keyStart > MAX_SECRET_ASSIGNMENT_KEY_UTF16
      || isNormalizedSecretAssignmentWhitespace(token.character, normalizeUnicode)) {
      return null;
    }
    index = token.nextIndex;
  }
  return null;
}

function readSecretAssignmentSyntax(text, startIndex, normalizeUnicode) {
  const openingToken = sourceCharacterAt(text, startIndex);
  const openingProfile = secretAssignmentSyntaxProfile(
    openingToken.character,
    normalizeUnicode,
  );
  const openingQuoteForms = openingProfile.quoteForms;
  let attemptedQuotedSyntax = false;
  if (openingQuoteForms.length > 0) {
    attemptedQuotedSyntax = true;
    const keyStart = openingToken.nextIndex;
    for (const openingQuoteForm of openingQuoteForms) {
      const syntax = readQuotedSecretAssignmentSyntax(
        text,
        keyStart,
        openingQuoteForm,
        normalizeUnicode,
      );
      if (syntax) {
        return openingProfile.ambiguousStructuralForms
          ? { ...syntax, failClosed: true }
          : syntax;
      }
    }
  }
  for (const mixedOpener of openingProfile.mixedQuoteOpeners) {
    attemptedQuotedSyntax = true;
    const syntax = readQuotedSecretAssignmentSyntax(
      text,
      openingToken.nextIndex,
      mixedOpener.quoteForm,
      normalizeUnicode,
      mixedOpener.keyFragment,
    );
    if (syntax) return { ...syntax, failClosed: true };
  }
  if (attemptedQuotedSyntax) return null;

  let index = startIndex;
  while (index < text.length) {
    const token = sourceCharacterAt(text, index);
    if (classifySecretAssignmentDelimiter(token.character, normalizeUnicode)
      || isNormalizedSecretAssignmentWhitespace(token.character, normalizeUnicode)
      || secretAssignmentQuoteForms(token.character, normalizeUnicode).length > 0
      || token.character === '&'
      || token.character === ','
      || token.character === ';'
      || token.character === '{'
      || token.character === '}'
      || token.character === '['
      || token.character === ']') {
      break;
    }
    if (token.nextIndex - startIndex > MAX_SECRET_ASSIGNMENT_KEY_UTF16) return null;
    index = token.nextIndex;
  }
  if (index === startIndex) return null;
  return finishSecretAssignmentSyntax(
    text,
    text.slice(startIndex, index),
    index,
    normalizeUnicode,
  );
}

function endsWithNormalizedIdentifierCharacter(character, normalizeUnicode) {
  return secretAssignmentSyntaxProfile(character, normalizeUnicode).identifierTail;
}

function isPotentialSecretAssignmentStart(character, normalizeUnicode) {
  const profile = secretAssignmentSyntaxProfile(character, normalizeUnicode);
  return profile.quoteForms.length > 0
    || profile.mixedQuoteOpeners.length > 0
    || profile.potentialKeyStart;
}

function containsExactSecretAssignment(text, valueEncoding) {
  SECRET_ASSIGNMENT_EXACT_SYNTAX_PATTERN.lastIndex = 0;
  for (let match = SECRET_ASSIGNMENT_EXACT_SYNTAX_PATTERN.exec(text);
    match;
    match = SECRET_ASSIGNMENT_EXACT_SYNTAX_PATTERN.exec(text)) {
    const value = readSecretAssignmentValue(
      text,
      SECRET_ASSIGNMENT_EXACT_SYNTAX_PATTERN.lastIndex,
      valueEncoding,
      false,
    );
    if (value.matched && value.hasMinimumBytes) {
      SECRET_ASSIGNMENT_EXACT_SYNTAX_PATTERN.lastIndex = 0;
      return true;
    }
  }
  SECRET_ASSIGNMENT_EXACT_SYNTAX_PATTERN.lastIndex = 0;
  return false;
}

function containsSecretAssignment(text, { normalizeUnicode, valueEncoding }) {
  if (containsExactSecretAssignment(text, valueEncoding)) return true;
  if (!normalizeUnicode || !NON_ASCII_PATTERN.test(text)) return false;
  let previousCharacter = null;
  for (let index = 0; index < text.length;) {
    const token = sourceCharacterAt(text, index);
    if (isPotentialSecretAssignmentStart(token.character, normalizeUnicode)
      && (previousCharacter === null
        || !endsWithNormalizedIdentifierCharacter(previousCharacter, normalizeUnicode))) {
      const syntax = readSecretAssignmentSyntax(text, index, normalizeUnicode);
      if (syntax) {
        if (syntax.failClosed) return true;
        const value = readSecretAssignmentValue(
          text,
          syntax.valueStart,
          valueEncoding,
          normalizeUnicode,
        );
        if (value.matched && value.hasMinimumBytes) return true;
      }
    }
    previousCharacter = token.character;
    index = token.nextIndex;
  }
  return false;
}

function bytePreservationTextViews(content) {
  const views = [{
    text: content.toString('latin1'),
    valueEncoding: 'latin1',
    normalizeAssignments: false,
  }];
  for (const offset of [0, 1]) {
    const available = content.byteLength - offset;
    const evenBytes = available - (available % 2);
    if (evenBytes <= 0) continue;
    const aligned = content.subarray(offset, offset + evenBytes);
    views.push({
      text: aligned.toString('utf16le'),
      valueEncoding: 'utf16le',
      normalizeAssignments: true,
    });
    const bigEndian = Buffer.from(aligned);
    bigEndian.swap16();
    views.push({
      text: bigEndian.toString('utf16le'),
      valueEncoding: 'utf16le',
      normalizeAssignments: true,
    });
  }
  return views;
}

function fatalDecode(content, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function canonicalUnicodeTextViews(content) {
  const views = [];
  const utf8 = fatalDecode(content, 'utf-8');
  if (utf8 !== null) views.push({ text: utf8, valueEncoding: 'utf8' });
  if (content.byteLength >= 2 && (content.byteLength - 2) % 2 === 0) {
    if (content[0] === 0xff && content[1] === 0xfe) {
      const utf16le = fatalDecode(content.subarray(2), 'utf-16le');
      if (utf16le !== null) views.push({ text: utf16le, valueEncoding: 'utf16le' });
    } else if (content[0] === 0xfe && content[1] === 0xff) {
      const utf16be = fatalDecode(content.subarray(2), 'utf-16be');
      if (utf16be !== null) views.push({ text: utf16be, valueEncoding: 'utf16le' });
    }
  }
  return views;
}

function decodeCanonicalBase64(candidate) {
  const normalized = candidate.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
  if (normalized.length % 4 === 1) return null;
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`;
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized) return null;
  return decoded;
}

function containsRecognizedSecretText(text) {
  return securityPatternsMatch(SECRET_CONTENT_PATTERNS, text)
    || containsSecretAssignment(text, { normalizeUnicode: true, valueEncoding: 'utf8' });
}

function containsRecognizedSecretView(view, { normalizePatterns, normalizeAssignments }) {
  const patternMatched = normalizePatterns
    ? securityPatternsMatch(SECRET_CONTENT_PATTERNS, view.text)
    : SECRET_CONTENT_PATTERNS.some((pattern) => exactPatternMatches(pattern, view.text));
  return patternMatched || containsSecretAssignment(view.text, {
    normalizeUnicode: normalizeAssignments,
    valueEncoding: view.valueEncoding,
  });
}

function containsRecognizedSecretPayload(content) {
  return bytePreservationTextViews(content).some(
    (view) => containsRecognizedSecretView(view, {
      normalizePatterns: false,
      normalizeAssignments: view.normalizeAssignments,
    }),
  ) || canonicalUnicodeTextViews(content).some(
    (view) => containsRecognizedSecretView(view, {
      normalizePatterns: true,
      normalizeAssignments: true,
    }),
  );
}

function containsRecognizedSecretBytes(content) {
  const rawViews = bytePreservationTextViews(content);
  if (containsRecognizedSecretPayload(content)) return true;
  for (const { text } of rawViews) {
    BASE64_CANDIDATE_PATTERN.lastIndex = 0;
    for (let match = BASE64_CANDIDATE_PATTERN.exec(text);
      match;
      match = BASE64_CANDIDATE_PATTERN.exec(text)) {
      const decoded = decodeCanonicalBase64(match[0]);
      if (decoded && containsRecognizedSecretPayload(decoded)) return true;
    }
    MIME_BASE64_BLOCK_PATTERN.lastIndex = 0;
    for (let match = MIME_BASE64_BLOCK_PATTERN.exec(text);
      match;
      match = MIME_BASE64_BLOCK_PATTERN.exec(text)) {
      const decoded = decodeCanonicalBase64(match[0].replace(/\s/g, ''));
      if (decoded && containsRecognizedSecretPayload(decoded)) return true;
    }
  }
  return false;
}

function requireEd25519Signature(value) {
  if (typeof value !== 'string'
    || value.length < 80
    || value.length > 100
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('E2B independent source signature must be canonical base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
    throw new TypeError('E2B independent source signature must be a canonical Ed25519 signature');
  }
  return bytes;
}

function independentAttestationPayload(request, verifierKeyHash, verifierArtifactHash) {
  return deepFreeze({
    schema: E2B_INDEPENDENT_SOURCE_ATTESTATION_SCHEMA,
    status: 'verified',
    source_request_hash: request.request_hash,
    workspace_digest: request.workspace_digest,
    workspace_manifest_hash: request.workspace_manifest_hash,
    file_manifest_hash: sha256Ref(request.files),
    clean_template_id_hash: request.clean_template_id_hash,
    clean_template_evidence_hash: request.clean_template_evidence_hash,
    trusted_bootstrap_artifact_hash: request.trusted_bootstrap_artifact_hash,
    trusted_runner_artifact_hash: request.trusted_runner_artifact_hash,
    scanner_artifact_hash: verifierArtifactHash,
    verifier_key_hash: verifierKeyHash,
    claims: {
      authority_free: true,
      credentials_absent: true,
      wallet_material_absent: true,
      execution_authority_absent: true,
      exact_request_export_manifest_binding_verified: true,
    },
  });
}

function validateRequest(value) {
  assertPlainObject(value, 'E2B authority-free source request');
  assertAllowedKeys(value, REQUEST_KEYS, 'E2B authority-free source request');
  if (value.schema !== REQUEST_SCHEMA || value.provider !== 'e2b-clean-template-v1') {
    throw new TypeError('E2B authority-free source request schema or provider is invalid');
  }
  requireOpaqueRef(value.cleanup_ref, 'E2B source request.cleanup_ref');
  for (const field of [
    'capsule_hash',
    'workspace_digest',
    'workspace_manifest_hash',
    'clean_template_id_hash',
    'clean_template_evidence_hash',
    'trusted_bootstrap_command_hash',
    'trusted_runner_command_hash',
    'trusted_bootstrap_artifact_hash',
    'trusted_runner_artifact_hash',
    'request_hash',
  ]) {
    requireSha256Ref(value[field], `E2B source request.${field}`);
  }
  const fileCount = boundedInteger(value.file_count, 'E2B source request.file_count', {
    min: 0,
    max: 100_000,
  });
  const totalBytes = boundedInteger(value.total_bytes, 'E2B source request.total_bytes', {
    min: 0,
    max: 1024 * 1024 * 1024,
  });
  if (!Array.isArray(value.files) || value.files.length !== fileCount) {
    throw new TypeError('E2B source request file manifest is invalid');
  }
  let summedBytes = 0;
  const files = value.files.map((entry, index) => {
    const field = `E2B source request.files[${index}]`;
    assertPlainObject(entry, field);
    assertAllowedKeys(entry, ['path', 'bytes', 'content_hash'], field);
    const relative = normalizeRelativePath(entry.path, `${field}.path`);
    const bytes = boundedInteger(entry.bytes, `${field}.bytes`, {
      min: 0,
      max: 1024 * 1024 * 1024,
    });
    summedBytes += bytes;
    return {
      path: relative,
      bytes,
      content_hash: requireSha256Ref(entry.content_hash, `${field}.content_hash`),
    };
  });
  if (summedBytes !== totalBytes) throw new Error('E2B source request total_bytes mismatch');
  const uniquePaths = new Set(files.map((entry) => entry.path));
  if (uniquePaths.size !== files.length) throw new Error('E2B source request paths are not unique');
  const expectedHash = sha256Ref({ ...cloneJson(value), request_hash: null });
  if (!safeEqual(value.request_hash, expectedHash)) {
    throw new Error('E2B authority-free source request hash mismatch');
  }
  const normalized = { ...cloneJson(value), files };
  if (canonicalize(normalized) !== canonicalize(value)) {
    throw new Error('E2B authority-free source request is not canonical and closed');
  }
  return normalized;
}

export function scanE2BStagedBytesAuthorityFree(files) {
  for (const file of files) {
    if (securityPatternMatches(SECRET_PATH_PATTERN, file.path)
      || containsRecognizedSecretText(file.path)) {
      throw new Error('E2B staged export contains a secret-shaped path');
    }
    const content = Buffer.from(file.data_base64, 'base64');
    if (content.byteLength !== file.bytes
      || !safeEqual(sha256Ref(content.toString('base64')), file.content_hash)) {
      throw new Error('E2B staged export exact-byte binding mismatch');
    }
    if (containsRecognizedSecretBytes(content)) {
      throw new Error('E2B staged export contains authority or secret-shaped material');
    }
  }
}

async function assertRealDirectory(directory, field) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TypeError(`${field} must be a real directory`);
  }
  const resolved = await realpath(directory);
  if (resolved !== directory) throw new Error(`${field} must already be canonical`);
}

async function persistEvidence(directory, record) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRealDirectory(directory, 'E2B source evidence directory');
  const name = `e2b-source-${record.request_hash.slice(7, 31)}.json`;
  const target = path.join(directory, name);
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o400,
  );
  try {
    await handle.writeFile(`${canonicalize(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createE2BAuthorityFreeSourceVerifier(options = {}) {
  const verifierArtifactHash = requireSha256Ref(
    options.verifierArtifactHash,
    'E2B source verifierArtifactHash',
  );
  const evidenceDirectory = path.resolve(requireString(
    options.evidenceDirectory,
    'E2B source evidenceDirectory',
  ));
  const trustedBootstrapArtifactPath = options.trustedBootstrapArtifactPath;
  const trustedRunnerArtifactPath = options.trustedRunnerArtifactPath;
  if (!(typeof trustedBootstrapArtifactPath === 'string'
    || trustedBootstrapArtifactPath instanceof URL)) {
    throw new TypeError('trustedBootstrapArtifactPath must be a path or file URL');
  }
  if (!(typeof trustedRunnerArtifactPath === 'string'
    || trustedRunnerArtifactPath instanceof URL)) {
    throw new TypeError('trustedRunnerArtifactPath must be a path or file URL');
  }
  if (typeof options.requestIndependentVerification !== 'function') {
    throw new TypeError(
      'requestIndependentVerification must be an external independent source verifier',
    );
  }
  let independentVerifierPublicKey;
  try {
    independentVerifierPublicKey = options.independentVerifierPublicKey?.type === 'public'
      ? options.independentVerifierPublicKey
      : createPublicKey(options.independentVerifierPublicKey);
  } catch {
    throw new TypeError('independentVerifierPublicKey must be a valid public key');
  }
  if (independentVerifierPublicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('independentVerifierPublicKey must be Ed25519');
  }
  const observedIndependentVerifierKeyHash = sha256BytesRef(
    independentVerifierPublicKey.export({ type: 'spki', format: 'der' }),
  );
  const expectedIndependentVerifierKeyHash = requireSha256Ref(
    options.independentVerifierPublicKeyHash,
    'independentVerifierPublicKeyHash',
  );
  if (!safeEqual(observedIndependentVerifierKeyHash, expectedIndependentVerifierKeyHash)) {
    throw new Error('independentVerifierPublicKeyHash does not match the pinned public key');
  }
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('E2B source verifier clock must be a function');

  return async function verifyAuthorityFreeSource(requestValue, context = {}) {
    const request = validateRequest(requestValue);
    assertPlainObject(context, 'E2B source verifier context');
    assertAllowedKeys(context, ['export_directory'], 'E2B source verifier context');
    const exportDirectory = path.resolve(requireString(
      context.export_directory,
      'E2B source verifier export_directory',
    ));
    await assertRealDirectory(exportDirectory, 'E2B source verifier export_directory');
    const exportId = path.basename(exportDirectory);
    const exportRoot = path.dirname(exportDirectory);
    const staged = await readImmutableWorkspaceExport({
      export_root: exportRoot,
      export_id: exportId,
      manifest_hash: request.workspace_manifest_hash,
      workspace_digest: request.workspace_digest,
    });
    if (staged.manifest.file_count !== request.file_count
      || staged.manifest.total_bytes !== request.total_bytes
      || canonicalize(staged.manifest.files) !== canonicalize(request.files)) {
      throw new Error('E2B independently reopened staged export does not match the request manifest');
    }
    scanE2BStagedBytesAuthorityFree(staged.files);

    const bootstrapArtifactHash = await sha256FileRef(trustedBootstrapArtifactPath);
    const runnerArtifactHash = await sha256FileRef(trustedRunnerArtifactPath);
    if (!safeEqual(bootstrapArtifactHash, request.trusted_bootstrap_artifact_hash)) {
      throw new Error('E2B trusted bootstrap artifact hash does not match the reviewed file');
    }
    if (!safeEqual(runnerArtifactHash, request.trusted_runner_artifact_hash)) {
      throw new Error('E2B trusted runner artifact hash does not match the reviewed file');
    }

    const independentPayload = independentAttestationPayload(
      request,
      observedIndependentVerifierKeyHash,
      verifierArtifactHash,
    );
    const independentAttestation = await options.requestIndependentVerification(
      independentPayload,
      { export_directory: exportDirectory },
    );
    assertPlainObject(independentAttestation, 'E2B independent source attestation');
    assertAllowedKeys(
      independentAttestation,
      [...Object.keys(independentPayload), 'signature'],
      'E2B independent source attestation',
    );
    const { signature: signatureValue, ...signedPayload } = independentAttestation;
    if (canonicalize(signedPayload) !== canonicalize(independentPayload)) {
      throw new Error('E2B independent source attestation binding mismatch');
    }
    const signature = requireEd25519Signature(signatureValue);
    if (!verifySignature(
      null,
      Buffer.from(canonicalize(independentPayload), 'utf8'),
      independentVerifierPublicKey,
      signature,
    )) {
      throw new Error('E2B independent source attestation signature is invalid');
    }
    const independentAttestationHash = sha256Ref(independentAttestation);

    const evidenceCore = {
      schema: EVIDENCE_SCHEMA,
      status: 'verified_deterministic_clean_side_second_pass',
      observed_at: new Date(clock()).toISOString(),
      request_hash: request.request_hash,
      capsule_hash: request.capsule_hash,
      workspace_digest: request.workspace_digest,
      workspace_manifest_hash: request.workspace_manifest_hash,
      file_manifest_hash: sha256Ref(request.files),
      verifier_artifact_hash: verifierArtifactHash,
      trusted_bootstrap_artifact_hash: bootstrapArtifactHash,
      trusted_runner_artifact_hash: runnerArtifactHash,
      file_count: request.file_count,
      total_bytes: request.total_bytes,
      exact_staged_bytes_reopened: true,
      secret_and_authority_scan_passed: true,
      independent_signature_verified: true,
      independent_verifier_key_hash: observedIndependentVerifierKeyHash,
      independent_attestation_hash: independentAttestationHash,
      same_process_independent_review_claimed: false,
      raw_bytes_included: false,
      local_paths_included: false,
      credentials_included: false,
      wallet_material_included: false,
      execution_authority_included: false,
      evidence_hash: null,
    };
    const evidence = {
      ...evidenceCore,
      evidence_hash: sha256Ref(evidenceCore),
    };
    await persistEvidence(evidenceDirectory, evidence);
    return deepFreeze({
      schema: ATTESTATION_SCHEMA,
      status: 'verified',
      request_hash: request.request_hash,
      evidence_ref: `e2b-source-verification:${request.request_hash.slice(7, 31)}`,
      evidence_hash: evidence.evidence_hash,
      workspace_digest: request.workspace_digest,
      workspace_manifest_hash: request.workspace_manifest_hash,
      trusted_bootstrap_artifact_hash: bootstrapArtifactHash,
      trusted_runner_artifact_hash: runnerArtifactHash,
      claims: {
        authority_free: true,
        credentials_absent: true,
        wallet_material_absent: true,
        execution_authority_absent: true,
        workspace_manifest_verified: true,
        immutable_export_verified: true,
        trusted_runtime_artifacts_verified: true,
      },
    });
  };
}
