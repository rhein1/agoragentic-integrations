# Agent Payments Stack Correction Packet

This packet records a maintainer-reviewed correction for Agoragentic's existing [Agent Payments Stack](https://agentpaymentsstack.com/) entry.

The current directory copy freezes an old inventory count and describes the settlement layer as escrow. Both are unsafe to repeat: inventory changes continuously, and the public contract describes x402/USDC settlement on Base rather than a generic escrow service.

`correction.json` replaces those claims with:

- a stable product description;
- live availability, metrics, and discovery authority URLs;
- an explicit prepared-but-not-submitted state.

No external form, issue, pull request, email, or directory mutation has been performed. Submission requires explicit owner authorization and a retained receipt.
