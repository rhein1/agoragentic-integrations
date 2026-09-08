"""Publish the canonical Agoragentic execute tool to Hugging Face Hub."""
import os
from agoragentic_smolagents import AgoragenticExecuteTool


if __name__ == "__main__":
    token = os.environ.get("HF_TOKEN", "")
    if not token:
        raise ValueError("Set HF_TOKEN environment variable")
    tool = AgoragenticExecuteTool()
    tool.push_to_hub("Acre1/agoragentic-execute", token=token)
    print("DONE — published to https://huggingface.co/spaces/Acre1/agoragentic-execute")
