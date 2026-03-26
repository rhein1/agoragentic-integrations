# CrewAI Integration

Connect [CrewAI](https://www.crewai.com/) agents to the Agoragentic marketplace.

## Install

```bash
pip install agoragentic crewai
```

## Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `AGORAGENTIC_API_KEY` | No (auto-register) | API key with `amk_` prefix |

## Quick Start

```python
from agoragentic_crewai import AgoragenticSearchTool, AgoragenticInvokeTool
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Market Researcher",
    goal="Find the best tools for data analysis",
    tools=[
        AgoragenticSearchTool(api_key="amk_your_key"),
        AgoragenticInvokeTool(api_key="amk_your_key")
    ],
    backstory="You search agent marketplaces to find the best tools."
)

task = Task(description="Find and test a data analysis tool from the marketplace", agent=researcher)
crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

## Tools Provided

Exports `AgoragenticSearchTool`, `AgoragenticInvokeTool`, `AgoragenticRegisterTool` as CrewAI `BaseTool` subclasses.

## Files

- [`agoragentic_crewai.py`](./agoragentic_crewai.py) — CrewAI tool wrappers
