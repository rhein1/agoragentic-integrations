#!/usr/bin/env python3
"""
AWS Bedrock AgentCore Adapter for Agoragentic.

This adapter demonstrates how to connect an AWS Bedrock AgentCore-style runtime 
or custom Bedrock Action Group to Agoragentic's routed execution platform.
It maps AgentCore invocations, policy constraints, and observation logs 
into Agoragentic execute requests, budget limits, and x402 receipts.
"""

import os
import json
import urllib.request
import urllib.error
from typing import Any, Dict, Optional, Tuple

# Configuration
AGORAGENTIC_API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")
AGORAGENTIC_BASE_URL = os.environ.get("AGORAGENTIC_BASE_URL", "https://agoragentic.com").rstrip("/")

class AgentCoreAgoragenticAdapter:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run or not AGORAGENTIC_API_KEY
        if self.dry_run:
            print("[AgentCore-Agoragentic] API key missing or dry_run enabled. Running in offline dry-run mode.")

    def translate_limits_and_policies(self, agent_core_session: Dict[str, Any]) -> Dict[str, Any]:
        """
        Maps Bedrock AgentCore session parameters and spend controls to Agoragentic constraints.
        """
        # Read Bedrock spend limits or constraints if present
        bedrock_limits = agent_core_session.get("spend_controls", {})
        
        # Translate to Agoragentic constraints
        constraints = {
            "max_cost_usdc": float(bedrock_limits.get("maxCostUsd", 0.50)),
            "timeout_ms": int(bedrock_limits.get("timeoutMs", 30000)),
            "approval_mode": "supervised" if bedrock_limits.get("requireApproval", True) else "automatic"
        }
        return constraints

    def execute_bedrock_action(
        self, 
        action_group: str, 
        function_name: str, 
        parameters: Dict[str, Any], 
        session_attributes: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Translates a Bedrock AgentCore Gateway/Action Group tool execution request
        into an Agoragentic execute request, performing routing, payment challenge,
        and receipt collection.
        """
        task = f"Execute function {function_name} in action group {action_group}"
        inputs = parameters
        constraints = self.translate_limits_and_policies(session_attributes)

        if self.dry_run:
            return self._mock_dry_run_response(task, inputs, constraints)

        # 1. Dispatch routed execute request to Agoragentic
        try:
            payload = {
                "task": task,
                "input": inputs,
                "constraints": constraints
            }
            
            req = urllib.request.Request(
                f"{AGORAGENTIC_BASE_URL}/api/execute",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {AGORAGENTIC_API_KEY}"
                },
                method="POST"
            )
            
            with urllib.request.urlopen(req, timeout=15) as res:
                response_data = json.loads(res.read().decode("utf-8"))
                
            # Parse response and extract observability metadata
            invocation_id = response_data.get("invocation_id")
            status = response_data.get("status")
            
            # 2. Extract x402 challenge handling if payment is required
            if status == "payment_required" or "x402_challenge" in response_data:
                # In a live agent client, we would settle the USDC payment on Base L2 here.
                # In this public-safe example, we simulate x402 metadata capture:
                challenge = response_data.get("x402_challenge", {})
                print(f"[AgentCore-Agoragentic] x402 Challenge Received: {challenge.get('challenge_id')}")
                # We return the challenge details to the Bedrock AgentCore orchestrator to prompt user wallet approval.
                return {
                    "statusCode": 402,
                    "body": {
                        "message": "Payment challenge required.",
                        "x402_challenge_id": challenge.get("challenge_id"),
                        "amount_usdc": challenge.get("amount_usdc"),
                        "settlement_address": challenge.get("settlement_address")
                    }
                }
                
            # 3. Normalise success response for Bedrock observation
            receipt = response_data.get("receipt", {})
            return {
                "statusCode": 200,
                "body": {
                    "output": response_data.get("output"),
                    "observability": {
                        "invocation_id": invocation_id,
                        "receipt_id": receipt.get("receipt_id"),
                        "cost_usdc": receipt.get("cost_usdc", 0.0),
                        "status": status
                    }
                }
            }

        except urllib.error.HTTPError as err:
            error_data = {}
            try:
                error_data = json.loads(err.read().decode("utf-8"))
            except Exception:
                pass
            
            # Avoid exposing private stack traces; return public-safe error summary
            return {
                "statusCode": err.code,
                "body": {
                    "error": "AGORAGENTIC_EXECUTION_FAILED",
                    "message": error_data.get("message", "An error occurred during marketplace execution."),
                    "code": error_data.get("code", "UNKNOWN_ERROR")
                }
            }
        except Exception as err:
            return {
                "statusCode": 500,
                "body": {
                    "error": "ADAPTER_INTERNAL_ERROR",
                    "message": str(err)
                }
            }

    def _mock_dry_run_response(self, task: str, inputs: Dict[str, Any], constraints: Dict[str, Any]) -> Dict[str, Any]:
        """
        Generates a mock response for offline testing without hitting live endpoints.
        """
        print(f"[AgentCore-Agoragentic] Offline Mock Execution for: {task}")
        return {
            "statusCode": 200,
            "body": {
                "output": {
                    "message": "Offline dry-run complete.",
                    "task_reflected": task,
                    "inputs_received": inputs,
                },
                "observability": {
                    "invocation_id": "inv_mock_bedrock_12345",
                    "receipt_id": "rec_mock_bedrock_67890",
                    "cost_usdc": 0.01,
                    "status": "completed",
                    "dry_run": True
                }
            }
        }


# Quick run check
if __name__ == "__main__":
    adapter = AgentCoreAgoragenticAdapter(dry_run=True)
    sample_session = {
        "spend_controls": {
            "maxCostUsd": 0.25,
            "timeoutMs": 15000,
            "requireApproval": True
        }
    }
    sample_params = {"text": "hello from bedrock"}
    result = adapter.execute_bedrock_action("TranslatorGroup", "TranslateText", sample_params, sample_session)
    print(json.dumps(result, indent=2))
