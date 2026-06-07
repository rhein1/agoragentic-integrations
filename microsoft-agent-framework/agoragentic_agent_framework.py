#!/usr/bin/env python3
"""
Microsoft Agent Framework Integration for Agoragentic.

This adapter integrates Agoragentic capabilities into the Microsoft Agent 
Framework abstraction. It registers Agoragentic as a tool provider, 
defines a custom workflow step, maps Human-in-the-loop (HITL) checkpoints, 
and attaches x402 payment receipts as execution step artifacts.
"""

import os
import json
import uuid
from typing import Any, Dict, List, Optional

# Configuration
AGORAGENTIC_API_KEY = os.environ.get("AGORAGENTIC_API_KEY", "")
DRY_RUN = not AGORAGENTIC_API_KEY

class MicrosoftAgentFrameworkAdapter:
    def __init__(self, agent_name: str = "AgoragenticBridgeAgent"):
        self.agent_name = agent_name
        self.registered_tools = []
        self._initialize_framework_bindings()

    def _initialize_framework_bindings(self):
        """Registers the core Agoragentic tools within the Microsoft Agent Framework tool schema."""
        self.registered_tools.append({
            "name": "agoragentic_execute",
            "description": "Primary execute route. Dispatches task to Agoragentic routed commerce catalog.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "description": "The task query to match and execute"},
                    "input_data": {"type": "object", "description": "Input payload for the capability"},
                    "max_cost_usdc": {"type": "number", "description": "Max USDC budget cap"}
                },
                "required": ["task"]
            }
        })

    def as_tool_provider(self) -> List[Dict[str, Any]]:
        """Returns the tool definitions to be registered in the Microsoft Agent orchestrator."""
        return self.registered_tools

    def run_workflow_step(self, step_context: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes a single step in a Microsoft Agent Framework workflow graph.
        Maps the step execution to an Agoragentic execute call and produces
        step result artifacts including the x402 receipt.
        """
        task = step_context.get("step_name", "Workflow execution task")
        inputs = step_context.get("inputs", {})
        budget = step_context.get("max_cost_usdc", 0.50)

        print(f"[{self.agent_name}] Running workflow step: {task}")
        
        # 1. Budget preflight checkpoint
        if budget <= 0.0:
            return {
                "step_status": "Failed",
                "error": "INVALID_BUDGET",
                "message": "Step budget must be greater than zero."
            }

        # 2. Execute step
        if DRY_RUN:
            output_data = {"result": f"Microsoft Agent step executed successfully via dry-run: {task}"}
            receipt = {
                "receipt_id": f"rec_ms_mock_{uuid.uuid4().hex[:6]}",
                "cost_usdc": 0.05,
                "status": "settled",
                "dry_run": True
            }
        else:
            # Live POST /api/execute network dispatch would go here.
            # Returning mock representation for public-safe demo.
            output_data = {"result": "Live execution omitted in dry-run mode."}
            receipt = {"receipt_id": "rec_live_omitted", "cost_usdc": 0.0, "status": "completed"}

        # 3. Formulate workflow step result (including receipt artifact)
        step_result = {
            "step_id": step_context.get("step_id", str(uuid.uuid4())),
            "step_status": "Completed",
            "outputs": output_data,
            "artifacts": {
                "type": "agoragentic:receipt",
                "receipt_id": receipt.get("receipt_id"),
                "cost_usdc": receipt.get("cost_usdc"),
                "settled": receipt.get("status") == "settled"
            }
        }
        return step_result

    def check_human_in_the_loop_gate(self, approval_id: str, threshold_usdc: float, current_cost_usdc: float) -> str:
        """
        Handles Microsoft Agent Framework HITL checkpoints. 
        Gates execution if the quote exceeds the local automatic spend threshold.
        """
        print(f"[{self.agent_name}] Evaluating HITL Gate. Threshold: {threshold_usdc} USDC, Cost: {current_cost_usdc} USDC")
        if current_cost_usdc > threshold_usdc:
            # Suspend step and await human approval signal
            print(f"[{self.agent_name}] HITL checkpoint required for approval: {approval_id}")
            return "Suspended_Awaiting_Approval"
        
        return "Approved_Auto"


if __name__ == "__main__":
    adapter = MicrosoftAgentFrameworkAdapter()
    
    # 1. Inspect tool schema
    print("--- Tool Schema Definitions ---")
    print(json.dumps(adapter.as_tool_provider(), indent=2))
    
    # 2. Run workflow step
    print("\n--- Running Workflow Step ---")
    sample_context = {
        "step_id": "step_translate_01",
        "step_name": "Translate English text to French",
        "inputs": {"text": "Hello, world"},
        "max_cost_usdc": 0.20
    }
    workflow_result = adapter.run_workflow_step(sample_context)
    print(json.dumps(workflow_result, indent=2))
    
    # 3. Check HITL gate
    print("\n--- HITL Gate Check ---")
    gate_status = adapter.check_human_in_the_loop_gate("appr_ms_9921", 0.10, 0.25)
    print("Gate status:", gate_status)
