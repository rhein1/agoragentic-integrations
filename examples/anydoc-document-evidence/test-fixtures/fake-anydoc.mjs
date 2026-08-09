import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';

function marker(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

export function formatFromBytes(bytes) {
  return Buffer.from(bytes).subarray(0, 4).toString('utf8') === 'PK\u0003\u0004' ? 'docx' : null;
}

export function formatFromPath(path) {
  return path.endsWith('.csv') ? 'csv' : null;
}

export async function toMarkdownBytes(bytes, format) {
  const value = marker(bytes);
  if (value === 'UNSUPPORTED') {
    throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  }
  if (value === 'HANG') return new Promise(() => {});
  if (value === 'NETWORK_FETCH') {
    await fetch('http://127.0.0.1:9/blocked');
  }
  if (value.startsWith('NETWORK_HTTP:')) {
    const port = Number(value.slice('NETWORK_HTTP:'.length));
    await new Promise((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port, path: '/' }, resolve);
      outgoing.once('error', reject);
      outgoing.end();
    });
  }
  if (value === 'NETWORK_LISTEN') {
    createServer().listen(0, '127.0.0.1');
  }
  if (value === 'WRITE_FILE') {
    await writeFile(new URL('./forbidden-output.tmp', import.meta.url), 'blocked', 'utf8');
  }
  if (value === 'SPAWN_CHILD') {
    const child = spawnSync(process.execPath, ['--version']);
    if (child.error) throw child.error;
  }
  if (value === 'LONG') return `${'A'.repeat(600)}\n\n${'B'.repeat(600)}\n\n${'C'.repeat(600)}FINAL_MARKER`;
  if (value === 'COVERAGE_CAPACITY') return 'X'.repeat(1_000);
  if (value === 'ENV_CHECK') {
    return process.env.AGORAGENTIC_API_KEY ? '# SECRET_PRESENT' : '# SECRET_ABSENT';
  }
  if (format === 'csv') return '# Sheet\n\n| name | value |\n| --- | --- |\n| alpha | 1 |';
  if (format === 'docx') return '# Report\n\nSafe paragraph.';
  return '# Parsed';
}

export async function toDocument(bytes, format) {
  const value = marker(bytes);
  if (value === 'STRUCTURE_FAIL') {
    throw Object.assign(new Error('structure failed'), { code: 'resourceLimit' });
  }
  if (value === 'TRAVERSAL') {
    return {
      blocks: Array.from({ length: 20 }, () => ({ kind: 'paragraph', blocks: [] })),
      notes: [],
      assets: [],
    };
  }
  if (format === 'csv') {
    return {
      blocks: [{
        kind: 'table',
        table: {
          grid: [[{ kind: 'origin', cell: { blocks: [], rowSpan: 1, colSpan: 1 } }]],
        },
      }],
      notes: [],
      assets: [],
    };
  }
  return {
    blocks: [{ kind: 'heading', content: [] }, { kind: 'paragraph', content: [] }],
    notes: [],
    assets: [{ data: Buffer.from('image'), mediaType: 'image/png' }],
  };
}
