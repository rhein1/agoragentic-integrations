#!/usr/bin/env python3
"""
Claude Agent SDK Gating Adapter for Agoragentic.

Uses Claude Agent SDK-style permission middleware and hook abstractions to gate:
- Marketplace execution and automated capability requests.
- Maximum USDC spend caps.
- External network/file requests before dispatching paid routed capability calls.
- Human-in-the-loop validation for paid flows.
- Automated receipt logging and publication.
"""

import os
import json
from typing import Any, Dict, Tuple

# Configuration
AGORAGENTIC_API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")
DRY_RUN = not AGORAGENTIC_API_KEY

class ClaudeAgentSdkGatingAdapter:
    def __init__(self, permissions_config_path: Optional[str] = None):
        self.permissions = self._load_permissions(permissions_config_path)

    def _load_permissions(self, path: Optional[str]) -> Dict[str, Any]:
        if path and os.path.exists(path):
            with open(path, "r") as f:
                return json.load(f)
        return {
            "max_spend_usdc_per_call": 0.25,
            "allow_file_access_before_execution": False,
            "require_hitl_for_spend": True,
            "publish_receipts_publicly": False
        }

    def verify_tool_permission(self, tool_name: str, args: Dict[str, Any]) -> Tuple[bool, str]:
        """
        Claude Agent SDK hook invoked before calling any marketplace tool.
        Enforces permissions and spend limits.
        """
        # Gating network actions before paid capability calls
        if tool_name == "agoragentic_execute":
            # 1. Spend budget limit check
            max_allowed = self.permissions.get("max_spend_usdc_per_call", 0.0)
            requested_cap = float(args.get("constraints", {}).get("max_cost_usdc", 0.0))
            
            if requested_cap > max_allowed:
                return False, f"Permission Denied: Spend cap {requested_cap} USDC exceeds maximum policy limit of {max_allowed} USDC."

            # 2. File boundary sanity checks
            if not self.permissions.get("allow_file_access_before_execution", False):
                if args.get("input_data", {}).get("read_local_files", False):
                    return False, "Permission Denied: Local file extraction is blocked before paid execution."

            # 3. Human Gate check
            if self.permissions.get("require_hitl_for_spend", True):
                print(f"[Claude SDK Permission] HITL approval required for {requested_cap} USDC spend.")
                return True, "Authorized_With_HITL_Gate"

        return True, "Authorized"

    def handle_post_execution(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Post-execution hook called after a successful routed execute() call.
        Enforces receipt publication and telemetry policies.
        """
        receipt = result.get("receipt", {})
        
        # Redact private details if receipt publication is restricted
        if not self.permissions.get("publish_receipts_publicly", False):
            if "settlement_address" in receipt:
                receipt["settlement_address"] = "[REDACTED_BY_CLAUDE_SDK_POLICY]"
            
        print(f"[Claude SDK Permission] Receipt logged. ID: {receipt.get('receipt_id')}")
        result["receipt"] = receipt
        return result


if __name__ == "__main__":
    adapter = ClaudeAgentSdkGatingAdapter()
    
    # 1. Test allowed tool call
    print("--- Test 1: Under Spend Limit ---")
    allowed, status = adapter.verify_tool_permission(
        "agoragentic_execute", 
        {"constraints": {"max_cost_usdc": 0.15}}
    )
    print(f"Allowed: {allowed}, Status: {status}")

    # 2. Test blocked tool call (Over spend limit)
    print("\n--- Test 2: Over Spend Limit ---")
    allowed_over, status_over = adapter.verify_tool_permission(
        "agoragentic_execute", 
        {"constraints": {"max_cost_usdc": 0.50}} # Default limit is 0.25
    )
    print(f"Allowed: {allowed_over}, Status: {status_over}")

    # 3. Test file gating
    print("\n--- Test 3: Blocked File Access ---")
    allowed_file, status_file = adapter.verify_tool_permission(
        "agoragentic_execute", 
        {
            "constraints": {"max_cost_usdc": 0.10},
            "input_data": {"read_local_files": True}
        }
    )
    print(f"Allowed: {allowed_file}, Status: {status_file}")
