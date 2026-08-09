# Governed Crawl4AI local provider

This public-OSS integration turns bounded public web pages into cited local
evidence. It supports three local capabilities:

- `cited_web_research`
- `website_to_context_packet`
- `structured_page_extract`

It is **not** a hosted provider, marketplace listing, public API, background
monitor, or x402 service. It does not publish, pay, settle, or call an
Agoragentic provider. A future paid/hosted provider would require separate auth,
policy, deployment, listing, and payment review.

## Safety architecture

Crawl4AI itself has no network authority in this adapter. The adapter's standard
library HTTP transport:

1. accepts only HTTP(S) on ports 80/443 with no URL credentials;
2. resolves every destination and rejects the request if **any** answer is
   loopback, private, link-local, reserved, multicast, unspecified, or otherwise
   non-global;
3. pins the connection to a validated address while preserving TLS hostname
   verification;
4. revalidates and repins every redirect before another request;
5. accepts only uncompressed HTML/XHTML/plain-text responses within explicit
   page, depth, byte, redirect, output, and sequential-concurrency limits, with
   one absolute deadline across each request and redirect chain, and rejects
   transfer encodings or duplicate framing/content headers that would make the
   cited body ambiguous;
6. narrows each fetch to the remaining aggregate-byte budget before acquisition
   and binds each citation to the requested URL, redirect chain, and content
   hash rather than only the final URL.

The reviewed Crawl4AI release receives only already-fetched HTML through its
offline LXML scraping and Markdown generation strategies. Browser automation,
JavaScript, cookies, persistent sessions, forms, images, and subresource fetches
are disabled by construction. Retrieved bytes are treated as untrusted data and
must pass a normalized content-trap scan (HTML entities, Unicode normalization,
and invisible/combining-character removal) before parsing; the final rendered
Markdown is scanned again before any cleaned artifacts are written.

Fixture mode bypasses DNS and sockets entirely and is the required no-spend
canary. Output is written to a new isolated directory through a temporary
directory and atomic rename. Existing output directories are refused.

## Install

Python 3.10 or newer is required. Install the exact reviewed release:

```bash
python -m pip install -r crawl4ai/requirements.txt
```

The pin and reviewed source commit are recorded in
`crawl4ai/upstream-provenance.json`. This repository does not install Crawl4AI's
browser runtime because this adapter does not use it.

## No-network fixture canary

From the repository root:

```bash
python crawl4ai/agoragentic_crawl4ai.py \
  --fixture-dir crawl4ai/fixtures/safe-site \
  --output ./crawl4ai-fixture-output \
  --max-depth 1
```

The output path must not already exist. The canary parses two local fixture
pages and performs zero DNS, HTTP, provider, payment, or hosted-runtime calls.

## Local bounded acquisition

The following is an operator-run local example, not a production endpoint:

```bash
python crawl4ai/agoragentic_crawl4ai.py \
  --capability cited_web_research \
  --url https://example.org/ \
  --output ./crawl4ai-evidence
```

Defaults are four pages, depth zero, 500 KB per page, 2 MB total input, ten
seconds per fetch including redirects, two redirects, and concurrency one. Hard
ceilings are documented in `crawl4ai.local-provider.manifest.json` and cannot
be raised from the CLI.

## Evidence artifacts

Successful runs write:

- `clean-markdown.md`: cleaned local Markdown with citation markers.
- `citation-map.json`: source IDs, hashes, URLs, and exact Markdown line spans.
- `source-manifest.json`: retrieval provenance, redirect chain, byte counts,
  parser version, limits, and content hashes.
- `trap-scan.json`: per-source content-trap findings and handling boundary.
- `structured-pages.json`: bounded headings, links, title metadata, and hashes.
- `context-packet.json`: Micro ECF-compatible public-web context packet that
  references local evidence without embedding raw page bodies.
- `local-receipt.json`: clearly labeled zero-spend local evidence receipt. It is
  not a Router, settlement, marketplace, or x402 receipt.

If a critical trap signal is found, the adapter fails closed and writes only the
source manifest, trap scan, and blocked local receipt. It does not emit cleaned
Markdown, structured extraction, citations, or a context packet.

## Tests

```bash
python crawl4ai/provider.test.py -v
```

The focused suite covers the SSRF matrix, mixed DNS answers, redirect
revalidation, absolute request deadlines, page/aggregate response limits,
quoted charset decoding, fixture path containment, all three capabilities,
collision-safe citation/source mapping, entity/renderer trap-scan fail-closed
behavior, and the disabled hosted/listing/x402 boundaries.

## Upstream attribution

This product includes software developed by UncleCode
(`https://github.com/unclecode`) as part of Crawl4AI
(`https://github.com/unclecode/crawl4ai`). Crawl4AI is licensed under Apache-2.0;
see its upstream `LICENSE`. Agoragentic's adapter code remains under this
repository's public license and does not imply upstream endorsement.
