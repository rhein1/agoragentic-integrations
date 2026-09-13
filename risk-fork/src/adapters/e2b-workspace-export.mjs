import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalize, sha256Ref } from '../canonical.mjs';
import {
  AGORAGENTIC_API_KEY_PATTERN,
  BEARER_CREDENTIAL_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
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

const EXPORT_SCHEMA = 'agoragentic.risk-fork.immutable-workspace-export.v1';
const SECRET_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|\.aws|\.azure|\.config\/gcloud|\.docker\/config\.json|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.ssh|credentials?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|private[_-]?key(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|wallet(?:\.[^/]*)?)(?:$|\/)/i;
const SECRET_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  BEARER_CREDENTIAL_PATTERN,
  AGORAGENTIC_API_KEY_PATTERN,
  EMBEDDED_CREDENTIAL_TOKEN_PATTERN,
  GENERIC_CREDENTIAL_TOKEN_PATTERN,
  /\be2b_[A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
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
const MAX_WORKSPACE_ENTRIES = 200_000;
const MAX_WORKSPACE_DEPTH = 512;
const MAX_CLEANUP_ENTRIES = MAX_WORKSPACE_ENTRIES + 2;
const MAX_CLEANUP_DEPTH = MAX_WORKSPACE_DEPTH + 1;
const MAX_CLEANUP_MANIFEST_BYTES = 64 * 1024 * 1024;

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

function requireExportId(value) {
  const exportId = requireOpaqueRef(value, 'workspace export id', { maxLength: 100 });
  if (!/^[A-Za-z0-9_-]+$/.test(exportId)) {
    throw new TypeError('workspace export id must contain only letters, numbers, underscore, or dash');
  }
  return exportId;
}

function ownedExportPath(exportRoot, exportId) {
  const root = path.resolve(requireString(exportRoot, 'workspace export root'));
  const target = path.resolve(root, requireExportId(exportId));
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('workspace export path escapes its configured root');
  }
  return { root, target };
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function lstatIfPresent(target, options) {
  try {
    return await lstat(target, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoSecretPath(relative) {
  if (securityPatternMatches(SECRET_PATH_PATTERN, relative)
    || containsRecognizedSecretText(relative)) {
    throw new Error('Workspace export rejects a credential or secret-shaped path');
  }
}

function assertNoSecretMaterial(relative, content) {
  assertNoSecretPath(relative);
  // Latin-1 preserves a one-code-unit-to-one-byte view of the exact bounded
  // buffer read through the stable file handle. Every marker below is ASCII,
  // so invalid UTF-8 cannot erase or merge bytes around a credential marker.
  if (containsRecognizedSecretBytes(content)) {
    throw new Error('Workspace export rejects authority or secret-shaped material');
  }
}

function stableIdentity(info) {
  return {
    dev: typeof info.dev === 'bigint' ? info.dev.toString() : String(info.dev),
    ino: typeof info.ino === 'bigint' ? info.ino.toString() : String(info.ino),
    size: typeof info.size === 'bigint' ? info.size.toString() : String(info.size),
    mtime_ms: Number(info.mtimeMs),
  };
}

function assertWithinRealRoot(rootReal, candidateReal, field) {
  const relative = path.relative(rootReal, candidateReal);
  if (relative === '') return;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${field} escapes the workspace root`);
  }
}

async function readStableFile(absolute, relative, rootReal, maxReadableBytes) {
  const before = await lstat(absolute, { bigint: true });
  if (before.isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${relative}`);
  if (!before.isFile()) throw new Error(`Special filesystem entry is forbidden: ${relative}`);
  if (before.nlink > 1n) throw new Error(`Hard-linked files are forbidden: ${relative}`);
  const beforeReal = await realpath(absolute);
  assertWithinRealRoot(rootReal, beforeReal, `Workspace file ${relative}`);
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink > 1n) {
      throw new Error(`Workspace entry changed type while exporting: ${relative}`);
    }
    if (opened.size > BigInt(maxReadableBytes)) {
      throw new Error(`Workspace exceeds its bounded byte allowance at ${relative}`);
    }
    if (JSON.stringify(stableIdentity(before)) !== JSON.stringify(stableIdentity(opened))) {
      throw new Error(`Workspace path changed while it was opened: ${relative}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (JSON.stringify(stableIdentity(opened)) !== JSON.stringify(stableIdentity(after))) {
      throw new Error(`Workspace file changed while exporting: ${relative}`);
    }
    const currentPath = await lstat(absolute, { bigint: true });
    if (JSON.stringify(stableIdentity(before)) !== JSON.stringify(stableIdentity(currentPath))) {
      throw new Error(`Workspace path changed while exporting: ${relative}`);
    }
    const currentReal = await realpath(absolute);
    assertWithinRealRoot(rootReal, currentReal, `Workspace file ${relative}`);
    if (currentReal !== beforeReal) throw new Error(`Workspace path target changed: ${relative}`);
    assertNoSecretMaterial(relative, content);
    return content;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function enumerateWorkspace(root, { maxFiles, maxBytes, includeContent }) {
  const rootReal = await realpath(root);
  const records = [];
  const seenCaseFolded = new Map();
  let totalBytes = 0;
  let totalEntries = 0;

  async function visit(directory, prefix = '', rawPrefix = '', depth = 0) {
    if (depth > MAX_WORKSPACE_DEPTH) {
      throw new Error('Workspace exceeds its directory depth allowance');
    }
    const directoryBefore = await lstat(directory, { bigint: true });
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error(`Workspace directory changed type: ${prefix || '.'}`);
    }
    const directoryReal = await realpath(directory);
    assertWithinRealRoot(rootReal, directoryReal, `Workspace directory ${prefix || '.'}`);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      totalEntries += 1;
      if (totalEntries > MAX_WORKSPACE_ENTRIES) {
        throw new Error('Workspace exceeds its bounded filesystem entry allowance');
      }
      const rawRelative = rawPrefix ? `${rawPrefix}/${entry.name}` : entry.name;
      const relative = normalizeRelativePath(
        rawRelative,
        'workspace export path',
      );
      assertNoSecretPath(relative);
      if (relative === '.git' || relative.startsWith('.git/')) {
        throw new Error('Workspace exports exclude .git metadata');
      }
      const folded = relative.normalize('NFC').toLocaleLowerCase('en-US');
      const collision = seenCaseFolded.get(folded);
      if (collision && collision.raw_relative !== rawRelative) {
        throw new Error(
          `Case or Unicode path collision: ${collision.raw_relative} and ${rawRelative}`,
        );
      }
      seenCaseFolded.set(folded, { raw_relative: rawRelative, normalized_relative: relative });
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${relative}`);
      if (info.isDirectory()) {
        await visit(absolute, relative, rawRelative, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error(`Special filesystem entry is forbidden: ${relative}`);
      if (info.nlink > 1n) throw new Error(`Hard-linked files are forbidden: ${relative}`);
      if (records.length + 1 > maxFiles) throw new Error(`Workspace exceeds ${maxFiles} files`);
      if (info.size > BigInt(maxBytes - totalBytes)) {
        throw new Error(`Workspace exceeds ${maxBytes} bytes`);
      }
      const content = await readStableFile(
        absolute,
        relative,
        rootReal,
        maxBytes - totalBytes,
      );
      totalBytes += content.byteLength;
      if (totalBytes > maxBytes) throw new Error(`Workspace exceeds ${maxBytes} bytes`);
      records.push({
        path: relative,
        bytes: content.byteLength,
        content_hash: sha256Ref(content.toString('base64')),
        ...(includeContent ? { content } : {}),
      });
    }
    const directoryAfter = await lstat(directory, { bigint: true });
    if (JSON.stringify(stableIdentity(directoryBefore))
      !== JSON.stringify(stableIdentity(directoryAfter))) {
      throw new Error(`Workspace directory changed while exporting: ${prefix || '.'}`);
    }
    const directoryRealAfter = await realpath(directory);
    assertWithinRealRoot(rootReal, directoryRealAfter, `Workspace directory ${prefix || '.'}`);
    if (directoryRealAfter !== directoryReal) {
      throw new Error(`Workspace directory target changed: ${prefix || '.'}`);
    }
  }

  await visit(root);
  const publicRecords = records.map(({ content: _content, ...record }) => record);
  return {
    records,
    public_records: publicRecords,
    file_count: publicRecords.length,
    total_bytes: totalBytes,
    workspace_digest: sha256Ref(publicRecords),
  };
}

async function writeExclusive(target, content, mode = 0o400) {
  const handle = await open(target, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function makeTreeReadOnly(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(target);
      await chmod(target, 0o500);
    } else {
      await chmod(target, 0o400);
    }
  }
  await chmod(directory, 0o500);
}

function assertStableCleanupIdentity(before, after, field) {
  if (JSON.stringify(stableIdentity(before)) !== JSON.stringify(stableIdentity(after))) {
    throw new Error(`${field} changed during immutable export cleanup`);
  }
}

async function makeOwnedDirectoryWritable(directory, before) {
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  const directoryOnly = Number.isInteger(constants.O_DIRECTORY) ? constants.O_DIRECTORY : 0;
  if (process.platform !== 'win32' && directoryOnly !== 0) {
    let handle;
    try {
      handle = await open(directory, constants.O_RDONLY | noFollow | directoryOnly);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory()) {
        throw new Error('Immutable workspace export cleanup directory changed type');
      }
      assertStableCleanupIdentity(before, opened, 'Immutable workspace export cleanup directory');
      await handle.chmod(0o700);
      const writable = await handle.stat({ bigint: true });
      assertStableCleanupIdentity(opened, writable, 'Immutable workspace export cleanup directory');
      return writable;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  // Windows does not expose POSIX directory mode semantics. The path remains
  // inside the clean-host-owned export root and is identity-checked both before
  // and immediately after this compatibility chmod.
  await chmod(directory, 0o700);
  const writable = await lstat(directory, { bigint: true });
  if (writable.isSymbolicLink() || !writable.isDirectory()) {
    throw new Error('Immutable workspace export cleanup directory changed type');
  }
  assertStableCleanupIdentity(before, writable, 'Immutable workspace export cleanup directory');
  return writable;
}

async function validateOwnedTreeForCleanup(directory, rootReal, state, depth = 0) {
  if (depth > MAX_CLEANUP_DEPTH) {
    throw new Error('Immutable workspace export cleanup exceeds its depth bound');
  }
  const before = await lstat(directory, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error('Immutable workspace export cleanup refuses a substituted directory');
  }
  const beforeReal = await realpath(directory);
  assertWithinRealRoot(rootReal, beforeReal, 'Immutable workspace export cleanup directory');
  const entries = await readdir(directory, { withFileTypes: true });
  state.entries += entries.length;
  if (state.entries > MAX_CLEANUP_ENTRIES) {
    throw new Error('Immutable workspace export cleanup exceeds its entry bound');
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink()) {
      throw new Error('Immutable workspace export cleanup refuses symlinks');
    }
    if (info.isDirectory()) {
      await validateOwnedTreeForCleanup(target, rootReal, state, depth + 1);
      continue;
    }
    if (!info.isFile()) {
      throw new Error('Immutable workspace export cleanup refuses special filesystem entries');
    }
    if (info.nlink > 1n) {
      throw new Error('Immutable workspace export cleanup refuses hard-linked files');
    }
    const fileReal = await realpath(target);
    assertWithinRealRoot(rootReal, fileReal, 'Immutable workspace export cleanup file');
    const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | noFollow);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink > 1n) {
        throw new Error('Immutable workspace export cleanup refuses a changed or hard-linked file');
      }
      assertStableCleanupIdentity(info, opened, 'Immutable workspace export cleanup file');
    } finally {
      await handle?.close().catch(() => {});
    }
    const current = await lstat(target, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() || current.nlink > 1n) {
      throw new Error('Immutable workspace export cleanup refuses a changed or hard-linked file path');
    }
    assertStableCleanupIdentity(info, current, 'Immutable workspace export cleanup file path');
    const currentReal = await realpath(target);
    assertWithinRealRoot(rootReal, currentReal, 'Immutable workspace export cleanup file');
    if (currentReal !== fileReal) {
      throw new Error('Immutable workspace export cleanup file target changed');
    }
  }
  const after = await lstat(directory, { bigint: true });
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new Error('Immutable workspace export cleanup directory path changed type');
  }
  assertStableCleanupIdentity(before, after, 'Immutable workspace export cleanup directory path');
  const afterReal = await realpath(directory);
  assertWithinRealRoot(rootReal, afterReal, 'Immutable workspace export cleanup directory');
  if (afterReal !== beforeReal) {
    throw new Error('Immutable workspace export cleanup directory target changed');
  }
}

