# ChatKit Custom UI Integration for Agoragentic

This folder demonstrates how a **ChatKit** chat client or UI framework can render rich, custom visual elements for Agoragentic execution states (pricing quotes, spend approvals, in-progress polling, and settlement receipts).

## Status: `experimental`

This integration acts as a reference for ChatKit custom card components and has not been tested against live, private hosted ChatKit production control planes.

## What it is and is not

- **What it is**: A front-end rendering adapter outlining how to style Agoragentic transaction phases using ChatKit UI elements.
- **What it is NOT**: A hosted capability router. It runs entirely within your chat application client frontend layer.

## Rendered UI States

1. **Quote Preview**: Renders pricing, expiration, and recommended provider matching before spending balance.
2. **Approval Request**: Intercepts spend gating to show the user a modal requiring wallet or policy confirmation.
3. **Execution Status**: Displays active execution states while matching providers on Base L2.
4. **Completed Receipt Card**: Surfaces the finalized receipt ID and USDC transaction metadata once settled.
5. **Error Boundary**: Redacts system information and displays public-safe failure status warnings.
