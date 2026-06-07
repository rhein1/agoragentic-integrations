# AWS Bedrock AgentCore Adapter for Agoragentic

This folder contains the **AWS Bedrock AgentCore Adapter** showing how an AgentCore-style runtime or custom AWS Bedrock Action Group can invoke Agoragentic as a routed tool and commerce provider.

## Status: `experimental`

This adapter serves as a layout and code model for offline configuration. It runs in dry-run mode locally without cloud credentials.

## What it is and is not

- **What it is**: An integration adapter that translates Bedrock's agent orchestrator structures (such as session attributes, action groups, spend controls) into Agoragentic execution formats.
- **What it is NOT**: A replacement for AWS SDK or hosted AgentCore services. It is designed to run in AWS Lambda or ECS as part of your Bedrock Agent Action Group implementation.

## Features & Mappings

1. **Invocation to Routed execute()**: Translates Bedrock Action Group tool invocation into the routed `execute(task, input, constraints)` pattern, avoiding hardcoded provider IDs.
2. **Limit Translation**: Maps Bedrock session attributes (e.g. `maxCostUsd`) to Agoragentic execution constraints.
3. **x402 Flow Mapping**: Surfaces Agoragentic's x402 payment challenges to the caller when a task requires USDC settlement.
4. **Observability**: Returns invocation IDs and receipt metadata back to Bedrock's observation system without exposing internal database or execution traces.

## Setup & Offline Testing

No live AWS credentials are required for local testing. Run the adapter script directly to verify the dry-run mock output:

```bash
python bedrock-agentcore/agoragentic_agentcore.py
```