async function makeOwnedTreeWritable(directory, rootReal, state, depth = 0) {
  if (depth > MAX_CLEANUP_DEPTH) {
    throw new Error('Immutable workspace export cleanup exceeds its depth bound');
  }
  const before = await lstat(directory, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error('Immutable workspace export cleanup refuses a substituted directory');
  }
  const beforeReal = await realpath(directory);
  assertWithinRealRoot(rootReal, beforeReal, 'Immutable workspace export cleanup directory');
  await makeOwnedDirectoryWritable(directory, before);

  const entries = await readdir(directory, { withFileTypes: true });
  state.entries += entries.length;
  if (state.entries > MAX_CLEANUP_ENTRIES) {
    throw new Error('Immutable workspace export cleanup exceeds its entry bound');
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink()) {
      throw new Error('Immutable workspace export cleanup refuses symlinks');
    }
    if (info.isDirectory()) {
      await makeOwnedTreeWritable(target, rootReal, state, depth + 1);
      continue;
    }
    if (!info.isFile()) {
      throw new Error('Immutable workspace export cleanup refuses special filesystem entries');
    }
    if (info.nlink > 1n) {
      throw new Error('Immutable workspace export cleanup refuses hard-linked files');
    }
    const fileReal = await realpath(target);
    assertWithinRealRoot(rootReal, fileReal, 'Immutable workspace export cleanup file');
    const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | noFollow);
      const openedFile = await handle.stat({ bigint: true });
      if (!openedFile.isFile()) {
        throw new Error('Immutable workspace export cleanup file changed type');
      }
      if (openedFile.nlink > 1n) {
        throw new Error('Immutable workspace export cleanup refuses hard-linked files');
      }
      assertStableCleanupIdentity(info, openedFile, 'Immutable workspace export cleanup file');
      await handle.chmod(0o600);
      const writableFile = await handle.stat({ bigint: true });
      if (writableFile.nlink > 1n) {
        throw new Error('Immutable workspace export cleanup refuses hard-linked files');
      }
      assertStableCleanupIdentity(openedFile, writableFile, 'Immutable workspace export cleanup file');
    } finally {
      await handle?.close().catch(() => {});
    }
    const current = await lstat(target, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error('Immutable workspace export cleanup file path changed type');
    }
    if (current.nlink > 1n) {
      throw new Error('Immutable workspace export cleanup refuses hard-linked files');
    }
    assertStableCleanupIdentity(info, current, 'Immutable workspace export cleanup file path');
    const currentReal = await realpath(target);
    assertWithinRealRoot(rootReal, currentReal, 'Immutable workspace export cleanup file');
    if (currentReal !== fileReal) {
      throw new Error('Immutable workspace export cleanup file target changed');
    }
  }

  const after = await lstat(directory, { bigint: true });
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new Error('Immutable workspace export cleanup directory path changed type');
  }
  assertStableCleanupIdentity(before, after, 'Immutable workspace export cleanup directory path');
  const afterReal = await realpath(directory);
  assertWithinRealRoot(rootReal, afterReal, 'Immutable workspace export cleanup directory');
  if (afterReal !== beforeReal) {
    throw new Error('Immutable workspace export cleanup directory target changed');
  }
}

