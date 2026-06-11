#!/usr/bin/env python3
"""
turbovec Integration for Agoragentic.

Maps CPU-local vector storage and search via turbovec (TurboQuant algorithm)
to Agoragentic Memory Mesh context compilation and Micro ECF boundaries.
"""

import os
import json
import time
from typing import Any, Dict, List, Optional

# Attempt to import real turbovec and numpy
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

try:
    from turbovec import TurboQuantIndex
    HAS_TURBOVEC = True
except ImportError:
    HAS_TURBOVEC = False

    # Mock implementation of TurboQuantIndex when not installed
    class TurboQuantIndex:
        def __init__(self, dim: int, bit_width: int = 4):
            self.dim = dim
            self.bit_width = bit_width
            self.vectors = []
            self.ids = []
            self.metadata = []

        def add(self, vectors, ids=None, metadata=None):
            if not HAS_NUMPY:
                # Basic list implementation if numpy is also missing
                for i, v in enumerate(vectors):
                    self.vectors.append(v)
                    self.ids.append(ids[i] if ids is not None else len(self.vectors) - 1)
                    self.metadata.append(metadata[i] if metadata is not None else {})
                return

            vecs = np.array(vectors, dtype=np.float32)
            if len(vecs.shape) == 1:
                vecs = vecs.reshape(1, -1)
            for i, v in enumerate(vecs):
                self.vectors.append(v)
                self.ids.append(ids[i] if ids is not None else len(self.vectors) - 1)
                self.metadata.append(metadata[i] if metadata is not None else {})

        def search(self, query, k: int = 10):
            if not self.vectors:
                return [], []

            if not HAS_NUMPY:
                # Basic fallback if numpy is missing
                # Returns the first k elements with a mock score of 1.0
                return [1.0] * min(k, len(self.vectors)), self.ids[:k]

            q = np.array(query, dtype=np.float32)
            if len(q.shape) == 2:
                q = q[0]
            
            scores = []
            q_norm = np.linalg.norm(q)
            for i, v in enumerate(self.vectors):
                v_norm = np.linalg.norm(v)
                denom = q_norm * v_norm
                sim = float(np.dot(q, v) / denom) if denom > 0 else 0.0
                scores.append((sim, self.ids[i]))
            
            scores.sort(key=lambda x: x[0], reverse=True)
            top_k = scores[:k]
            
            ret_scores = [s[0] for s in top_k]
            ret_indices = [s[1] for s in top_k]
            return ret_scores, ret_indices


class TurbovecMemoryAdapter:
    """
    Adapter for indexing and retrieving Agoragentic memories using a local turbovec index.
    """
    def __init__(self, dim: int = 1536, bit_width: int = 4):
        self.dim = dim
        self.bit_width = bit_width
        self.index = TurboQuantIndex(dim=dim, bit_width=bit_width)
        # Store metadata mappings locally
        self.memory_store = {}

    def index_memory_candidates(self, memories: List[Dict[str, Any]], embeddings: List[List[float]]) -> Dict[str, Any]:
        """
        Ingests memory candidates and their vector embeddings into the turbovec index.
        """
        print(f"[turbovec] Indexing {len(memories)} memory candidates...")
        
        ids = []
        vecs_to_add = []
        
        for i, memory in enumerate(memories):
            mem_id = memory.get("id", f"mem_{int(time.time())}_{i}")
            embedding = embeddings[i]
            
            if len(embedding) != self.dim:
                raise ValueError(f"Embedding dimension mismatch. Expected {self.dim}, got {len(embedding)}")
                
            self.memory_store[mem_id] = memory
            ids.append(i) # turbovec expects integer IDs or indices
            vecs_to_add.append(embedding)
            
            # Map index back to memory_id
            self.memory_store[i] = mem_id

        # Ingest into turbovec (convert to numpy array if numpy is available)
        if HAS_NUMPY:
            self.index.add(np.array(vecs_to_add, dtype=np.float32))
        else:
            self.index.add(vecs_to_add)
        
        return {
            "status": "success",
            "indexed_count": len(memories),
            "compression": f"{self.bit_width}-bit TurboQuant",
            "local_only": True
        }

    def search_memory_index(self, query_vector: List[float], top_k: int = 5) -> Dict[str, Any]:
        """
        Searches the local vector index and returns matching memory records.
        """
        if len(query_vector) != self.dim:
            raise ValueError(f"Query vector dimension mismatch. Expected {self.dim}, got {len(query_vector)}")

        print(f"[turbovec] Querying index (top_k={top_k})...")
        # Query turbovec (convert query vector to a 2D numpy array if numpy is available)
        if HAS_NUMPY:
            q = np.array([query_vector], dtype=np.float32)
            scores, indices = self.index.search(q, k=top_k)
        else:
            scores, indices = self.index.search(query_vector, k=top_k)
            
        # Convert 2D outputs (from real turbovec) to 1D
        if hasattr(scores, 'ndim') and scores.ndim == 2:
            scores = scores[0]
        elif isinstance(scores, list) and len(scores) > 0 and hasattr(scores[0], '__len__') and not isinstance(scores[0], (str, bytes)):
            scores = scores[0]

        if hasattr(indices, 'ndim') and indices.ndim == 2:
            indices = indices[0]
        elif isinstance(indices, list) and len(indices) > 0 and hasattr(indices[0], '__len__') and not isinstance(indices[0], (str, bytes)):
            indices = indices[0]
        
        results = []
        for score, idx in zip(scores, indices):
            mem_id = self.memory_store.get(idx)
            if mem_id and mem_id in self.memory_store:
                memory = self.memory_store[mem_id]
                results.append({
                    "id": mem_id,
                    "score": float(score),
                    "content": memory.get("content"),
                    "category": memory.get("category"),
                    "source": "turbovec_local"
                })

        return {
            "results": results,
            "metadata": {
                "provider": "turbovec",
                "mode": "local_only",
                "has_real_bindings": HAS_TURBOVEC
            }
        }


if __name__ == "__main__":
    print(f"--- turbovec Agoragentic Adapter Test ---")
    print(f"Library installed: {HAS_TURBOVEC}")
    print(f"NumPy available: {HAS_NUMPY}")
    
    # Initialize adapter for 8-dimensional embeddings (for simple testing)
    adapter = TurbovecMemoryAdapter(dim=8, bit_width=4)
    
    # 1. Define sample memory candidates
    memories = [
        {
            "id": "mem_001",
            "content": "Agoragentic is a live production-deployed runtime on Base L2.",
            "category": "platform_status"
        },
        {
            "id": "mem_002",
            "content": "Triptych OS is the client-facing Agent OS for swarms and deployments.",
            "category": "product_concept"
        },
        {
            "id": "mem_003",
            "content": "Consequences Engine governs budget and policy controls.",
            "category": "safety_governance"
        }
    ]
    
    # 2. Define simple distinct vectors for each (padded to 8 dimensions)
    embeddings = [
        [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],  # Vector for platform_status
        [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],  # Vector for product_concept
        [0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]   # Vector for safety_governance
    ]
    
    # 3. Index memories
    index_res = adapter.index_memory_candidates(memories, embeddings)
    print(json.dumps(index_res, indent=2))
    
    # 4. Search index with a query vector close to safety_governance (padded to 8 dimensions)
    query_vector = [0.1, 0.1, 0.9, 0.0, 0.0, 0.0, 0.0, 0.0]
    search_res = adapter.search_memory_index(query_vector, top_k=2)
    print("\nSearch Results:")
    print(json.dumps(search_res, indent=2))
