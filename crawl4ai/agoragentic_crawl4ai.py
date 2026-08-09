#!/usr/bin/env python3
"""Governed local Crawl4AI acquisition and evidence adapter.

The adapter deliberately keeps Crawl4AI off the network. A small HTTP transport
validates and pins every destination (including redirects), then the reviewed
Crawl4AI parser receives only already-fetched HTML. Fixture mode performs no
network calls and is the default verification path.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import ipaddress
import json
import re
import shutil
import socket
import ssl
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence
from urllib.parse import quote, urljoin, urlsplit, urlunsplit


PINNED_CRAWL4AI_VERSION = "0.9.2"
CAPABILITIES = (
    "cited_web_research",
    "website_to_context_packet",
    "structured_page_extract",
)
MAX_PAGES = 8
MAX_DEPTH = 1
MAX_BYTES_PER_PAGE = 1_000_000
MAX_TOTAL_BYTES = 4_000_000
MAX_TIMEOUT_SECONDS = 30.0
MAX_REDIRECTS = 3
MAX_OUTPUT_BYTES = 6_000_000
MAX_CONCURRENCY = 1
USER_AGENT = "Agoragentic-Crawl4AI-Local/0.1 (+https://github.com/rhein1/agoragentic-integrations)"
ALLOWED_CONTENT_TYPES = ("text/html", "application/xhtml+xml", "text/plain")

PROMPT_TRAP_PATTERNS = (
    (
        "instruction_override",
        re.compile(r"\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b", re.I),
    ),
    (
        "authority_impersonation",
        re.compile(r"\b(?:you are now|act as)\s+(?:the\s+)?(?:system|developer|administrator|root)\b", re.I),
    ),
    (
        "secret_exfiltration",
        re.compile(r"\b(?:reveal|print|send|exfiltrate|upload)\b.{0,80}\b(?:secret|token|api[ _-]?key|private key|environment variables?)\b", re.I | re.S),
    ),
    (
        "tool_execution_request",
        re.compile(r"\b(?:execute|run)\s+(?:this\s+)?(?:shell|terminal|powershell|bash|command|tool)\b", re.I),
    ),
)


class ProviderError(RuntimeError):
    """Base error for bounded provider failures."""


class PolicyError(ProviderError):
    """Raised when a request violates a local safety policy."""


class AcquisitionError(ProviderError):
    """Raised when a validated acquisition cannot complete safely."""


class TrapScanBlocked(ProviderError):
    """Raised after a blocked evidence packet has been written."""

    def __init__(self, output_dir: Path):
        super().__init__("retrieved content failed the prompt-injection/content-trap scan")
        self.output_dir = output_dir


@dataclass(frozen=True)
class Limits:
    max_pages: int = 4
    max_depth: int = 0
    max_bytes_per_page: int = 500_000
    max_total_bytes: int = 2_000_000
    timeout_seconds: float = 10.0
    max_redirects: int = 2
    max_concurrency: int = 1

    def validate(self) -> "Limits":
        if not 1 <= self.max_pages <= MAX_PAGES:
            raise PolicyError(f"max_pages must be between 1 and {MAX_PAGES}")
        if not 0 <= self.max_depth <= MAX_DEPTH:
            raise PolicyError(f"max_depth must be between 0 and {MAX_DEPTH}")
        if not 1 <= self.max_bytes_per_page <= MAX_BYTES_PER_PAGE:
            raise PolicyError(f"max_bytes_per_page must be between 1 and {MAX_BYTES_PER_PAGE}")
        if not 1 <= self.max_total_bytes <= MAX_TOTAL_BYTES:
            raise PolicyError(f"max_total_bytes must be between 1 and {MAX_TOTAL_BYTES}")
        if self.max_total_bytes < self.max_bytes_per_page:
            raise PolicyError("max_total_bytes must be at least max_bytes_per_page")
        if not 0.1 <= self.timeout_seconds <= MAX_TIMEOUT_SECONDS:
            raise PolicyError(f"timeout_seconds must be between 0.1 and {MAX_TIMEOUT_SECONDS}")
        if not 0 <= self.max_redirects <= MAX_REDIRECTS:
            raise PolicyError(f"max_redirects must be between 0 and {MAX_REDIRECTS}")
        if self.max_concurrency != MAX_CONCURRENCY:
            raise PolicyError("max_concurrency must remain 1 in this local provider")
        return self


@dataclass(frozen=True)
class ValidatedDestination:
    url: str
    scheme: str
    host: str
    port: int
    request_target: str
    addresses: tuple[str, ...]
    connect_ip: str


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


@dataclass(frozen=True)
class FetchResult:
    requested_url: str
    final_url: str
    redirects: tuple[str, ...]
    status: int
    content_type: str
    body: bytes


@dataclass(frozen=True)
class RenderedPage:
    markdown: str
    parser: str
    parser_version: str


class Fetcher(Protocol):
    def fetch(self, url: str, limits: Limits) -> FetchResult: ...


class Renderer(Protocol):
    def render(self, url: str, html: str) -> RenderedPage: ...


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _sha256_text(value: str) -> str:
    return _sha256_bytes(value.encode("utf-8"))


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _stable_id(prefix: str, value: Any) -> str:
    digest = hashlib.sha256(_stable_json(value).encode("utf-8")).hexdigest()[:20]
    return f"{prefix}_{digest}"


def _normalize_hostname(host: str) -> str:
    try:
        return host.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError as exc:
        raise PolicyError("URL hostname is not valid IDNA") from exc


def _address_is_public(address: str) -> bool:
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    return parsed.is_global and not any(
        (
            parsed.is_multicast,
            parsed.is_reserved,
            parsed.is_unspecified,
            parsed.is_loopback,
            parsed.is_link_local,
            parsed.is_private,
        )
    )


def _resolver_addresses(
    host: str,
    port: int,
    resolver: Callable[..., Sequence[tuple[Any, ...]]],
) -> tuple[str, ...]:
    try:
        answers = resolver(host, port, type=socket.SOCK_STREAM)
    except (OSError, socket.gaierror) as exc:
        raise PolicyError(f"hostname could not be resolved: {host}") from exc
    addresses = sorted({str(answer[4][0]) for answer in answers if len(answer) >= 5 and answer[4]})
    if not addresses:
        raise PolicyError(f"hostname resolved to no addresses: {host}")
    if any(not _address_is_public(address) for address in addresses):
        raise PolicyError(f"hostname resolved to a non-public address: {host}")
    return tuple(addresses)


def validate_destination(
    url: str,
    *,
    resolver: Callable[..., Sequence[tuple[Any, ...]]] = socket.getaddrinfo,
) -> ValidatedDestination:
    """Validate and resolve one destination without making an HTTP request."""

    if not isinstance(url, str) or not url.strip():
        raise PolicyError("URL must be a non-empty string")
    if len(url) > 2048:
        raise PolicyError("URL exceeds 2048 characters")
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise PolicyError("only http and https URLs are allowed")
    if parsed.username is not None or parsed.password is not None:
        raise PolicyError("URL userinfo is not allowed")
    if not parsed.hostname:
        raise PolicyError("URL hostname is required")
    host = _normalize_hostname(parsed.hostname)
    if host == "localhost" or host.endswith(".localhost"):
        raise PolicyError("localhost hostnames are not allowed")
    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError as exc:
        raise PolicyError("URL port is invalid") from exc
    if port not in {80, 443}:
        raise PolicyError("only ports 80 and 443 are allowed")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host:
            raise PolicyError("single-label hostnames are not allowed")
        addresses = _resolver_addresses(host, port, resolver)
    else:
        if not _address_is_public(str(literal)):
            raise PolicyError("IP-literal destination is not public")
        addresses = (str(literal),)

    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parsed.query, safe="=&%/:?@!$'()*+,;~-._")
    request_target = path + (f"?{query}" if query else "")
    display_host = f"[{host}]" if ":" in host else host
    default_port = 443 if scheme == "https" else 80
    netloc = display_host if port == default_port else f"{display_host}:{port}"
    canonical_url = urlunsplit((scheme, netloc, path, query, ""))
    return ValidatedDestination(
        url=canonical_url,
        scheme=scheme,
        host=host,
        port=port,
        request_target=request_target,
        addresses=addresses,
        connect_ip=addresses[0],
    )


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, destination: ValidatedDestination, timeout: float):
        super().__init__(destination.host, destination.port, timeout=timeout)
        self._connect_ip = destination.connect_ip

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._connect_ip, self.port),
            self.timeout,
            self.source_address,
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, destination: ValidatedDestination, timeout: float):
        super().__init__(
            destination.host,
            destination.port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
        self._connect_ip = destination.connect_ip

    def connect(self) -> None:
        raw_socket = socket.create_connection(
            (self._connect_ip, self.port),
            self.timeout,
            self.source_address,
        )
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)


def _request_once(destination: ValidatedDestination, limits: Limits) -> HttpResponse:
    connection_class = _PinnedHTTPSConnection if destination.scheme == "https" else _PinnedHTTPConnection
    connection = connection_class(destination, limits.timeout_seconds)
    headers = {
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8",
        "Accept-Encoding": "identity",
        "Connection": "close",
        "User-Agent": USER_AGENT,
    }
    try:
        connection.request("GET", destination.request_target, headers=headers)
        response = connection.getresponse()
        response_headers = {key.lower(): value.strip() for key, value in response.getheaders()}
        content_length = response_headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError as exc:
                raise AcquisitionError("response Content-Length is invalid") from exc
            if declared_length > limits.max_bytes_per_page:
                raise AcquisitionError("response exceeds max_bytes_per_page")
        body_limit = 4096 if 300 <= response.status < 400 else limits.max_bytes_per_page + 1
        body = response.read(body_limit)
        return HttpResponse(status=response.status, headers=response_headers, body=body)
    except (OSError, TimeoutError, http.client.HTTPException) as exc:
        raise AcquisitionError(f"validated request failed for {destination.url}") from exc
    finally:
        connection.close()


class SafeHttpFetcher:
    """HTTP fetcher with public-address pinning and per-hop redirect validation."""

    def __init__(
        self,
        *,
        resolver: Callable[..., Sequence[tuple[Any, ...]]] = socket.getaddrinfo,
        requester: Callable[[ValidatedDestination, Limits], HttpResponse] = _request_once,
    ):
        self._resolver = resolver
        self._requester = requester

    def fetch(self, url: str, limits: Limits) -> FetchResult:
        current = url
        redirects: list[str] = []
        requested = url
        for hop in range(limits.max_redirects + 1):
            destination = validate_destination(current, resolver=self._resolver)
            response = self._requester(destination, limits)
            if 300 <= response.status < 400:
                location = response.headers.get("location")
                if not location:
                    raise AcquisitionError("redirect response omitted Location")
                if hop >= limits.max_redirects:
                    raise AcquisitionError("redirect limit exceeded")
                candidate = urljoin(destination.url, location)
                # This validation happens before the next request, so private and
                # metadata redirects never reach the requester.
                validate_destination(candidate, resolver=self._resolver)
                redirects.append(candidate)
                current = candidate
                continue
            if not 200 <= response.status < 300:
                raise AcquisitionError(f"HTTP status {response.status} is not accepted")
            encoding = response.headers.get("content-encoding", "identity").lower()
            if encoding not in {"", "identity"}:
                raise AcquisitionError("compressed responses are not accepted")
            content_type = response.headers.get("content-type", "").lower()
            if not any(content_type.startswith(allowed) for allowed in ALLOWED_CONTENT_TYPES):
                raise AcquisitionError(f"content type is not accepted: {content_type or 'missing'}")
            if len(response.body) > limits.max_bytes_per_page:
                raise AcquisitionError("response exceeds max_bytes_per_page")
            return FetchResult(
                requested_url=requested,
                final_url=destination.url,
                redirects=tuple(redirects),
                status=response.status,
                content_type=content_type,
                body=response.body,
            )
        raise AcquisitionError("redirect limit exceeded")


class FixtureFetcher:
    """Local fixture transport. It never resolves DNS or opens a socket."""

    def __init__(self, fixture_dir: Path):
        self.fixture_dir = fixture_dir.resolve(strict=True)
        manifest_path = self.fixture_dir / "fixture-map.json"
        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.seed_urls = tuple(self.manifest.get("seed_urls", ()))
        self.pages = self.manifest.get("pages", {})
        if not self.seed_urls or not isinstance(self.pages, dict):
            raise PolicyError("fixture-map.json must declare seed_urls and pages")

    def _fixture_path(self, relative: str) -> Path:
        candidate = (self.fixture_dir / relative).resolve(strict=True)
        try:
            candidate.relative_to(self.fixture_dir)
        except ValueError as exc:
            raise PolicyError("fixture file escapes fixture directory") from exc
        if not candidate.is_file():
            raise PolicyError("fixture entry must resolve to a file")
        return candidate

    def fetch(self, url: str, limits: Limits) -> FetchResult:
        current = url
        redirects: list[str] = []
        for hop in range(limits.max_redirects + 1):
            entry = self.pages.get(current)
            if not isinstance(entry, dict):
                raise AcquisitionError(f"fixture URL is not declared: {current}")
            status = int(entry.get("status", 200))
            if 300 <= status < 400:
                location = entry.get("location")
                if not isinstance(location, str) or not location:
                    raise AcquisitionError("fixture redirect omitted location")
                if hop >= limits.max_redirects:
                    raise AcquisitionError("fixture redirect limit exceeded")
                current = urljoin(current, location)
                redirects.append(current)
                continue
            if not 200 <= status < 300:
                raise AcquisitionError(f"fixture status {status} is not accepted")
            file_path = self._fixture_path(str(entry.get("file", "")))
            body = file_path.read_bytes()
            if len(body) > limits.max_bytes_per_page:
                raise AcquisitionError("fixture exceeds max_bytes_per_page")
            return FetchResult(
                requested_url=url,
                final_url=current,
                redirects=tuple(redirects),
                status=status,
                content_type=str(entry.get("content_type", "text/html; charset=utf-8")),
                body=body,
            )
        raise AcquisitionError("fixture redirect limit exceeded")


class _PageStructureParser(HTMLParser):
    SKIP_TAGS = {"script", "style", "noscript", "template", "svg"}

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.skip_depth = 0
        self.title_depth = 0
        self.heading_tag: str | None = None
        self.title_parts: list[str] = []
        self.heading_parts: list[str] = []
        self.headings: list[dict[str, str]] = []
        self.links: list[str] = []
        self.text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.lower()
        if lowered in self.SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if lowered == "title":
            self.title_depth += 1
        if lowered in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.heading_tag = lowered
            self.heading_parts = []
        if lowered == "a":
            attributes = {key.lower(): value for key, value in attrs}
            href = attributes.get("href")
            if href:
                resolved = urljoin(self.base_url, href)
                parsed = urlsplit(resolved)
                if parsed.scheme in {"http", "https"}:
                    self.links.append(urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, "")))

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered in self.SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth:
            return
        if lowered == "title":
            self.title_depth = max(0, self.title_depth - 1)
        if self.heading_tag == lowered:
            text = " ".join(" ".join(self.heading_parts).split())
            if text:
                self.headings.append({"level": lowered, "text": text[:500]})
            self.heading_tag = None
            self.heading_parts = []

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        clean = " ".join(data.split())
        if not clean:
            return
        self.text_parts.append(clean)
        if self.title_depth:
            self.title_parts.append(clean)
        if self.heading_tag:
            self.heading_parts.append(clean)

    def result(self) -> dict[str, Any]:
        title = " ".join(self.title_parts).strip()[:500]
        return {
            "title": title,
            "title_sha256": _sha256_text(title),
            "headings": self.headings[:100],
            "links": sorted(set(self.links))[:500],
            "text": "\n".join(self.text_parts),
        }


def parse_page_structure(html: str, base_url: str) -> dict[str, Any]:
    parser = _PageStructureParser(base_url)
    parser.feed(html)
    parser.close()
    return parser.result()


def scan_content(text: str) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    for code, pattern in PROMPT_TRAP_PATTERNS:
        if pattern.search(text):
            findings.append(
                {
                    "code": code,
                    "severity": "critical",
                    "message": f"Retrieved content matched {code}.",
                }
            )
    encoding_signals: list[str] = []
    if re.search(r"[\u200b-\u200d\ufeff]", text):
        encoding_signals.append("zero_width")
    if re.search(r"(?:^|[^A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?:$|[^A-Za-z0-9+/=])", text):
        encoding_signals.append("base64_like")
    return {
        "schema": "agoragentic.crawl4ai.trap-scan.v1",
        "blocked": any(item["severity"] == "critical" for item in findings),
        "findings": findings,
        "encoding_signals": encoding_signals,
        "external_content_is_data_not_instruction": True,
        "retrieved_text_used_as_authority": False,
    }


class Crawl4AIRenderer:
    """Offline Crawl4AI renderer; no browser or Crawl4AI transport is used."""

    def render(self, url: str, html: str) -> RenderedPage:
        try:
            from crawl4ai.__version__ import __version__ as installed_version
            from crawl4ai.content_scraping_strategy import LXMLWebScrapingStrategy
            from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
        except ImportError as exc:
            raise ProviderError(
                f"Crawl4AI {PINNED_CRAWL4AI_VERSION} is required; install crawl4ai/requirements.txt"
            ) from exc
        if installed_version != PINNED_CRAWL4AI_VERSION:
            raise PolicyError(
                f"Crawl4AI version mismatch: expected {PINNED_CRAWL4AI_VERSION}, got {installed_version}"
            )
        scraped = LXMLWebScrapingStrategy().scrap(
            url,
            html,
            word_count_threshold=0,
            excluded_tags=["script", "style", "noscript", "iframe", "object", "embed", "form"],
            exclude_all_images=True,
            remove_comments=True,
            keep_data_attributes=False,
        )
        if not scraped.success or not scraped.cleaned_html:
            raise AcquisitionError("Crawl4AI could not produce cleaned HTML")
        markdown_result = DefaultMarkdownGenerator().generate_markdown(
            scraped.cleaned_html,
            base_url=url,
            citations=False,
        )
        markdown = str(markdown_result.raw_markdown or "").strip()
        if not markdown:
            raise AcquisitionError("Crawl4AI produced empty markdown")
        return RenderedPage(
            markdown=markdown,
            parser="crawl4ai-offline-lxml",
            parser_version=installed_version,
        )


def _decode_body(result: FetchResult) -> str:
    charset_match = re.search(r"charset=([A-Za-z0-9._-]+)", result.content_type, re.I)
    charset = charset_match.group(1) if charset_match else "utf-8"
    try:
        return result.body.decode(charset, errors="strict")
    except (LookupError, UnicodeDecodeError):
        return result.body.decode("utf-8", errors="replace")


def _same_origin(candidate: str, origin: str) -> bool:
    first = urlsplit(candidate)
    second = urlsplit(origin)
    try:
        first_port = first.port or (443 if first.scheme == "https" else 80)
        second_port = second.port or (443 if second.scheme == "https" else 80)
    except ValueError:
        return False
    return (
        first.scheme.lower(),
        (first.hostname or "").lower(),
        first_port,
    ) == (
        second.scheme.lower(),
        (second.hostname or "").lower(),
        second_port,
    )


def _ensure_isolated_target(output_dir: Path) -> tuple[Path, Path]:
    target = output_dir.expanduser()
    if target.exists():
        raise PolicyError("output directory must not already exist")
    lexical_parent = target.absolute().parent
    cursor = lexical_parent
    while True:
        if cursor.is_symlink():
            raise PolicyError("output path may not traverse a symlink")
        if cursor.parent == cursor:
            break
        cursor = cursor.parent
    parent = target.parent.resolve(strict=True)
    resolved_target = parent / target.name
    if resolved_target.name in {"", ".", ".."}:
        raise PolicyError("output directory name is invalid")
    temporary = Path(tempfile.mkdtemp(prefix=f".{resolved_target.name}.", dir=parent))
    return resolved_target, temporary


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _write_artifacts(output_dir: Path, artifacts: Mapping[str, bytes]) -> Path:
    target, temporary = _ensure_isolated_target(output_dir)
    total = sum(len(content) for content in artifacts.values())
    if total > MAX_OUTPUT_BYTES:
        shutil.rmtree(temporary, ignore_errors=True)
        raise PolicyError("artifact bundle exceeds the local output limit")
    try:
        for name, content in artifacts.items():
            if Path(name).name != name:
                raise PolicyError("artifact name must be a basename")
            path = temporary / name
            path.write_bytes(content)
        temporary.rename(target)
        return target
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def _receipt(
    *,
    capability: str,
    created_at: str,
    status: str,
    artifact_names: Iterable[str],
    evidence_root: str,
    source_count: int,
) -> dict[str, Any]:
    proof_id = _stable_id("proof", {"capability": capability, "evidence_root": evidence_root})
    return {
        "schema": "agoragentic.harness.local-receipt.v1",
        "receipt_id": _stable_id("receipt", {"proof_id": proof_id, "status": status}),
        "proof_id": proof_id,
        "created_at": created_at,
        "mode": "local_no_spend_receipt",
        "status": status,
        "settlement_status": "not_settlement_receipt",
        "spend": {
            "amount_usdc": 0,
            "settlement_network": "none",
            "settlement_status": "not_applicable",
        },
        "evidence": {
            "agent_name": "agoragentic-crawl4ai-local-provider",
            "primary_goal": capability,
            "proof_status": "passed" if status == "recorded" else "blocked",
            "local_artifacts": sorted(artifact_names),
            "evidence_root": evidence_root,
            "source_count": source_count,
        },
        "receipt_boundary": {
            "router_invocation_created": False,
            "x402_payment_attempted": False,
            "marketplace_published": False,
            "hosted_runtime_provisioned": False,
            "memory_written": False,
        },
        "public_boundary": {
            "spend_triggered": False,
            "settlement_triggered": False,
            "payout_triggered": False,
            "publication_triggered": False,
            "hosted_provisioning_triggered": False,
            "x402_route_created": False,
        },
    }


def run_provider(
    *,
    capability: str,
    urls: Sequence[str],
    output_dir: Path,
    fetcher: Fetcher,
    renderer: Renderer,
    limits: Limits | None = None,
    now: Callable[[], str] = _now_iso,
    fixture_mode: bool = False,
) -> dict[str, Any]:
    """Run one bounded acquisition and write an isolated evidence bundle."""

    if capability not in CAPABILITIES:
        raise PolicyError(f"unsupported capability: {capability}")
    active_limits = (limits or Limits()).validate()
    unique_urls = list(dict.fromkeys(str(url).strip() for url in urls if str(url).strip()))
    if not unique_urls:
        raise PolicyError("at least one URL is required")
    if len(unique_urls) > active_limits.max_pages:
        raise PolicyError("seed URL count exceeds max_pages")

    created_at = now()
    queue: list[tuple[str, int, str]] = [(url, 0, url) for url in unique_urls]
    visited: set[str] = set()
    pages: list[dict[str, Any]] = []
    source_manifest: list[dict[str, Any]] = []
    trap_records: list[dict[str, Any]] = []
    total_bytes = 0

    while queue and len(pages) < active_limits.max_pages:
        requested_url, depth, seed_url = queue.pop(0)
        if requested_url in visited:
            continue
        visited.add(requested_url)
        fetched = fetcher.fetch(requested_url, active_limits)
        total_bytes += len(fetched.body)
        if total_bytes > active_limits.max_total_bytes:
            raise AcquisitionError("acquisition exceeds max_total_bytes")
        html = _decode_body(fetched)
        structure = parse_page_structure(html, fetched.final_url)
        source_id = _stable_id("src", fetched.final_url)
        citation_id = _stable_id("cite", {"source_id": source_id, "hash": _sha256_bytes(fetched.body)})
        # Scan the complete retrieved document so hidden attributes, comments,
        # and skipped script/style regions cannot bypass the content boundary.
        trap_scan = scan_content(html)
        trap_records.append(
            {
                "source_id": source_id,
                "citation_id": citation_id,
                "url": fetched.final_url,
                **trap_scan,
            }
        )
        source_manifest.append(
            {
                "source_id": source_id,
                "citation_id": citation_id,
                "requested_url": fetched.requested_url,
                "final_url": fetched.final_url,
                "redirects": list(fetched.redirects),
                "status": fetched.status,
                "content_type": fetched.content_type,
                "bytes": len(fetched.body),
                "content_sha256": _sha256_bytes(fetched.body),
                "retrieved_at": created_at,
                "depth": depth,
                "seed_url": seed_url,
                "raw_body_retained": False,
            }
        )
        if trap_scan["blocked"]:
            manifest = {
                "schema": "agoragentic.crawl4ai.source-manifest.v1",
                "created_at": created_at,
                "mode": "fixture_no_network" if fixture_mode else "local_bounded_network",
                "capability": capability,
                "limits": asdict(active_limits),
                "sources": source_manifest,
            }
            scan_packet = {
                "schema": "agoragentic.crawl4ai.trap-scan-bundle.v1",
                "created_at": created_at,
                "blocked": True,
                "sources": trap_records,
            }
            base_artifacts = {
                "source-manifest.json": _json_bytes(manifest),
                "trap-scan.json": _json_bytes(scan_packet),
            }
            evidence_root = _sha256_text(
                _stable_json({name: _sha256_bytes(content) for name, content in base_artifacts.items()})
            )
            receipt = _receipt(
                capability=capability,
                created_at=created_at,
                status="blocked",
                artifact_names=(*base_artifacts.keys(), "local-receipt.json"),
                evidence_root=evidence_root,
                source_count=len(source_manifest),
            )
            target = _write_artifacts(
                output_dir,
                {**base_artifacts, "local-receipt.json": _json_bytes(receipt)},
            )
            raise TrapScanBlocked(target)

        rendered = renderer.render(fetched.final_url, html)
        page = {
            "source_id": source_id,
            "citation_id": citation_id,
            "url": fetched.final_url,
            "title": structure["title"],
            "title_sha256": structure["title_sha256"],
            "headings": structure["headings"],
            "links": structure["links"],
            "markdown": rendered.markdown,
            "markdown_sha256": _sha256_text(rendered.markdown),
            "parser": rendered.parser,
            "parser_version": rendered.parser_version,
            "depth": depth,
        }
        pages.append(page)
        source_manifest[-1]["clean_markdown_sha256"] = page["markdown_sha256"]
        source_manifest[-1]["parser"] = rendered.parser
        source_manifest[-1]["parser_version"] = rendered.parser_version

        if depth < active_limits.max_depth:
            for link in structure["links"]:
                if len(visited) + len(queue) >= active_limits.max_pages:
                    break
                if _same_origin(link, fetched.final_url) and link not in visited:
                    queue.append((link, depth + 1, seed_url))

    markdown_lines = ["# Governed Crawl4AI evidence bundle", ""]
    citation_rows: list[dict[str, Any]] = []
    for page in pages:
        start_line = len(markdown_lines) + 1
        page_lines = [
            f"## {page['title'] or page['url']}",
            "",
            f"Source: [{page['citation_id']}]({page['url']})",
            "",
            *page["markdown"].splitlines(),
            "",
        ]
        markdown_lines.extend(page_lines)
        citation_rows.append(
            {
                "citation_id": page["citation_id"],
                "source_id": page["source_id"],
                "url": page["url"],
                "content_sha256": next(
                    source["content_sha256"]
                    for source in source_manifest
                    if source["source_id"] == page["source_id"]
                ),
                "clean_markdown_sha256": page["markdown_sha256"],
                "markdown_start_line": start_line,
                "markdown_end_line": start_line + len(page_lines) - 2,
            }
        )
    clean_markdown = "\n".join(markdown_lines).rstrip() + "\n"
    clean_markdown_hash = _sha256_text(clean_markdown)
    citation_map = {
        "schema": "agoragentic.crawl4ai.citation-map.v1",
        "created_at": created_at,
        "clean_markdown_sha256": clean_markdown_hash,
        "citations": citation_rows,
    }
    source_packet = {
        "schema": "agoragentic.crawl4ai.source-manifest.v1",
        "created_at": created_at,
        "mode": "fixture_no_network" if fixture_mode else "local_bounded_network",
        "capability": capability,
        "limits": asdict(active_limits),
        "crawl4ai": {
            "version": PINNED_CRAWL4AI_VERSION,
            "network_used_by_crawl4ai": False,
            "javascript_executed": False,
            "cookies_used": False,
            "persistent_session_used": False,
        },
        "sources": source_manifest,
    }
    scan_packet = {
        "schema": "agoragentic.crawl4ai.trap-scan-bundle.v1",
        "created_at": created_at,
        "blocked": False,
        "sources": trap_records,
    }
    structured_pages = {
        "schema": "agoragentic.crawl4ai.structured-pages.v1",
        "created_at": created_at,
        "pages": [
            {
                key: value
                for key, value in page.items()
                if key not in {"markdown"}
            }
            for page in pages
        ],
    }
    context_packet = {
        "schema": "agoragentic.micro-ecf.context-packet.v1",
        "packet_id": _stable_id("ctx", {"sources": citation_rows, "capability": capability}),
        "created_at": created_at,
        "scope": "local_public_web_acquisition",
        "agent": {
            "name": "agoragentic-crawl4ai-local-provider",
            "primary_goal": capability,
        },
        "sources": [
            {
                "id": page["source_id"],
                "path": page["url"],
                "type": "public_web",
                "hash": next(
                    source["content_sha256"]
                    for source in source_manifest
                    if source["source_id"] == page["source_id"]
                ),
                "summary": (
                    "Retrieved public page; cleaned content remains in the local evidence bundle. "
                    f"title_sha256={page['title_sha256']}; headings={len(page['headings'])}; links={len(page['links'])}."
                ),
                "citation_id": page["citation_id"],
                "provenance": {
                    "provider": "crawl4ai",
                    "mode": "offline_parse_after_bounded_fetch",
                    "retrieved_at": created_at,
                    "url": page["url"],
                },
            }
            for page in pages
        ],
        "allowed_context": ["public_web"],
        "blocked_context": ["secrets", "private_network", "cloud_metadata", "trap_scanned_content"],
        "citations": [
            {
                "citation_id": row["citation_id"],
                "source_id": row["source_id"],
                "path": row["url"],
                "hash": row["content_sha256"],
                "provenance": {
                    "provider": "crawl4ai",
                    "retrieved_at": created_at,
                },
            }
            for row in citation_rows
        ],
        "export_boundary": {
            "raw_content_exported": False,
            "local_first": True,
            "agent_os_preview_only": True,
        },
    }

    base_artifacts = {
        "clean-markdown.md": clean_markdown.encode("utf-8"),
        "citation-map.json": _json_bytes(citation_map),
        "source-manifest.json": _json_bytes(source_packet),
        "trap-scan.json": _json_bytes(scan_packet),
        "structured-pages.json": _json_bytes(structured_pages),
        "context-packet.json": _json_bytes(context_packet),
    }
    evidence_root = _sha256_text(
        _stable_json({name: _sha256_bytes(content) for name, content in base_artifacts.items()})
    )
    receipt = _receipt(
        capability=capability,
        created_at=created_at,
        status="recorded",
        artifact_names=(*base_artifacts.keys(), "local-receipt.json"),
        evidence_root=evidence_root,
        source_count=len(pages),
    )
    target = _write_artifacts(
        output_dir,
        {**base_artifacts, "local-receipt.json": _json_bytes(receipt)},
    )
    return {
        "status": "recorded",
        "mode": "fixture_no_network" if fixture_mode else "local_bounded_network",
        "capability": capability,
        "source_count": len(pages),
        "output_dir": str(target),
        "evidence_root": evidence_root,
        "spend_usdc": 0,
        "hosted_surface_enabled": False,
        "x402_enabled": False,
    }


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a bounded local Crawl4AI evidence bundle from public URLs or safe fixtures."
    )
    parser.add_argument("--capability", choices=CAPABILITIES, default="cited_web_research")
    parser.add_argument("--url", action="append", dest="urls", default=[])
    parser.add_argument("--fixture-dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-pages", type=int, default=4)
    parser.add_argument("--max-depth", type=int, default=0)
    parser.add_argument("--max-bytes-per-page", type=int, default=500_000)
    parser.add_argument("--max-total-bytes", type=int, default=2_000_000)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--max-redirects", type=int, default=2)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    limits = Limits(
        max_pages=args.max_pages,
        max_depth=args.max_depth,
        max_bytes_per_page=args.max_bytes_per_page,
        max_total_bytes=args.max_total_bytes,
        timeout_seconds=args.timeout_seconds,
        max_redirects=args.max_redirects,
        max_concurrency=1,
    )
    try:
        if args.fixture_dir:
            fetcher = FixtureFetcher(args.fixture_dir)
            urls = args.urls or list(fetcher.seed_urls)
            fixture_mode = True
        else:
            if not args.urls:
                raise PolicyError("--url is required outside fixture mode")
            fetcher = SafeHttpFetcher()
            urls = args.urls
            fixture_mode = False
        result = run_provider(
            capability=args.capability,
            urls=urls,
            output_dir=args.output,
            fetcher=fetcher,
            renderer=Crawl4AIRenderer(),
            limits=limits,
            fixture_mode=fixture_mode,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    except TrapScanBlocked as exc:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "reason": "trap_scan_blocked",
                    "output_dir": str(exc.output_dir),
                    "spend_usdc": 0,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 3
    except ProviderError as exc:
        print(json.dumps({"status": "error", "error": type(exc).__name__, "message": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