async function validateOwnedCleanupManifest(target, exportId) {
  const manifestPath = path.join(target, 'manifest.json');
  const before = await lstat(manifestPath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Immutable workspace export cleanup manifest is not a regular file');
  }
  if (before.nlink > 1n) {
    throw new Error('Immutable workspace export cleanup refuses a hard-linked manifest');
  }
  if (before.size > BigInt(MAX_CLEANUP_MANIFEST_BYTES)) {
    throw new Error('Immutable workspace export cleanup manifest exceeds its byte bound');
  }
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error('Immutable workspace export cleanup manifest changed type');
    }
    if (opened.nlink > 1n) {
      throw new Error('Immutable workspace export cleanup refuses a hard-linked manifest');
    }
    assertStableCleanupIdentity(before, opened, 'Immutable workspace export cleanup manifest');
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_CLEANUP_MANIFEST_BYTES) {
      throw new Error('Immutable workspace export cleanup manifest exceeds its byte bound');
    }
    const after = await handle.stat({ bigint: true });
    if (after.nlink > 1n) {
      throw new Error('Immutable workspace export cleanup refuses a hard-linked manifest');
    }
    assertStableCleanupIdentity(opened, after, 'Immutable workspace export cleanup manifest');
    validateManifest(JSON.parse(bytes.toString('utf8')), { exportId });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeOwnedExportTree({ root, target, exportId, requireManifest }) {
  const rootInfo = await lstatIfPresent(root, { bigint: true });
  if (!rootInfo) {
    if (await lstatIfPresent(target, { bigint: true })) {
      throw new Error('Immutable workspace export cleanup target exists without its root');
    }
    return false;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Immutable workspace export cleanup root is not a real directory');
  }
  const targetBefore = await lstatIfPresent(target, { bigint: true });
  if (!targetBefore) return false;
  if (targetBefore.isSymbolicLink() || !targetBefore.isDirectory()) {
    throw new Error('Immutable workspace export cleanup refuses a substituted target');
  }
  const rootReal = await realpath(root);
  const targetReal = await realpath(target);
  const rootAfterRealpath = await lstat(root, { bigint: true });
  const targetAfterRealpath = await lstat(target, { bigint: true });
  assertStableCleanupIdentity(rootInfo, rootAfterRealpath, 'Immutable workspace export cleanup root');
  assertStableCleanupIdentity(targetBefore, targetAfterRealpath, 'Immutable workspace export cleanup target');
  assertWithinRealRoot(rootReal, targetReal, 'Immutable workspace export cleanup target');
  if (targetReal === rootReal) {
    throw new Error('Immutable workspace export cleanup refuses its configured root');
  }
  if (requireManifest) await validateOwnedCleanupManifest(target, exportId);
  await validateOwnedTreeForCleanup(target, rootReal, { entries: 0 });
  await makeOwnedTreeWritable(target, rootReal, { entries: 0 });
  const targetAfter = await lstat(target, { bigint: true });
  if (targetAfter.isSymbolicLink() || !targetAfter.isDirectory()) {
    throw new Error('Immutable workspace export cleanup target changed type');
  }
  assertStableCleanupIdentity(targetBefore, targetAfter, 'Immutable workspace export cleanup target');
  const targetRealAfter = await realpath(target);
  assertWithinRealRoot(rootReal, targetRealAfter, 'Immutable workspace export cleanup target');
  if (targetRealAfter !== targetReal) {
    throw new Error('Immutable workspace export cleanup target changed');
  }
  await rm(target, { recursive: true, force: false });
  return true;
}

