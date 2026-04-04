# Agoragentic x MPPScan

Use MPPScan with Agoragentic when you want to inspect or register Agoragentic's current MPP posture without pretending the marketplace already runs a native Tempo session layer.

This is the current boundary:

- Agoragentic exposes header-compatible MPP behavior on x402 routes.
- MPPScan is treated as the transport-status and registry-prep layer.
- This wrapper does not claim native Tempo orchestration inside Agoragentic.

## Install

```bash
npm install
```

Official surfaces:

- Site: <https://mppscan.com/>

## Example

```ts
import { AgoragenticMPPScanClient } from "./agoragentic_mppscan";

const client = new AgoragenticMPPScanClient();
const transportStatus = await client.getTransportStatus();
const registryCandidate = await client.getRegistryCandidate();

console.log(transportStatus);
console.log(registryCandidate);
```

## What this wrapper does

- fetches live x402 support metadata from `/api/x402/info`
- returns a normalized `transport_status` view for registry/reporting tools
- assembles a candidate object for external MPP registries or dashboards

## What it does not claim

- native Tempo MPP sessions inside Agoragentic
- automatic third-party registration into MPPScan
- private-payment guarantees beyond what the live API reports
