#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SVG_RELATIVE_PATH = "assets/agoragentic-agent-commerce-banner.svg";
const PNG_RELATIVE_PATH = "assets/agoragentic-integrations-social.png";
const COUNT_KEY = "agoragentic.integration_count";
const SOURCE_HASH_KEY = "agoragentic.source_svg_sha256";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, value) => {
      let current = value;
      for (let bit = 0; bit < 8; bit += 1) {
        current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
      }
      return current >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(buffer) {
  assert(buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), "social banner must be a PNG");
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    assert(offset + 12 <= buffer.length, "social banner has a truncated PNG chunk");
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert(end <= buffer.length, "social banner has an invalid PNG chunk length");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    assert.equal(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), expectedCrc, `social banner has an invalid ${type} CRC`);
    chunks.push({ type, data: Buffer.from(data), raw: Buffer.from(buffer.subarray(offset, end)) });
    offset = end;
    if (type === "IEND") break;
  }
  assert.equal(offset, buffer.length, "social banner has trailing bytes after IEND");
  return chunks;
}

function encodeChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function textEntry(chunk) {
  if (chunk.type !== "tEXt") return null;
  const separator = chunk.data.indexOf(0);
  if (separator < 1) return null;
  return [chunk.data.toString("latin1", 0, separator), chunk.data.toString("latin1", separator + 1)];
}

function stampPng(buffer, metadata) {
  const chunks = parsePng(buffer);
  const ownedKeys = new Set(Object.keys(metadata));
  const output = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    const entry = textEntry(chunk);
    if (entry && ownedKeys.has(entry[0])) continue;
    if (chunk.type === "IEND") {
      for (const [key, value] of Object.entries(metadata)) {
        output.push(encodeChunk("tEXt", Buffer.from(`${key}\0${value}`, "latin1")));
      }
    }
    output.push(chunk.raw);
  }
  return Buffer.concat(output);
}

function canonicalState(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "integrations.json"), "utf8"));
  assert(Array.isArray(manifest.integrations), "integrations.json must contain integrations[]");
  const count = manifest.integrations.length;
  const svgPath = path.join(root, SVG_RELATIVE_PATH);
  const currentSvg = fs.readFileSync(svgPath, "utf8");
  assert.match(currentSvg, /\d+ public surfaces/, "social banner SVG must contain the public-surface count marker");
  const svg = currentSvg.replace(/\d+ public surfaces/, `${count} public surfaces`);
  const sourceHash = crypto.createHash("sha256").update(svg).digest("hex");
  return { count, currentSvg, svg, sourceHash, svgPath, pngPath: path.join(root, PNG_RELATIVE_PATH) };
}

export function verifyClientBanner(root = REPO_ROOT) {
  const state = canonicalState(root);
  assert.equal(state.currentSvg, state.svg, "social banner SVG count is not synchronized with integrations.json");
  const chunks = parsePng(fs.readFileSync(state.pngPath));
  const metadata = Object.fromEntries(chunks.map(textEntry).filter(Boolean));
  assert.equal(metadata[COUNT_KEY], String(state.count), "rendered social banner count metadata is stale");
  assert.equal(metadata[SOURCE_HASH_KEY], state.sourceHash, "rendered social banner is not bound to the current SVG source");
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  assert(ihdr && ihdr.length === 13, "rendered social banner is missing IHDR");
  assert.equal(ihdr.readUInt32BE(0), 1280, "rendered social banner width must be 1280");
  assert.equal(ihdr.readUInt32BE(4), 640, "rendered social banner height must be 640");
  return { count: state.count, source_hash: state.sourceHash };
}

async function loadSharp() {
  const explicitModule = process.env.AGORAGENTIC_SHARP_MODULE;
  try {
    const imported = explicitModule
      ? await import(pathToFileURL(path.resolve(explicitModule)).href)
      : await import("sharp");
    return imported.default || imported;
  } catch (error) {
    throw new Error(`Writing the rendered PNG requires sharp. Install it locally or set AGORAGENTIC_SHARP_MODULE. (${error.message})`);
  }
}

async function writeClientBanner(root = REPO_ROOT) {
  const state = canonicalState(root);
  const sharp = await loadSharp();
  const rendered = await sharp(Buffer.from(state.svg, "utf8")).png().toBuffer();
  const stamped = stampPng(rendered, {
    [COUNT_KEY]: String(state.count),
    [SOURCE_HASH_KEY]: state.sourceHash,
  });
  const temporarySvg = `${state.svgPath}.${process.pid}.tmp`;
  const temporaryPng = `${state.pngPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporarySvg, state.svg, "utf8");
    fs.writeFileSync(temporaryPng, stamped);
    fs.renameSync(temporarySvg, state.svgPath);
    fs.renameSync(temporaryPng, state.pngPath);
  } finally {
    fs.rmSync(temporarySvg, { force: true });
    fs.rmSync(temporaryPng, { force: true });
  }
  return verifyClientBanner(root);
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--check") {
    const state = verifyClientBanner();
    console.log(`Client banner is synchronized: ${state.count} surfaces; SVG ${state.source_hash}.`);
    return;
  }
  if (mode === "--write") {
    const state = await writeClientBanner();
    console.log(`Generated client banner for ${state.count} surfaces; SVG ${state.source_hash}.`);
    return;
  }
  throw new Error("Usage: node scripts/generate-client-banner.mjs --check|--write");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