function buildManifest(exportId, snapshot) {
  const manifest = {
    schema: EXPORT_SCHEMA,
    export_id: exportId,
    workspace_digest: snapshot.workspace_digest,
    file_count: snapshot.file_count,
    total_bytes: snapshot.total_bytes,
    files: cloneJson(snapshot.public_records),
    manifest_hash: null,
  };
  manifest.manifest_hash = sha256Ref({ ...manifest, manifest_hash: null });
  return manifest;
}

function validateManifest(manifest, expected = {}) {
  if (!manifest || manifest.schema !== EXPORT_SCHEMA) {
    throw new TypeError('Immutable workspace export manifest schema is invalid');
  }
  const exportId = requireExportId(manifest.export_id);
  const workspaceDigest = requireSha256Ref(manifest.workspace_digest, 'workspace export digest');
  const manifestHash = requireSha256Ref(manifest.manifest_hash, 'workspace export manifest hash');
  if (!Number.isSafeInteger(manifest.file_count) || manifest.file_count < 0) {
    throw new TypeError('workspace export file_count is invalid');
  }
  if (!Number.isSafeInteger(manifest.total_bytes) || manifest.total_bytes < 0) {
    throw new TypeError('workspace export total_bytes is invalid');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.file_count) {
    throw new TypeError('workspace export manifest file list is invalid');
  }
  const expectedHash = sha256Ref({ ...cloneJson(manifest), manifest_hash: null });
  if (!safeEqual(expectedHash, manifestHash)) throw new Error('workspace export manifest hash mismatch');
  if (expected.exportId && exportId !== expected.exportId) {
    throw new Error('workspace export id mismatch');
  }
  if (expected.manifestHash && !safeEqual(manifestHash, expected.manifestHash)) {
    throw new Error('workspace export expected manifest hash mismatch');
  }
  if (expected.workspaceDigest && !safeEqual(workspaceDigest, expected.workspaceDigest)) {
    throw new Error('workspace export expected digest mismatch');
  }
  return manifest;
}

