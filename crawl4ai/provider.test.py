"""Focused semantic tests for the governed Crawl4AI local provider."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
PROVIDER_PATH = Path(__file__).with_name("agoragentic_crawl4ai.py")
FIXTURE_DIR = Path(__file__).with_name("fixtures") / "safe-site"
MANIFEST_PATH = Path(__file__).with_name("crawl4ai.local-provider.manifest.json")

SPEC = importlib.util.spec_from_file_location("agoragentic_crawl4ai_provider", PROVIDER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Crawl4AI provider module")
provider = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = provider
SPEC.loader.exec_module(provider)


def resolver_for(*addresses: str):
    def resolve(host, port, *, type):
        del host, type
        return [
            (socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))
            for address in addresses
        ]

    return resolve


def crawl4ai_dependency_available() -> bool:
    try:
        return importlib.util.find_spec("crawl4ai.content_scraping_strategy") is not None
    except ModuleNotFoundError:
        return False


class StubRenderer:
    def render(self, url: str, html: str):
        structure = provider.parse_page_structure(html, url)
        markdown = f"# {structure['title']}\n\nFixture words: {len(structure['text'].split())}."
        return provider.RenderedPage(
            markdown=markdown,
            parser="fixture-stub",
            parser_version="1",
        )


class DestinationPolicyTests(unittest.TestCase):
    def test_public_destination_is_canonicalized_and_pinned(self):
        destination = provider.validate_destination(
            "HTTPS://Public.Example/path?q=one two#fragment",
            resolver=resolver_for("93.184.216.34"),
        )
        self.assertEqual(destination.url, "https://public.example/path?q=one%20two")
        self.assertEqual(destination.request_target, "/path?q=one%20two")
        self.assertEqual(destination.addresses, ("93.184.216.34",))
        self.assertEqual(destination.connect_ip, "93.184.216.34")

    def test_global_ipv6_literal_is_supported(self):
        destination = provider.validate_destination("https://[2606:4700:4700::1111]/")
        self.assertEqual(destination.connect_ip, "2606:4700:4700::1111")

    def test_ssrf_matrix_fails_closed(self):
        cases = (
            "file:///etc/passwd",
            "http://localhost/",
            "http://internal/",
            "http://user:pass@public.example/",
            "https://public.example:8443/",
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://172.16.0.1/",
            "http://192.168.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
            "http://224.0.0.1/",
            "http://[::1]/",
            "http://[fe80::1]/",
        )
        for url in cases:
            with self.subTest(url=url), self.assertRaises(provider.PolicyError):
                provider.validate_destination(url, resolver=resolver_for("93.184.216.34"))

    def test_metadata_hostname_and_mixed_dns_answers_fail_closed(self):
        for answers in (("169.254.169.254",), ("93.184.216.34", "10.0.0.7")):
            with self.subTest(answers=answers), self.assertRaises(provider.PolicyError):
                provider.validate_destination(
                    "https://metadata.public.example/",
                    resolver=resolver_for(*answers),
                )

    def test_resolution_failure_fails_closed(self):
        def failing_resolver(*args, **kwargs):
            del args, kwargs
            raise socket.gaierror("fixture failure")

        with self.assertRaises(provider.PolicyError):
            provider.validate_destination("https://public.example/", resolver=failing_resolver)


class FetchPolicyTests(unittest.TestCase):
    def setUp(self):
        self.limits = provider.Limits(max_bytes_per_page=32, max_total_bytes=64)
        self.resolver = resolver_for("93.184.216.34")

    def test_private_redirect_is_rejected_before_second_request(self):
        calls = []

        def requester(destination, limits):
            del limits
            calls.append(destination.url)
            return provider.HttpResponse(
                302,
                {"location": "http://169.254.169.254/latest/meta-data/"},
                b"",
            )

        fetcher = provider.SafeHttpFetcher(resolver=self.resolver, requester=requester)
        with self.assertRaises(provider.PolicyError):
            fetcher.fetch("https://public.example/start", self.limits)
        self.assertEqual(calls, ["https://public.example/start"])

    def test_public_redirect_is_revalidated(self):
        calls = []

        def requester(destination, limits):
            del limits
            calls.append((destination.url, destination.connect_ip))
            if destination.url.endswith("/start"):
                return provider.HttpResponse(302, {"location": "/final"}, b"")
            return provider.HttpResponse(200, {"content-type": "text/html"}, b"<p>ok</p>")

        result = provider.SafeHttpFetcher(
            resolver=self.resolver,
            requester=requester,
        ).fetch("https://public.example/start", self.limits)
        self.assertEqual(result.final_url, "https://public.example/final")
        self.assertEqual(result.redirects, ("https://public.example/final",))
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[1] == "93.184.216.34" for call in calls))

    def test_response_guards_reject_unsafe_shapes(self):
        cases = (
            provider.HttpResponse(500, {"content-type": "text/html"}, b"error"),
            provider.HttpResponse(200, {"content-type": "application/json"}, b"{}"),
            provider.HttpResponse(200, {"content-type": "text/html", "content-encoding": "gzip"}, b"x"),
            provider.HttpResponse(200, {"content-type": "text/html"}, b"x" * 33),
        )
        for response in cases:
            with self.subTest(response=response), self.assertRaises(provider.AcquisitionError):
                provider.SafeHttpFetcher(
                    resolver=self.resolver,
                    requester=lambda destination, limits, value=response: value,
                ).fetch("https://public.example/", self.limits)


class FixtureAndArtifactTests(unittest.TestCase):
    def test_fixture_path_cannot_escape_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "fixture-map.json").write_text(
                json.dumps(
                    {
                        "seed_urls": ["https://fixture.example.test/"],
                        "pages": {
                            "https://fixture.example.test/": {
                                "file": "../outside.html",
                                "status": 200,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            (root.parent / "outside.html").write_text("outside", encoding="utf-8")
            fetcher = provider.FixtureFetcher(root)
            with self.assertRaises(provider.PolicyError):
                fetcher.fetch("https://fixture.example.test/", provider.Limits())

    def test_all_capabilities_emit_complete_zero_spend_evidence_without_network(self):
        fetcher = provider.FixtureFetcher(FIXTURE_DIR)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for capability in provider.CAPABILITIES:
                output = root / capability
                with mock.patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS used")), mock.patch.object(
                    socket, "create_connection", side_effect=AssertionError("network used")
                ):
                    result = provider.run_provider(
                        capability=capability,
                        urls=fetcher.seed_urls,
                        output_dir=output,
                        fetcher=fetcher,
                        renderer=StubRenderer(),
                        limits=provider.Limits(max_pages=3, max_depth=1),
                        now=lambda: "2026-08-08T12:00:00Z",
                        fixture_mode=True,
                    )
                self.assertEqual(result["status"], "recorded")
                self.assertEqual(result["source_count"], 2)
                self.assertEqual(result["spend_usdc"], 0)
                self.assertFalse(result["hosted_surface_enabled"])
                self.assertFalse(result["x402_enabled"])
                self._assert_bundle(output, capability)

    def _assert_bundle(self, output: Path, capability: str):
        expected = {
            "clean-markdown.md",
            "citation-map.json",
            "source-manifest.json",
            "trap-scan.json",
            "structured-pages.json",
            "context-packet.json",
            "local-receipt.json",
        }
        self.assertEqual({path.name for path in output.iterdir()}, expected)

        markdown = (output / "clean-markdown.md").read_text(encoding="utf-8")
        markdown_lines = markdown.splitlines()
        citation_map = json.loads((output / "citation-map.json").read_text(encoding="utf-8"))
        source_manifest = json.loads((output / "source-manifest.json").read_text(encoding="utf-8"))
        context_packet = json.loads((output / "context-packet.json").read_text(encoding="utf-8"))
        structured = json.loads((output / "structured-pages.json").read_text(encoding="utf-8"))
        receipt = json.loads((output / "local-receipt.json").read_text(encoding="utf-8"))

        self.assertEqual(source_manifest["mode"], "fixture_no_network")
        self.assertEqual(source_manifest["capability"], capability)
        self.assertFalse(source_manifest["crawl4ai"]["network_used_by_crawl4ai"])
        self.assertFalse(source_manifest["crawl4ai"]["javascript_executed"])
        self.assertFalse(source_manifest["crawl4ai"]["cookies_used"])
        self.assertEqual(len(source_manifest["sources"]), 2)
        self.assertTrue(all(not source["raw_body_retained"] for source in source_manifest["sources"]))

        sources_by_id = {source["source_id"]: source for source in source_manifest["sources"]}
        self.assertEqual(len(citation_map["citations"]), 2)
        for citation in citation_map["citations"]:
            source = sources_by_id[citation["source_id"]]
            self.assertEqual(citation["content_sha256"], source["content_sha256"])
            self.assertEqual(citation["url"], source["final_url"])
            start = citation["markdown_start_line"] - 1
            end = citation["markdown_end_line"]
            cited_lines = markdown_lines[start:end]
            self.assertTrue(cited_lines[0].startswith("## "))
            self.assertTrue(any(citation["citation_id"] in line for line in cited_lines))
        self.assertEqual(
            citation_map["clean_markdown_sha256"],
            "sha256:" + hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
        )

        self.assertEqual(context_packet["schema"], "agoragentic.micro-ecf.context-packet.v1")
        self.assertFalse(context_packet["export_boundary"]["raw_content_exported"])
        self.assertEqual(len(context_packet["sources"]), 2)
        self.assertNotIn("markdown", json.dumps(context_packet).lower())
        self.assertTrue(all("markdown" not in page for page in structured["pages"]))

        self.assertEqual(receipt["mode"], "local_no_spend_receipt")
        self.assertEqual(receipt["settlement_status"], "not_settlement_receipt")
        self.assertEqual(receipt["spend"]["amount_usdc"], 0)
        self.assertTrue(all(value is False for value in receipt["public_boundary"].values()))
        self.assertTrue(all(value is False for value in receipt["receipt_boundary"].values()))

    def test_trap_scan_blocks_downstream_artifacts(self):
        fetcher = provider.FixtureFetcher(FIXTURE_DIR)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "blocked"
            with self.assertRaises(provider.TrapScanBlocked):
                provider.run_provider(
                    capability="cited_web_research",
                    urls=["https://research.example.test/trap"],
                    output_dir=output,
                    fetcher=fetcher,
                    renderer=StubRenderer(),
                    now=lambda: "2026-08-08T12:00:00Z",
                    fixture_mode=True,
                )
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {"source-manifest.json", "trap-scan.json", "local-receipt.json"},
            )
            trap_scan = json.loads((output / "trap-scan.json").read_text(encoding="utf-8"))
            self.assertTrue(trap_scan["blocked"])
            receipt = json.loads((output / "local-receipt.json").read_text(encoding="utf-8"))
            self.assertEqual(receipt["evidence"]["proof_status"], "blocked")

    def test_existing_output_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(provider.PolicyError):
                provider.run_provider(
                    capability="structured_page_extract",
                    urls=["https://research.example.test/"],
                    output_dir=Path(temporary),
                    fetcher=provider.FixtureFetcher(FIXTURE_DIR),
                    renderer=StubRenderer(),
                    fixture_mode=True,
                )


class ManifestTests(unittest.TestCase):
    def test_manifest_keeps_all_operational_surfaces_disabled(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(set(manifest["capabilities"]), set(provider.CAPABILITIES))
        self.assertEqual(manifest["upstream"]["version"], provider.PINNED_CRAWL4AI_VERSION)
        self.assertTrue(all(value is False for value in manifest["boundaries"].values() if isinstance(value, bool)))
        self.assertEqual(manifest["boundaries"]["fixture_mode_network_calls"], 0)
        self.assertTrue(manifest["security"]["redirects_revalidated"])
        self.assertTrue(manifest["security"]["content_trap_scan_required"])

    @unittest.skipUnless(
        crawl4ai_dependency_available(),
        "Crawl4AI is not installed",
    )
    def test_exact_pinned_crawl4ai_release_parses_fixture_offline(self):
        html = (FIXTURE_DIR / "index.html").read_text(encoding="utf-8")
        with mock.patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS used")), mock.patch.object(
            socket, "create_connection", side_effect=AssertionError("network used")
        ):
            rendered = provider.Crawl4AIRenderer().render("https://research.example.test/", html)
        self.assertEqual(rendered.parser_version, provider.PINNED_CRAWL4AI_VERSION)
        self.assertIn("Bounded Web Evidence", rendered.markdown)


if __name__ == "__main__":
    unittest.main()
