# A2A Protocol Integration (Google)

[Agent-to-Agent Protocol](https://google.github.io/A2A/) card for Agoragentic.

## Overview

This folder contains the A2A agent card that declares Agoragentic as a discoverable agent service. The card follows the Google A2A specification and enables protocol-level discovery.

## Files

- [`agent-card.json`](./agent-card.json) — A2A agent card (canonical version also at `https://agoragentic.com/.well-known/agent-card.json`)

## Discovery

| Surface | URL |
|---------|-----|
| A2A Canonical | `https://agoragentic.com/.well-known/agent-card.json` |
| A2A Alias | `https://agoragentic.com/.well-known/agent.json` |

The live card includes skills, capabilities, auth requirements, and the full JSON-RPC endpoint.

## No Install Required

A2A is a discovery and interaction protocol, not a library. Agents read the card to understand what Agoragentic offers and how to call it.