export function workspaceExportPath(exportRoot, exportId) {
  return ownedExportPath(exportRoot, exportId).target;
}

export async function createImmutableWorkspaceExport(input = {}) {
  const sourceWorkspace = path.resolve(requireString(input.source_workspace, 'source_workspace'));
  const sourceInfo = await lstat(sourceWorkspace);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new TypeError('source_workspace must be a real directory, not a symlink');
  }
  const sourceReal = await realpath(sourceWorkspace);
  const exportId = requireExportId(input.export_id);
  const { root, target } = ownedExportPath(input.export_root, exportId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootReal = await realpath(root);
  if (rootReal === sourceReal
    || rootReal.startsWith(`${sourceReal}${path.sep}`)
    || sourceReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error('workspace source and export root must be disjoint');
  }
  if (await pathExists(target)) throw new Error(`Workspace export already exists: ${exportId}`);
  const maxFiles = boundedInteger(input.max_files ?? 2_000, 'max_files', {
    min: 1,
    max: 100_000,
  });
  const maxBytes = boundedInteger(input.max_bytes ?? 32 * 1024 * 1024, 'max_bytes', {
    min: 1,
    max: 1024 * 1024 * 1024,
  });
  const expectedWorkspaceDigest = requireSha256Ref(
    input.expected_workspace_digest,
    'expected_workspace_digest',
  );

  const source = await enumerateWorkspace(sourceWorkspace, {
    maxFiles,
    maxBytes,
    includeContent: true,
  });
  if (!safeEqual(source.workspace_digest, expectedWorkspaceDigest)) {
    throw new Error('Source workspace digest does not match the Savepoint Capsule');
  }

  const payloadDirectory = path.join(target, 'payload');
  let targetCreated = false;
  try {
    await mkdir(target, { mode: 0o700 });
    targetCreated = true;
    const targetReal = await realpath(target);
    assertWithinRealRoot(rootReal, targetReal, 'Workspace export target');
    await mkdir(payloadDirectory, { mode: 0o700 });
    for (const record of source.records) {
      const destination = path.join(payloadDirectory, ...record.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeExclusive(destination, record.content);
    }
    const copied = await enumerateWorkspace(payloadDirectory, {
      maxFiles,
      maxBytes,
      includeContent: false,
    });
    if (!safeEqual(copied.workspace_digest, source.workspace_digest)
      || canonicalize(copied.public_records) !== canonicalize(source.public_records)) {
      throw new Error('Immutable workspace export changed while it was copied');
    }
    // `source.records` contains the bounded bytes read through stable file
    // handles. From this point onward, neither verification nor upload reopens
    // mutable source paths; both operate on this exact staged copy.
    const manifest = buildManifest(exportId, copied);
    const manifestBytes = Buffer.from(`${canonicalize(manifest)}\n`, 'utf8');
    if (manifestBytes.byteLength > MAX_CLEANUP_MANIFEST_BYTES) {
      throw new Error('Workspace export manifest exceeds its bounded cleanup allowance');
    }
    await writeExclusive(path.join(target, 'manifest.json'), manifestBytes);
    await makeTreeReadOnly(target);
    return deepFreeze({
      export_id: exportId,
      export_ref: `e2b-workspace-export:${exportId}`,
      export_directory: target,
      payload_directory: payloadDirectory,
      workspace_digest: manifest.workspace_digest,
      manifest_hash: manifest.manifest_hash,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      files: cloneJson(manifest.files),
    });
  } catch (error) {
    if (targetCreated) {
      await removeOwnedExportTree({
        root,
        target,
        exportId,
        requireManifest: false,
      }).catch(() => {});
    }
    throw error;
  }
}

export async function readImmutableWorkspaceExport(input = {}) {
  const exportId = requireExportId(input.export_id);
  const { target } = ownedExportPath(input.export_root, exportId);
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8')),
    {
      exportId,
      manifestHash: input.manifest_hash,
      workspaceDigest: input.workspace_digest,
    },
  );
  const payloadDirectory = path.join(target, 'payload');
  const current = await enumerateWorkspace(payloadDirectory, {
    maxFiles: Math.max(1, manifest.file_count),
    maxBytes: Math.max(1, manifest.total_bytes),
    includeContent: true,
  });
  if (!safeEqual(current.workspace_digest, manifest.workspace_digest)
    || canonicalize(current.public_records) !== canonicalize(manifest.files)) {
    throw new Error('Immutable workspace export no longer matches its manifest');
  }
  return deepFreeze({
    manifest: cloneJson(manifest),
    files: current.records.map((record) => ({
      path: record.path,
      bytes: record.bytes,
      content_hash: record.content_hash,
      data_base64: record.content.toString('base64'),
    })),
  });
}

