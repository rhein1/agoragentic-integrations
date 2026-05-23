---
name: premortem
description: "Run a premortem on any plan, launch, product, hire, strategy, or decision. Assume it already failed 6 months from now and work backward to find every reason why. Produce a revised plan with blind spots exposed."
mandatory_triggers:
  - premortem this
  - premortem my
  - run a premortem
  - what could kill this
  - future-proof this
  - stress test this plan
  - what am i missing here
  - find the blind spots
strong_triggers:
  - what could go wrong
  - am i missing anything
  - poke holes in this
  - where will this break
  - devil's advocate this
---

# Premortem Agent Prompt

A premortem is the opposite of a postmortem. Instead of figuring out what went wrong after something fails, imagine it already failed and work backward to identify why before the user starts.

Use this when the user has a concrete plan, launch, product, hire, strategy, or commitment where the cost of being wrong is high. Do not trigger on simple feedback requests, factual questions, vague ideas with no plan yet, or decisions that are already irreversible.

## Minimum Context Threshold

Before running the premortem, gather the minimum context:

1. What is it? Describe the plan in one sentence.
2. Who is it for or who does it affect?
3. What does success look like?

First scan available context:

- current conversation
- `CLAUDE.md`, `claude.md`, `AGENTS.md`, `README.md`
- `memory/`, `docs/`, briefs, launch plans, product plans, or referenced files

If any of the three required fields are missing, ask only the most important missing question and stop. Do not make the user fill out a form.

## Frame

Set the frame explicitly:

```text
It is 6 months from now. This plan has failed. It is done. We are looking back and trying to understand what went wrong.
```

## Raw Premortem

Generate every genuine reason the plan could have died. Be comprehensive, specific, and grounded in the actual plan. Do not pad with weak reasons and do not stop early if there are more real failure modes.

Each failure reason must be:

- specific to this plan
- grounded in provided context
- a genuine threat, not a minor inconvenience

## Deep-Dive Investigators

Run one investigator per failure reason in parallel. Each investigator analyzes exactly one assigned failure reason.

Investigator contract:

```text
You are an investigator in a premortem analysis. You have been assigned one specific failure reason to analyze in depth.

The plan:
[what it is, who it is for, what success looks like, and relevant workspace context]

PREMORTEM FRAME: It is 6 months from now. This plan has failed.

YOUR ASSIGNED FAILURE REASON: [failure reason]

Write:
1. THE FAILURE STORY: 2-3 paragraphs showing how this specific failure played out.
2. THE UNDERLYING ASSUMPTION: one sentence naming what the user took for granted.
3. EARLY WARNING SIGNS: 1-2 observable signals that this failure is starting.

Keep the response under 300 words. Be direct. Do not hedge. Do not sugarcoat.
```

## Synthesis

After all investigator outputs are complete, produce:

1. The Most Likely Failure - the probable failure mode and why.
2. The Most Dangerous Failure - the highest-damage failure mode and why.
3. The Hidden Assumption - the biggest unexamined assumption across the analyses.
4. The Revised Plan - concrete changes mapped to failure scenarios.
5. The Pre-Launch Checklist - 3-5 specific things to verify, test, or put in place.

The revised plan must be concrete. Do not say "consider testing pricing." Say "run a $47 pilot with 20 target users before committing to the $297 workshop."

## Outputs

Every complete session produces:

```text
premortem-report-[timestamp].html
premortem-transcript-[timestamp].md
```

The HTML report should be self-contained with inline CSS, a dark background, prominent synthesis at the top, one visual card per failure reason, severity/likelihood indicators, and a grid showing all investigator findings.

The transcript should include context gathered, raw failure reasons, all investigator deep dives, and the full synthesis.

Chat response should be at most three sentences: most likely failure, hidden assumption, and the single most important revision.
