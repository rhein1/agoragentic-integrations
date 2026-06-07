#!/usr/bin/env python3
"""
AWS Strands integration for Agoragentic.

Exposes core functions and middleware hooks for AWS Strands-style agents.
Supports dry-run fallback when AGORAGENTIC_API_KEY is not defined.
"""

import os
import json
import time
from typing import Any, Callable, Dict, List, Optional

# Configuration
AGORAGENTIC_API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")
AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com").rstrip("/")
DRY_RUN = not AGORAGENTIC_API_KEY

def agoragentic_quote(task: str, constraints: Dict[str, Any]) -> Dict[str, Any]:
    """Generates a transaction quote for a task."""
    if DRY_RUN:
        return {
            "quote_id": "q_strands_mock_123",
            "cost_usdc": 0.02,
            "expires_at": int(time.time()) + 600,
            "provider_id": "prov_mock_strands",
            "dry_run": True
        }
    
    # Real network call would go here
    return {"status": "ok"}

def agoragentic_match(task: str, constraints: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Finds matching capability providers for a task."""
    if DRY_RUN:
        return [
            {
                "provider_id": "prov_mock_strands",
                "name": "Mock Strands Provider",
                "cost_usdc": 0.02,
                "trust_score": 1.0,
                "rating": "verified"
            }
        ]
    return []

def agoragentic_execute(task: str, input_data: Dict[str, Any], constraints: Dict[str, Any]) -> Dict[str, Any]:
    """Executes a routed capability call via POST /api/execute."""
    if DRY_RUN:
        return {
            "invocation_id": "inv_strands_mock_456",
            "status": "completed",
            "output": {"result": f"Dry-run executed task: {task}"},
            "dry_run": True
        }
    return {}

def agoragentic_status(invocation_id: str) -> Dict[str, Any]:
    """Retrieves status for an execution."""
    if DRY_RUN:
        return {
            "invocation_id": invocation_id,
            "status": "completed",
            "progress": 100,
            "dry_run": True
        }
    return {}

def agoragentic_receipt(invocation_id: str) -> Dict[str, Any]:
    """Fetches normalized receipt and settlement metadata."""
    if DRY_RUN:
        return {
            "receipt_id": "rec_strands_mock_789",
            "invocation_id": invocation_id,
            "cost_usdc": 0.02,
            "settled_at": int(time.time()),
            "status": "settled",
            "dry_run": True
        }
    return {}


# Strands Middleware & Hook Concept
class StrandsAgentHooks:
    def __init__(self):
        self.pre_execute_hooks: List[Callable[[Dict[str, Any]], Dict[str, Any]]] = []
        self.post_execute_hooks: List[Callable[[Dict[str, Any]], Dict[str, Any]]] = []

    def register_pre_execute(self, hook: Callable[[Dict[str, Any]], Dict[str, Any]]):
        self.pre_execute_hooks.append(hook)

    def register_post_execute(self, hook: Callable[[Dict[str, Any]], Dict[str, Any]]):
        self.post_execute_hooks.append(hook)

    def run_agent_loop(self, task: str, input_data: Dict[str, Any], constraints: Dict[str, Any]) -> Dict[str, Any]:
        """Runs the execution cycle wrapping the hooks and middleware."""
        context = {
            "task": task,
            "input": input_data,
            "constraints": constraints,
            "telemetry": {},
            "status": "pending"
        }

        # 1. Budget preflight & approval gates (Pre-execute hooks)
        for hook in self.pre_execute_hooks:
            context = hook(context)
            if context.get("aborted"):
                return {
                    "status": "aborted",
                    "reason": context.get("abort_reason", "Preflight hook aborted execution.")
                }

        # 2. execute(task, input, constraints)
        print(f"[Strands] Dispatching routed execute: {task}")
        res = agoragentic_execute(context["task"], context["input"], context["constraints"])
        context["invocation"] = res
        context["status"] = res.get("status", "unknown")

        # 3. Post-execute hooks (receipt capture & telemetry mapping)
        for hook in self.post_execute_hooks:
            context = hook(context)

        return context


# Example hook implementations
def budget_preflight_hook(context: Dict[str, Any]) -> Dict[str, Any]:
    """Middleware validating task cost before execution."""
    constraints = context.get("constraints", {})
    max_cost = constraints.get("max_cost_usdc", 0.0)
    
    # Pre-flight quote call
    quote = agoragentic_quote(context["task"], constraints)
    estimated_cost = quote.get("cost_usdc", 0.0)
    
    print(f"[Strands Middleware] Budget preflight: Estimated cost = {estimated_cost} USDC, Max allowed = {max_cost} USDC")
    if estimated_cost > max_cost:
        context["aborted"] = True
        context["abort_reason"] = f"Budget exceeded: Estimate {estimated_cost} USDC > Max {max_cost} USDC"
    else:
        context["telemetry"]["budget_verified"] = True
        context["telemetry"]["estimated_cost"] = estimated_cost
    return context

def receipt_capture_hook(context: Dict[str, Any]) -> Dict[str, Any]:
    """Middleware extracting and archiving execution receipt metadata."""
    invocation = context.get("invocation", {})
    invocation_id = invocation.get("invocation_id")
    
    if invocation_id:
        receipt = agoragentic_receipt(invocation_id)
        context["receipt"] = receipt
        context["telemetry"]["receipt_id"] = receipt.get("receipt_id")
        context["telemetry"]["final_cost"] = receipt.get("cost_usdc")
        print(f"[Strands Middleware] Receipt captured: {receipt.get('receipt_id')} - cost {receipt.get('cost_usdc')} USDC")
    return context


if __name__ == "__main__":
    # Test adapter
    hooks_engine = StrandsAgentHooks()
    hooks_engine.register_pre_execute(budget_preflight_hook)
    hooks_engine.register_post_execute(receipt_capture_hook)

    # 1. Test successful loop under budget
    print("--- Test Run 1 (Under Budget) ---")
    run_context = hooks_engine.run_agent_loop(
        task="Translate 'Hello'", 
        input_data={"text": "Hello"}, 
        constraints={"max_cost_usdc": 0.10}
    )
    print("Result status:", run_context["status"])

    # 2. Test aborted loop over budget
    print("\n--- Test Run 2 (Over Budget) ---")
    run_context_aborted = hooks_engine.run_agent_loop(
        task="Translate 'Hello'", 
        input_data={"text": "Hello"}, 
        constraints={"max_cost_usdc": 0.01} # Lower than estimate
    )
    print("Result status:", run_context_aborted["status"])
    print("Abort reason:", run_context_aborted.get("reason"))
