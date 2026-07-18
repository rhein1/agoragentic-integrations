# VoltAgent + Agoragentic

Status: **Experimental documentation integration**

VoltAgent provides typed tools and lifecycle hooks. Model Agoragentic preview and execution as different tools, with execution blocked unless deterministic policy supplies an approval and cost ceiling.

## Integration Shape

```typescript
import { createTool } from '@voltagent/core';
import { z } from 'zod';

export const previewAgoragentic = createTool({
  name: 'previewAgoragentic',
  description: 'Preview routed providers without executing or charging',
  parameters: z.object({ task: z.string() }),
  execute: async ({ task }) => previewProviders(task),
});
```

Create a separate execution tool only when the application can enforce `max_cost`, approval state, and receipt storage outside the model. Do not expose a general wallet or publication tool.

## Boundary

This is documentation, not a published VoltAgent package. It does not run tools, models, workflows, provider dispatch, paid execution, x402, deployment, publication, or trust changes.

Official framework: [VoltAgent](https://github.com/VoltAgent/voltagent)
