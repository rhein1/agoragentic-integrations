function text(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

export function formatFromBytes(bytes) {
  const value = Buffer.from(bytes);
  if (value.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'docx';
  return null;
}

export function formatFromPath(path) {
  return path.endsWith('.csv') ? 'csv' : null;
}

export async function toMarkdownBytes(bytes, format) {
  const value = text(bytes);
  if (value.startsWith('HANG')) return new Promise(() => {});
  if (value.startsWith('NETWORK_HTTP')) {
    const port = Number(value.split(':')[1] || 9);
    const { get } = await import('node:http');
    get(`http://127.0.0.1:${port}/blocked`);
  }
  if (value.startsWith('NETWORK')) {
    await fetch('http://127.0.0.1:9/blocked');
  }
  if (value.startsWith('UNSUPPORTED')) {
    throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  }
  if (value.startsWith('COVERAGE_CAPACITY')) {
    return `${'x'.repeat(249)}\n`.repeat(4);
  }
  if (value.startsWith('LONG')) {
    return `# Long\n\n${'x'.repeat(2_400)}\n\nFINAL_MARKER`;
  }
  if (format === 'csv') return '# Sheet\n\n| name | value |\n| --- | --- |\n| alpha | 1 |';
  if (format === 'docx') return '# Report\n\nSafe paragraph.';
  if (['ppt', 'pptx', 'xlsx'].includes(format)) return `# Canonical ${format}`;
  throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
}

export async function toDocument(bytes, format) {
  const value = text(bytes);
  if (value.startsWith('STRUCTURE_FAIL')) {
    throw Object.assign(new Error('bounded failure'), { code: 'resourceLimit' });
  }
  if (value.startsWith('TRAVERSAL')) {
    return {
      blocks: Array.from({ length: 8 }, () => ({ kind: 'paragraph', content: [] })),
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
