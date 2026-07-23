import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorityBoundary } from './events.mjs';

export const PROFILE_SCHEMA = 'agoragentic.harness.profile.v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');
const profilesRoot = path.join(packageRoot, 'profiles');

export async function listProfiles() {
  const files = (await fs.readdir(profilesRoot)).filter((file) => file.endsWith('.json')).sort();
  const profiles = [];
  for (const file of files) {
    const profile = await loadProfile(file.replace(/\.json$/, ''));
    profiles.push(profileSummary(profile));
  }
  return profiles;
}

export async function loadProfile(id = 'local_no_spend') {
  const safeId = normalizeProfileId(id);
  const profilePath = path.join(profilesRoot, `${safeId}.json`);
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  validateProfile(profile);
  return profile;
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('profile must be an object');
  if (profile.schema !== PROFILE_SCHEMA) throw new Error(`profile schema must be ${PROFILE_SCHEMA}`);
  if (!profile.id) throw new Error('profile.id is required');
  if (!Array.isArray(profile.middleware)) throw new Error('profile.middleware must be an array');
  const boundary = profile.authority_boundary || {};
  for (const [key, expected] of Object.entries(authorityBoundary())) {
    if (typeof expected === 'boolean' && boundary[key] !== false) {
      throw new Error(`profile ${profile.id} must keep authority_boundary.${key} false`);
    }
  }
  return true;
}

function profileSummary(profile) {
  return {
    id: profile.id,
    description: profile.description,
    middleware: [...profile.middleware],
    default_artifacts: [...(profile.default_artifacts || [])],
    blocked_actions: [...(profile.blocked_actions || [])],
    required_approval_classes: [...(profile.required_approval_classes || [])],
    authority_boundary: profile.authority_boundary,
  };
}

function normalizeProfileId(id) {
  const safe = String(id || 'local_no_spend').trim();
  if (!/^[a-z0-9_-]+$/i.test(safe)) throw new Error(`invalid profile id: ${id}`);
  return safe;
}
