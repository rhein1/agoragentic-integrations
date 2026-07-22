import path from 'node:path';
import { promises as fs } from 'node:fs';
import { relativeArtifactPath, writeRunArtifact } from '../kernel/state.mjs';

export function createReceiptWriterMiddleware({ createLocalProof, createLocalReceipt, writeJsonArtifact }) {
  return {
    id: 'receipt-writer',
    description: 'Writes run-scoped local proof/receipt artifacts and preserves top-level compatibility artifacts.',
    authority: 'local_no_spend',
    async before_receipt(context) {
      await context.emit({
        type: 'before_receipt',
        severity: 'info',
        summary: 'Local proof and receipt writing started.',
        data: { run_id: context.state.run_id },
      });
      return null;
    },
    async after_receipt(context) {
      const proof = context.proof || createLocalProof(context.project);
      const receipt = context.receipt || createLocalReceipt(context.project, proof);
      context.proof = proof;
      context.receipt = receipt;
      const runProofPath = await writeRunArtifact(context.dir, context.state, 'local-proof.json', proof);
      const runReceiptPath = await writeRunArtifact(context.dir, context.state, 'local-receipt.json', receipt);
      const topProofPath = await writeJsonArtifact(context.dir, 'local-proof.json', proof);
      const topReceiptPath = await writeJsonArtifact(context.dir, 'local-receipt.json', receipt);
      await context.emit({
        type: 'artifact_written',
        severity: 'info',
        summary: 'Run-scoped local proof and receipt written.',
        data: {
          proof_path: relativeArtifactPath(context.dir, runProofPath),
          receipt_path: relativeArtifactPath(context.dir, runReceiptPath),
          compatibility_paths: [
            relativeArtifactPath(context.dir, topProofPath),
            relativeArtifactPath(context.dir, topReceiptPath),
          ],
        },
      });
      await context.emit({
        type: 'after_receipt',
        severity: proof.status === 'blocked' ? 'blocked' : 'info',
        summary: proof.status === 'blocked' ? 'Blocked local receipt recorded.' : 'Local receipt recorded.',
        data: { proof_status: proof.status, receipt_status: receipt.status },
      });
      await fs.access(path.dirname(runProofPath));
      return null;
    },
  };
}