export async function destroyImmutableWorkspaceExport(input = {}) {
  const exportId = requireExportId(input.export_id);
  const { root, target } = ownedExportPath(input.export_root, exportId);
  await removeOwnedExportTree({ root, target, exportId, requireManifest: true });
  return { status: 'destroy_requested_observed' };
}

export async function verifyImmutableWorkspaceExportDestroyed(input = {}) {
  const exportId = requireExportId(input.export_id);
  const { root, target } = ownedExportPath(input.export_root, exportId);
  const rootInfo = await lstatIfPresent(root, { bigint: true });
  if (!rootInfo) return true;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Immutable workspace export absence check root is not a real directory');
  }
  const targetInfo = await lstatIfPresent(target, { bigint: true });
  if (!targetInfo) return true;
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new Error('Immutable workspace export absence check refuses a substituted target');
  }
  const rootReal = await realpath(root);
  const targetReal = await realpath(target);
  const rootAfter = await lstat(root, { bigint: true });
  const targetAfter = await lstat(target, { bigint: true });
  assertStableCleanupIdentity(rootInfo, rootAfter, 'Immutable workspace export absence check root');
  assertStableCleanupIdentity(targetInfo, targetAfter, 'Immutable workspace export absence check target');
  assertWithinRealRoot(rootReal, targetReal, 'Immutable workspace export absence check target');
  if (targetReal === rootReal) {
    throw new Error('Immutable workspace export absence check refuses its configured root');
  }
  return false;
}

export const E2B_IMMUTABLE_WORKSPACE_EXPORT_SCHEMA = EXPORT_SCHEMA;
