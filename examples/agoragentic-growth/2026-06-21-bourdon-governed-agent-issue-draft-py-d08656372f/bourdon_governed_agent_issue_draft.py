#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass, field
from textwrap import dedent
from typing import Iterable, List


@dataclass(frozen=True)
class IssueSection:
    heading: str
    body: str

    def render(self) -> str:
        return f"## {self.heading}\n{self.body.strip()}\n"


@dataclass(frozen=True)
class GitHubIssueDraft:
    title: str
    labels: List[str] = field(default_factory=list)
    sections: List[IssueSection] = field(default_factory=list)

    def render(self) -> str:
        label_line = ""
        if self.labels:
            label_line = f"Labels: {', '.join(self.labels)}\n\n"
        rendered_sections = "\n".join(section.render().rstrip() for section in self.sections)
        return f"# {self.title}\n\n{label_line}{rendered_sections}".rstrip() + "\n"


def bullet_list(items: Iterable[str]) -> str:
    return "\n".join(f"- {item}" for item in items)


def numbered_list(items: Iterable[str]) -> str:
    return "\n".join(f"{i}. {item}" for i, item in enumerate(items, start=1))


def build_issue() -> GitHubIssueDraft:
    sections = [
        IssueSection(
            "Summary",
            dedent(
                """
                Add a documentation PR that defines a standard pattern for packaging any MCP tool as a governed, receipted agent, with Bourdon used as the concrete minimal working example.

                The goal is to make “tool -> agentized service” feel repeatable instead of bespoke. The docs should show the smallest viable path from an MCP-exposed capability to an operationally safe agent that can be invoked, governed, audited, and extended.
                """
            ),
        ),
        IssueSection(
            "Problem",
            dedent(
                """
                The repository can benefit from a reusable guide for contributors who have a working MCP tool but do not yet know how to turn it into an agent-shaped integration with the right governance surface.

                Without a standard pattern:
                - onboarding remains ad hoc and high-friction
                - governance controls are easy to describe abstractly but hard to implement consistently
                - receipt/audit expectations vary across examples
                - contributors do not know what the minimum acceptable “agent wrapper” looks like
                - agent-as-a-service experiments take longer because each integration starts from first principles
                """
            ),
        ),
        IssueSection(
            "Proposed documentation PR",
            dedent(
                """
                Add a focused docs contribution that introduces a canonical pattern with the following elements:

                1. Start from any MCP tool that already has a clear request/response contract.
                2. Wrap that tool behind an agent entrypoint with an explicit task schema.
                3. Separate untrusted user intent from approved execution scope.
                4. Add governance checkpoints:
                   - allowed inputs
                   - denied actions
                   - approval boundaries
                   - side-effect classification
                   - bounded fallback behavior
                5. Emit receipts for every execution:
                   - who/what invoked it
                   - tool called
                   - bounded inputs
                   - decision/approval context
                   - execution outcome
                   - evidence pointer(s)
                6. Keep the minimal example small enough to copy into a new integration.

                The PR should optimize for “I have one MCP tool; show me the shortest credible path to a governed agent.”
                """
            ),
        ),
        IssueSection(
            "Why Bourdon is the right case study",
            dedent(
                """
                Bourdon is a good example because it is concrete enough to demonstrate the pattern while remaining small enough for a minimal working example.

                Bourdon should be used in the docs as the case study that answers:
                - what the MCP tool exposes
                - what the agent wrapper adds
                - where governance policy is enforced
                - what a receipt looks like
                - how a maintainer can adapt the same pattern to another MCP tool

                The example should explicitly distinguish the underlying tool capability from the governed agent contract layered on top of it.
                """
            ),
        ),
        IssueSection(
            "Suggested doc structure",
            dedent(
                """
                The PR could be organized into a single guide plus one compact example directory.

                Suggested sections:
                """
            ).rstrip()
            + "\n"
            + bullet_list(
                [
                    "What problem this pattern solves",
                    "Definitions: MCP tool, governed agent, receipt, approval boundary",
                    "Architecture at a glance",
                    "Minimal wrapper contract",
                    "Governance checklist",
                    "Receipt schema and example",
                    "Bourdon walkthrough",
                    "How to adapt the pattern to any other MCP tool",
                    "Common failure modes and anti-patterns",
                ]
            ),
        ),
        IssueSection(
            "Minimal working example expectations",
            dedent(
                """
                The Bourdon example should be intentionally minimal but still real enough to guide implementation.

                It should include:
                """
            ).rstrip()
            + "\n"
            + bullet_list(
                [
                    "a tiny MCP-facing adapter or invocation layer",
                    "an agent task envelope with typed inputs",
                    "a policy gate that rejects out-of-scope actions",
                    "a receipt emitted on every run",
                    "one success path and one denied path",
                    "example request/response payloads",
                    "clear notes on where project-specific governance can be swapped in",
                ]
            ),
        ),
        IssueSection(
            "Receipt guidance",
            dedent(
                """
                The docs should treat receipts as first-class outputs, not optional logging.

                At minimum, the guide should show a receipt containing:
                """
            ).rstrip()
            + "\n"
            + bullet_list(
                [
                    "timestamp",
                    "agent name/version",
                    "tool identifier",
                    "sanitized input summary",
                    "governance decision",
                    "approval context or reason no approval was required",
                    "result status",
                    "evidence references or execution notes",
                ]
            )
            + "\n\n"
            + "The guide should also state which fields are safe to persist and which values must be redacted or summarized."
        ),
        IssueSection(
            "Governance guidance",
            dedent(
                """
                The documentation should be explicit that the wrapper is not just transport glue; it is the enforcement point for safe operation.

                The guide should cover:
                """
            ).rstrip()
            + "\n"
            + bullet_list(
                [
                    "how to classify tool actions as read-only vs side-effecting",
                    "where to place deny-by-default policy checks",
                    "how to require human or broker approval for risky actions",
                    "how to enforce bounded operator fallback instead of unconstrained execution",
                    "how to preserve evidence without leaking secrets",
                ]
            ),
        ),
        IssueSection(
            "Non-goals",
            bullet_list(
                [
                    "Do not attempt to standardize every possible orchestration stack in one PR.",
                    "Do not turn the example into a framework before the pattern is proven useful.",
                    "Do not bury the minimal example under product-specific abstractions.",
                    "Do not define receipts so narrowly that they only fit Bourdon.",
                ]
            ),
        ),
        IssueSection(
            "Acceptance criteria",
            numbered_list(
                [
                    "A contributor can read one guide and understand how to package any MCP tool as a governed, receipted agent.",
                    "The docs include a Bourdon-based minimal working example with runnable or copyable code snippets.",
                    "The guide clearly separates MCP capability, agent wrapper, governance checks, and receipt emission.",
                    "The example demonstrates at least one allowed execution and one denied execution.",
                    "The receipt example is concrete enough for another integration to reuse with minimal changes.",
                    "The documentation calls out redaction, approval boundaries, and bounded fallback behavior.",
                ]
            ),
        ),
        IssueSection(
            "Why this is worth doing now",
            dedent(
                """
                This would give the community a reusable contribution pattern instead of another isolated example. A good standard example reduces onboarding friction, shortens the path from tool to service, and makes future integrations easier to review because maintainers can compare them against one documented baseline.
                """
            ),
        ),
        IssueSection(
            "Suggested deliverables in the PR",
            bullet_list(
                [
                    "one primary docs page for the pattern",
                    "one Bourdon example directory or embedded example block",
                    "one sample receipt document or JSON example embedded in docs",
                    "one short contributor checklist for adapting the pattern to another MCP tool",
                ]
            ),
        ),
    ]

    return GitHubIssueDraft(
        title="Docs: standard pattern for packaging MCP tools as governed, receipted agents (Bourdon example)",
        labels=["documentation", "enhancement", "integrations"],
        sections=sections,
    )


def self_test() -> None:
    issue = build_issue()
    rendered = issue.render()

    required_phrases = [
        "governed, receipted agent",
        "Bourdon",
        "Receipt guidance",
        "Acceptance criteria",
        "minimal working example",
        "approval boundaries",
    ]
    for phrase in required_phrases:
        assert phrase in rendered, f"missing required phrase: {phrase}"

    assert rendered.startswith("# "), "issue should render with a markdown H1 title"
    assert "## Summary" in rendered, "missing Summary section"
    assert "## Proposed documentation PR" in rendered, "missing Proposed documentation PR section"
    assert "Labels: documentation, enhancement, integrations" in rendered, "labels not rendered correctly"


def main() -> None:
    self_test()
    print(build_issue().render(), end="")


if __name__ == "__main__":
    main()
