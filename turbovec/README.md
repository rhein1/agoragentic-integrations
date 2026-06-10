# turbovec Local Vector Index Integration for Agoragentic

This integration provides a local, memory-efficient vector indexing adapter using [turbovec](https://github.com/RyanCodrai/turbovec), an open-source library built on Google Research's **TurboQuant** algorithm (ICLR 2026). It is designed to run CPU-local vector storage and search for Agoragentic Agent OS deployments, Micro ECF context boundaries, and Memory Mesh candidate databases.

## Status: `beta`

The Python integration is locally runnable and supports offline dry-runs with a mock fallback when the `turbovec` C-bindings/compiled Rust library is not present on the host system.

## What it is and is not

- **What it is**: An adapter utilizing the `turbovec` library to store, compress, and query vector embeddings representing agent memories or document context.
- **What it is NOT**: A cloud-hosted vector database service or a provider of embedding generation. **Embeddings should be generated locally (e.g., using sentence-transformers or local models under local-inference policy) and private vectors remain offline to prevent leakage to external cloud environments.**

## Mappings & Core Concepts

1. **Memory Quantization & Compression**: Enables up to 16x storage reduction, allowing massive datasets of agent memories to fit directly into CPU-local RAM.
2. **Incremental Ingestion (No-Training)**: Utilizes TurboQuant's data-oblivious properties to support immediate online vector ingestion as new agent memories are approved.
3. **Micro ECF Context Boundaries**: Acts as a fast retrieval backend for compiling bounded context slices for Agent OS harness exports.

## How Approvals, Budgets, and Receipts are Handled

- **Local-Only (No-Spend)**: Vector search queries and memory ingestion run entirely locally, meaning they incur zero network cost or marketplace fees.
- **Micro ECF Policy Check**: Before indexing external payloads, the adapter validates the inputs against the local Micro ECF policy to filter out secrets, API keys, or raw private data.
- **Receipt Reconciliation**: The adapter produces local-only, no-spend receipt metadata matching the `agoragentic.context-provenance.v1` schema for compliance tracking.

## Public-Safety Boundary

- **No Secrets**: Never index private credentials, API keys, or raw environment variables in the vector database.
- **No Cloud Upload**: The vector search execution path must remain local-only by default.
- **Mock Fallback**: A NumPy-based approximate matching index is automatically used if the C-compiled `turbovec` library is missing.

## Testing Locally

Run the Python verification script:

```bash
python turbovec/agoragentic_turbovec.py
```

## Example Usage

```python
from turbovec import TurboQuantIndex
import numpy as np

# Create an index for 1536-dimensional embeddings (e.g., OpenAI text-embedding-3-small)
index = TurboQuantIndex(dim=1536, bit_width=4)

# Ingest embeddings
embeddings = np.random.randn(10, 1536).astype(np.float32)
index.add(embeddings)

# Query
query = np.random.randn(1, 1536).astype(np.float32)
scores, indices = index.search(query, k=5)
```
