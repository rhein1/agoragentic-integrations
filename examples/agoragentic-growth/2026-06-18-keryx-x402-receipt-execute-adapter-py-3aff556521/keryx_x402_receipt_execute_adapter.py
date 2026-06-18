#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import hmac
import json
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Tuple


class AdapterError(Exception):
    pass


class ReceiptValidationError(AdapterError):
    pass


class PaymentRequiredError(AdapterError):
    def __init__(self, message: str, challenge: Mapping[str, Any]) -> None:
        super().__init__(message)
        self.challenge = dict(challenge)


class RemoteExecutionError(AdapterError):
    def __init__(self, status_code: int, message: str, payload: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(f"remote execution failed with status {status_code}: {message}")
        self.status_code = status_code
        self.payload = dict(payload or {})


class RetryableRemoteError(RemoteExecutionError):
    pass


class NonRetryableRemoteError(RemoteExecutionError):
    pass


@dataclass(frozen=True)
class X402Receipt:
    receipt_id: str
    payer: str
    payee: str
    asset: str
    amount: str
    nonce: str
    issued_at: int
    expires_at: int
    challenge_id: str
    execute_target: str
    signature: str

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "X402Receipt":
        required = [
            "receipt_id",
            "payer",
            "payee",
            "asset",
            "amount",
            "nonce",
            "issued_at",
            "expires_at",
            "challenge_id",
            "execute_target",
            "signature",
        ]
        missing = [k for k in required if k not in data]
        if missing:
            raise ReceiptValidationError(f"missing receipt fields: {', '.join(missing)}")
        return cls(
            receipt_id=str(data["receipt_id"]),
            payer=str(data["payer"]),
            payee=str(data["payee"]),
            asset=str(data["asset"]),
            amount=str(data["amount"]),
            nonce=str(data["nonce"]),
            issued_at=int(data["issued_at"]),
            expires_at=int(data["expires_at"]),
            challenge_id=str(data["challenge_id"]),
            execute_target=str(data["execute_target"]),
            signature=str(data["signature"]),
        )

    def canonical_payload(self) -> str:
        parts = [
            self.receipt_id,
            self.payer,
            self.payee,
            self.asset,
            self.amount,
            self.nonce,
            str(self.issued_at),
            str(self.expires_at),
            self.challenge_id,
            self.execute_target,
        ]
        return "|".join(parts)


@dataclass
class ExecuteResult:
    ok: bool
    status_code: int
    output: Any
    attempt_count: int
    receipt_id: str
    challenge_id: str
    trace: List[str] = field(default_factory=list)


class X402ReceiptSigner:
    def __init__(self, shared_secret: str) -> None:
        if not shared_secret:
            raise ValueError("shared_secret must be non-empty")
        self._secret = shared_secret.encode("utf-8")

    def sign(self, receipt_payload: str) -> str:
        digest = hmac.new(self._secret, receipt_payload.encode("utf-8"), hashlib.sha256).hexdigest()
        return digest

    def verify(self, receipt_payload: str, signature: str) -> bool:
        expected = self.sign(receipt_payload)
        return hmac.compare_digest(expected, signature)


class ReceiptCache:
    def __init__(self) -> None:
        self._used: MutableMapping[str, float] = {}

    def remember(self, receipt_id: str, expires_at: int) -> None:
        self._used[receipt_id] = float(expires_at)

    def was_used(self, receipt_id: str, now_ts: Optional[int] = None) -> bool:
        now_value = float(now_ts if now_ts is not None else int(time.time()))
        expiry = self._used.get(receipt_id)
        if expiry is None:
            return False
        if expiry < now_value:
            del self._used[receipt_id]
            return False
        return True


class ReceiptValidator:
    def __init__(self, signer: X402ReceiptSigner, expected_payee: str, replay_cache: Optional[ReceiptCache] = None) -> None:
        self.signer = signer
        self.expected_payee = expected_payee
        self.replay_cache = replay_cache or ReceiptCache()

    def validate(
        self,
        raw_receipt: Mapping[str, Any],
        *,
        required_target: str,
        now_ts: Optional[int] = None,
    ) -> X402Receipt:
        receipt = X402Receipt.from_mapping(raw_receipt)
        now_value = int(now_ts if now_ts is not None else time.time())

        if receipt.payee != self.expected_payee:
            raise ReceiptValidationError(f"unexpected payee: {receipt.payee}")
        if receipt.execute_target != required_target:
            raise ReceiptValidationError(
                f"receipt target mismatch: expected {required_target}, got {receipt.execute_target}"
            )
        if receipt.expires_at <= now_value:
            raise ReceiptValidationError("receipt expired")
        if receipt.issued_at > now_value + 300:
            raise ReceiptValidationError("receipt issued_at is too far in the future")
        if self.replay_cache.was_used(receipt.receipt_id, now_value):
            raise ReceiptValidationError("receipt replay detected")
        if not self.signer.verify(receipt.canonical_payload(), receipt.signature):
            raise ReceiptValidationError("invalid receipt signature")

        self.replay_cache.remember(receipt.receipt_id, receipt.expires_at)
        return receipt


class BackoffPolicy:
    def __init__(self, max_attempts: int = 4, base_delay_s: float = 0.1, jitter_s: float = 0.05) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        self.max_attempts = max_attempts
        self.base_delay_s = base_delay_s
        self.jitter_s = jitter_s

    def delay_for_attempt(self, attempt_number: int) -> float:
        raw = self.base_delay_s * (2 ** max(0, attempt_number - 1))
        if self.jitter_s <= 0:
            return raw
        return raw + random.uniform(0, self.jitter_s)


class KeryxTransport:
    def get_payment_challenge(self, tool_name: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        raise NotImplementedError

    def settle_payment(self, challenge: Mapping[str, Any]) -> Mapping[str, Any]:
        raise NotImplementedError

    def execute(
        self,
        tool_name: str,
        payload: Mapping[str, Any],
        receipt: Mapping[str, Any],
    ) -> Tuple[int, Mapping[str, Any]]:
        raise NotImplementedError


class KeryxX402Adapter:
    def __init__(
        self,
        transport: KeryxTransport,
        validator: ReceiptValidator,
        *,
        backoff: Optional[BackoffPolicy] = None,
    ) -> None:
        self.transport = transport
        self.validator = validator
        self.backoff = backoff or BackoffPolicy()

    def execute(self, tool_name: str, payload: Mapping[str, Any]) -> ExecuteResult:
        trace: List[str] = [f"begin execute tool={tool_name}"]
        challenge = self.transport.get_payment_challenge(tool_name, payload)
        if not challenge.get("payment_required", True):
            raise AdapterError("transport must provide an x402 challenge for this sample adapter")

        trace.append(f"received challenge id={challenge.get('challenge_id')}")
        receipt = self.transport.settle_payment(challenge)
        trace.append(f"received receipt id={receipt.get('receipt_id')}")

        self.validator.validate(receipt, required_target=tool_name)
        trace.append("receipt validated")

        last_error: Optional[Exception] = None
        for attempt in range(1, self.backoff.max_attempts + 1):
            try:
                trace.append(f"attempt {attempt} execute")
                status_code, response = self.transport.execute(tool_name, payload, receipt)

                if status_code == 200:
                    trace.append("execute succeeded")
                    return ExecuteResult(
                        ok=True,
                        status_code=status_code,
                        output=response.get("result"),
                        attempt_count=attempt,
                        receipt_id=str(receipt["receipt_id"]),
                        challenge_id=str(receipt["challenge_id"]),
                        trace=trace,
                    )

                if status_code == 402:
                    trace.append("execute returned 402, refreshing receipt")
                    challenge = response.get("challenge") or self.transport.get_payment_challenge(tool_name, payload)
                    receipt = self.transport.settle_payment(challenge)
                    self.validator.validate(receipt, required_target=tool_name)
                    trace.append(f"refreshed receipt id={receipt.get('receipt_id')}")
                    last_error = PaymentRequiredError("payment required during execute", challenge)
                elif status_code in (408, 409, 423, 425, 429, 500, 502, 503, 504):
                    message = str(response.get("error", "transient upstream failure"))
                    last_error = RetryableRemoteError(status_code, message, response)
                    trace.append(f"retryable error status={status_code} error={message}")
                else:
                    message = str(response.get("error", "non-retryable upstream failure"))
                    raise NonRetryableRemoteError(status_code, message, response)

                if attempt >= self.backoff.max_attempts:
                    break

                sleep_s = self.backoff.delay_for_attempt(attempt)
                trace.append(f"backoff sleep={sleep_s:.3f}s")
                time.sleep(sleep_s)

            except RetryableRemoteError as exc:
                last_error = exc
                trace.append(str(exc))
                if attempt >= self.backoff.max_attempts:
                    break
                sleep_s = self.backoff.delay_for_attempt(attempt)
                trace.append(f"backoff sleep={sleep_s:.3f}s")
                time.sleep(sleep_s)

        if last_error is None:
            raise AdapterError("execution failed without a captured error")
        raise last_error


class FakeKeryxTransport(KeryxTransport):
    def __init__(
        self,
        signer: X402ReceiptSigner,
        *,
        payee: str = "keryx://sample-payee",
        asset: str = "USD",
        price: str = "0.01",
        failure_script: Optional[List[int]] = None,
    ) -> None:
        self.signer = signer
        self.payee = payee
        self.asset = asset
        self.price = price
        self.failure_script = list(failure_script or [503, 200])
        self._receipt_counter = 0
        self._execute_counter = 0

    def get_payment_challenge(self, tool_name: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        return {
            "payment_required": True,
            "challenge_id": f"chal_{uuid.uuid4().hex[:12]}",
            "tool_name": tool_name,
            "payee": self.payee,
            "asset": self.asset,
            "amount": self.price,
            "payload_digest": self._digest_payload(payload),
        }

    def settle_payment(self, challenge: Mapping[str, Any]) -> Mapping[str, Any]:
        self._receipt_counter += 1
        now_ts = int(time.time())
        receipt = {
            "receipt_id": f"rcpt_{self._receipt_counter:04d}",
            "payer": "demo-client",
            "payee": challenge["payee"],
            "asset": challenge["asset"],
            "amount": challenge["amount"],
            "nonce": uuid.uuid4().hex,
            "issued_at": now_ts,
            "expires_at": now_ts + 120,
            "challenge_id": challenge["challenge_id"],
            "execute_target": challenge["tool_name"],
        }
        payload = X402Receipt.from_mapping({**receipt, "signature": "placeholder"}).canonical_payload()
        receipt["signature"] = self.signer.sign(payload)
        return receipt

    def execute(
        self,
        tool_name: str,
        payload: Mapping[str, Any],
        receipt: Mapping[str, Any],
    ) -> Tuple[int, Mapping[str, Any]]:
        self._execute_counter += 1
        if not self.failure_script:
            code = 200
        else:
            code = self.failure_script.pop(0)

        if code == 200:
            return (
                200,
                {
                    "result": {
                        "tool": tool_name,
                        "input": dict(payload),
                        "receipt_id": receipt["receipt_id"],
                        "message": "tool execution completed",
                        "attempt": self._execute_counter,
                    }
                },
            )
        if code == 402:
            return (
                402,
                {
                    "error": "receipt expired upstream",
                    "challenge": self.get_payment_challenge(tool_name, payload),
                },
            )
        if code in (408, 409, 423, 425, 429, 500, 502, 503, 504):
            return (code, {"error": f"transient failure {code}", "retryable": True})
        return (code, {"error": f"hard failure {code}", "retryable": False})

    @staticmethod
    def _digest_payload(payload: Mapping[str, Any]) -> str:
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()


def _self_test_success_after_retry() -> None:
    signer = X402ReceiptSigner("demo-shared-secret")
    validator = ReceiptValidator(signer, expected_payee="keryx://sample-payee")
    transport = FakeKeryxTransport(signer, failure_script=[503, 200])
    adapter = KeryxX402Adapter(transport, validator, backoff=BackoffPolicy(max_attempts=3, base_delay_s=0.01, jitter_s=0.0))

    result = adapter.execute("weather.lookup", {"city": "Berlin"})
    assert result.ok is True
    assert result.status_code == 200
    assert result.attempt_count == 2
    assert result.output["tool"] == "weather.lookup"


def _self_test_receipt_refresh() -> None:
    signer = X402ReceiptSigner("demo-shared-secret")
    validator = ReceiptValidator(signer, expected_payee="keryx://sample-payee")
    transport = FakeKeryxTransport(signer, failure_script=[402, 200])
    adapter = KeryxX402Adapter(transport, validator, backoff=BackoffPolicy(max_attempts=3, base_delay_s=0.01, jitter_s=0.0))

    result = adapter.execute("doc.summarize", {"text": "hello"})
    assert result.ok is True
    assert result.attempt_count == 2
    assert result.output["tool"] == "doc.summarize"


def _self_test_replay_blocked() -> None:
    signer = X402ReceiptSigner("demo-shared-secret")
    validator = ReceiptValidator(signer, expected_payee="keryx://sample-payee")
    transport = FakeKeryxTransport(signer)
    challenge = transport.get_payment_challenge("math.add", {"a": 1, "b": 2})
    receipt = transport.settle_payment(challenge)

    validator.validate(receipt, required_target="math.add")
    try:
        validator.validate(receipt, required_target="math.add")
    except ReceiptValidationError as exc:
        assert "replay" in str(exc)
        return
    raise AssertionError("expected replay detection")


def main(argv: List[str]) -> int:
    _self_test_success_after_retry()
    _self_test_receipt_refresh()
    _self_test_replay_blocked()

    signer = X402ReceiptSigner("demo-shared-secret")
    validator = ReceiptValidator(signer, expected_payee="keryx://sample-payee")
    transport = FakeKeryxTransport(signer, failure_script=[503, 402, 200])
    adapter = KeryxX402Adapter(
        transport,
        validator,
        backoff=BackoffPolicy(max_attempts=4, base_delay_s=0.02, jitter_s=0.0),
    )

    payload = {"query": "latency budget", "top_k": 3}
    result = adapter.execute("search.docs", payload)
    print(json.dumps(
        {
            "ok": result.ok,
            "status_code": result.status_code,
            "attempt_count": result.attempt_count,
            "receipt_id": result.receipt_id,
            "challenge_id": result.challenge_id,
            "output": result.output,
            "trace": result.trace,
        },
        indent=2,
        sort_keys=True,
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
