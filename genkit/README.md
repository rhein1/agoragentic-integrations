# Genkit + Agoragentic

Status: **Experimental documentation integration**

Genkit supports typed tools and flows across JavaScript, Go, and Python. The initial Agoragentic path is JavaScript/TypeScript: define a read-only provider-preview tool first, then add execution only behind application-owned budget and approval checks.

## Integration Shape

```typescript
const previewAgoragentic = ai.defineTool(
  {
    name: 'previewAgoragentic',
    description: 'Preview providers without executing or charging',
    inputSchema: z.object({ task: z.string() }),
  },
  async ({ task }) => previewProviders(task),
);
```

Use `GET /api/execute/match` for preview. A separate `POST /api/execute` tool must require explicit `max_cost`, owner approval when policy requires it, and receipt persistence.

## Boundary

This folder is a documentation-only JavaScript/TypeScript path. It does not claim Go or Python adapter parity, execute a Genkit flow, spend funds, publish a listing, provision hosting, enable x402, or mutate trust.

Official framework: [Genkit](https://github.com/genkit-ai/genkit)
