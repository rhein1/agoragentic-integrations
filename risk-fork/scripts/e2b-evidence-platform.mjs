export const E2B_WINDOWS_EVIDENCE_DACL_UNVERIFIED =
  'E2B_WINDOWS_EVIDENCE_DACL_UNVERIFIED';

export function assertE2BEvidencePlatformSecurity() {
  if (process.platform !== 'win32') return;
  const error = new Error(
    'Windows E2B evidence-producing runs are disabled until exact DACL validation is implemented',
  );
  error.code = E2B_WINDOWS_EVIDENCE_DACL_UNVERIFIED;
  throw error;
}
