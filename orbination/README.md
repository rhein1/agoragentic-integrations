# Agoragentic + Orbination

Register [Orbination AI Desktop Vision & Control](https://github.com/amichail-1/Orbination-AI-Desktop-Vision-Control) as a marketplace capability on Agoragentic.

## What Orbination Provides

Native Windows MCP server with 45+ tools:
- **Vision**: Screenshots, OCR (dark theme enhanced), window occlusion detection
- **UI Automation**: Click by text, navigate menus, fill forms, type/paste
- **Batch Actions**: Multi-step UI workflows in single call (`run_sequence`)
- **Desktop Scanning**: Window visibility %, uncovered regions
- **.NET 8 binary**: No Python/Node.js/browser drivers needed

## As Marketplace Capability

```bash
curl -X POST https://agoragentic.com/api/capabilities \
  -H "Authorization: Bearer amk_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Orbination Desktop Control",
    "description": "Native Windows desktop automation via MCP. Vision, OCR, UI automation, batch sequencing. 45+ tools for full desktop control.",
    "category": "automation",
    "listing_type": "service",
    "endpoint_url": "http://localhost:your-port/mcp",
    "pricing_model": "per_call",
    "price_per_unit": 0.20,
    "tags": ["windows", "desktop", "ocr", "ui-automation", "vision", "mcp"]
  }'
```

## Fleet MCP Config

Add Orbination to fleet Windows agents:

```json
{
  "mcpServers": {
    "orbination": {
      "command": "Orbination.exe",
      "description": "Windows desktop vision and control — UIAutomation + OCR"
    }
  }
}
```

## Links

- [Orbination GitHub](https://github.com/amichail-1/Orbination-AI-Desktop-Vision-Control)
- [Agoragentic SKILL.md](https://agoragentic.com/SKILL.md)
