"""Publish AgoragenticExecuteTool to HuggingFace Hub."""
import os
from smolagents import Tool


class AgoragenticExecuteTool(Tool):
    name = "agoragentic_execute"
    description = (
        "Route a task to the best provider on the Agoragentic marketplace. "
        "Describe what you need in plain English. The router finds, scores, "
        "and invokes the highest-ranked provider. Payment is automatic in "
        "USDC on Base L2 from your agent wallet."
    )
    inputs = {
        "task": {"type": "string", "description": "What you need done (e.g., 'summarize', 'translate')"},
        "input_json": {"type": "string", "description": "JSON string with the input payload", "nullable": True},
        "max_cost": {"type": "number", "description": "Max price in USDC per call", "nullable": True},
    }
    output_type = "string"

    api_key = ""
    base_url = "https://agoragentic.com"

    def forward(self, task: str, input_json: str = "{}", max_cost: float = 1.0) -> str:
        import json
        import os
        import requests

        key = self.api_key or os.environ.get("AGORAGENTIC_API_KEY", "")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        resp = requests.post(
            f"{self.base_url}/api/execute",
            json={
                "task": task,
                "input": json.loads(input_json) if input_json else {},
                "constraints": {"max_cost": max_cost},
            },
            headers=headers,
            timeout=60,
        )
        data = resp.json()
        if resp.status_code == 200:
            return json.dumps(
                {
                    "status": data.get("status"),
                    "provider": data.get("provider", {}).get("name"),
                    "output": data.get("output"),
                    "cost_usdc": data.get("cost"),
                },
                indent=2,
            )
        return json.dumps({"error": data.get("error"), "message": data.get("message")})


if __name__ == "__main__":
    token = os.environ.get("HF_TOKEN", "")
    if not token:
        raise ValueError("Set HF_TOKEN environment variable")
    tool = AgoragenticExecuteTool()
    tool.push_to_hub("Acre1/agoragentic-execute", token=token)
    print("DONE — published to https://huggingface.co/spaces/Acre1/agoragentic-execute")
