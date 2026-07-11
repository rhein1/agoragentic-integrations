# demo — moves no real funds; standard-library workflow shaped like a minimal LangGraph adapter.
import base64, hashlib, hmac, json
from urllib.parse import urlsplit

class SafetyError(Exception):
    pass

def enc(data):
    raw = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def dec(text):
    return json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))

def sign(claims, key, typ, kid):
    head = enc({"alg": "HS256", "typ": typ, "kid": kid})
    body = enc(claims)
    sig = hmac.new(key, f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"

def verify(token, key, typ, kid):
    try:
        head, body, supplied = token.split(".")
        actual = hmac.new(key, f"{head}.{body}".encode(), hashlib.sha256).digest()
        supplied = base64.urlsafe_b64decode(supplied + "=" * (-len(supplied) % 4))
        meta = dec(head)
        if not hmac.compare_digest(actual, supplied):
            raise SafetyError("bad signature")
        if meta != {"alg": "HS256", "kid": kid, "typ": typ}:
            raise SafetyError("wrong token type or key id")
        return dec(body)
    except SafetyError:
        raise
    except Exception as exc:
        raise SafetyError("malformed token") from exc

def digest(value):
    if not isinstance(value, str):
        value = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode()).hexdigest()

def request_digest(method, url, body):
    parsed = urlsplit(url)
    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    return digest(f"{method.upper()}\n{target}\n{body}")

def challenge_digest(token):
    return digest(token)

def clean_headers(headers):
    denied = {
        "authorization", "idempotency-key", "x-idempotency-key",
        "payer", "x-payer", "payment", "x-payment",
    }
    result = {}
    for name, value in headers.items():
        low = name.lower()
        if "\r" in name or "\n" in name or ":" in name:
            raise SafetyError("invalid header name")
        if "\r" in str(value) or "\n" in str(value):
            raise SafetyError("invalid header value")
        if low in denied or low.startswith(("payment-", "x-payment-", "x402-", "x-402-")):
            raise SafetyError("reserved header")
        result[name] = str(value)
    return result

def validate_url(url, origin, loopback_demo=False):
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password:
        raise SafetyError("absolute URL required")
    actual = f"{parsed.scheme}://{parsed.netloc}"
    if actual != origin:
        raise SafetyError("unexpected origin")
    loopback = parsed.hostname in {"127.0.0.1", "::1", "localhost"}
    if parsed.scheme != "https" and not (loopback_demo and parsed.scheme == "http" and loopback):
        raise SafetyError("unsafe scheme")
    return url

def validate_time(claims, now):
    if type(claims.get("iat")) not in (int, float):
        raise SafetyError("invalid iat")
    if type(claims.get("exp")) not in (int, float):
        raise SafetyError("invalid exp")
    if not claims["iat"] <= now < claims["exp"]:
        raise SafetyError("expired challenge")

def validate_challenge(token, key, kid, issuer, payer, req, idem, now):
    claims = verify(token, key, "x402-challenge+jws", kid)
    required = {"type", "issuer", "payer", "request", "idempotency",
                "amount", "asset", "payee", "iat", "exp", "challenge_id"}
    if set(claims) != required:
        raise SafetyError("incomplete challenge")
    if claims["type"] != "x402" or claims["issuer"] != issuer:
        raise SafetyError("wrong challenge issuer")
    if claims["payer"] != payer or claims["request"] != req:
        raise SafetyError("challenge identity mismatch")
    if claims["idempotency"] != idem:
        raise SafetyError("challenge idempotency mismatch")
    if not isinstance(claims["amount"], int) or claims["amount"] <= 0:
        raise SafetyError("invalid amount")
    if not claims["asset"] or not claims["payee"]:
        raise SafetyError("invalid payment terms")
    validate_time(claims, now)
    return claims

class FakeServer:
    def __init__(self, store, key, kid, issuer, clock):
        self.store = store
        self.key = key
        self.kid = kid
        self.issuer = issuer
        self.clock = clock
        self.writes = 0
        self.fail_once = False
        self.redirect = False
        self.target_credentials = []
    def issue(self, payer, req, idem):
        claims = {"type": "x402", "issuer": self.issuer, "payer": payer,
                  "request": req, "idempotency": idem, "amount": 7,
                  "asset": "DEMO", "payee": "demo-payee", "iat": self.clock(),
                  "exp": self.clock() + 60, "challenge_id": digest(idem)[:16]}
        token = sign(claims, self.key, "x402-challenge+jws", self.kid)
        self.store.setdefault("issued", {})[idem] = token
        return token
    def send(self, record):
        if record["redirect"] != "error":
            raise SafetyError("redirect policy required")
        if not urlsplit(record["url"]).netloc:
            raise SafetyError("transport URL not absolute")
        headers = {k.lower(): v for k, v in record["headers"].items()}
        idem = headers["idempotency-key"]
        req = request_digest(record["method"], record["url"], record["body"])
        binding = self.store.setdefault("bindings", {}).get(idem)
        auth = headers.get("payment-authorization")
        if binding:
            if binding["request"] != req:
                raise SafetyError("idempotency request mismatch")
            if not auth:
                raise SafetyError("authorization missing for bound request")
        if not auth:
            return {"status": 402, "challenge": self.issue(headers["payer"], req, idem)}
        claims = verify(auth, self.key, "x402-authorization+jws", self.kid)
        issued = self.store.setdefault("issued", {}).get(idem)
        if not issued or challenge_digest(issued) != claims.get("challenge"):
            raise SafetyError("authorization names unissued challenge")
        challenge = validate_challenge(
            issued, self.key, self.kid, self.issuer, claims.get("payer"),
            req, idem, self.clock())
        expected = {"payer": claims.get("payer"), "request": req,
                    "idempotency": idem, "challenge": challenge_digest(issued)}
        if any(claims.get(k) != v for k, v in expected.items()):
            raise SafetyError("authorization binding mismatch")
        if binding and binding["authorization"] != digest(auth):
            raise SafetyError("authorization changed")
        if self.redirect:
            return {"status": 302, "location": "https://evil.invalid/"}
        if self.fail_once:
            self.fail_once = False
            return {"status": 503}
        cached = self.store.setdefault("cache", {}).get(idem)
        if cached:
            return cached
        receipt_claims = dict(expected, authorization=digest(auth), result="executed")
        receipt = sign(receipt_claims, self.key, "x402-receipt+jws", self.kid)
        response = {"status": 200, "body": {"node": "execute", "ok": True},
                    "receipt": receipt}
        self.store["cache"][idem] = response
        self.writes += 1
        return response

class Adapter:
    def __init__(self, store, transport, key, kid, issuer, origin, payer, clock):
        self.store = store
        self.transport = transport
        self.key = key
        self.kid = kid
        self.issuer = issuer
        self.origin = origin
        self.payer = payer
        self.clock = clock
    def execute(self, url, body, idem, headers, pay):
        url = validate_url(url, self.origin, self.origin.startswith("http://"))
        headers = clean_headers(headers)
        req = request_digest("POST", url, body)
        binding = self.store.setdefault("bindings", {}).get(idem)
        if binding and binding["request"] != req:
            raise SafetyError("local idempotency mismatch")
        base = dict(headers, payer=self.payer, **{"idempotency-key": idem})
        if binding:
            auth = binding["token"]
        else:
            first = self.transport.send({"method": "POST", "url": url, "body": body,
                                         "headers": base, "redirect": "error"})
            if first["status"] != 402:
                raise SafetyError("expected initial 402")
            challenge = first["challenge"]
            validate_challenge(challenge, self.key, self.kid, self.issuer,
                               self.payer, req, idem, self.clock())
            auth = pay(challenge, req, idem, self.payer)
            auth_claims = verify(auth, self.key, "x402-authorization+jws", self.kid)
            binding = {"request": req, "challenge": challenge_digest(challenge),
                       "authorization": digest(auth), "payer": self.payer,
                       "state": "authorized", "token": auth}
            if auth_claims.get("challenge") != binding["challenge"]:
                raise SafetyError("payer changed challenge")
            self.store.setdefault("bindings", {})[idem] = binding
        trusted = dict(base, **{"payment-authorization": auth})
        for attempt in range(2):
            result = self.transport.send({"method": "POST", "url": url, "body": body,
                                          "headers": trusted, "redirect": "error"})
            if result["status"] == 402:
                raise SafetyError("repeated 402 after authorization")
            if 300 <= result["status"] < 400:
                raise SafetyError("redirect blocked")
            if result["status"] >= 500 and attempt == 0:
                continue
            if result["status"] // 100 != 2:
                raise SafetyError("execution failed")
            receipt = result.get("receipt")
            if not receipt:
                raise SafetyError("missing receipt")
            claims = verify(receipt, self.key, "x402-receipt+jws", self.kid)
            expected = {"payer": self.payer, "request": req, "idempotency": idem,
                        "challenge": binding["challenge"],
                        "authorization": binding["authorization"]}
            if any(claims.get(k) != v for k, v in expected.items()):
                raise SafetyError("receipt mismatch")
            binding["state"] = "complete"
            return result
        raise SafetyError("retry exhausted")

def main():
    now = [1000]
    clock = lambda: now[0]
    key = b"offline-demo-anchor"
    store = {"issued": {}, "bindings": {}, "cache": {}}
    server = FakeServer(store, key, "demo-k1", "demo-issuer", clock)
    pays = [0]
    def pay(challenge, req, idem, payer):
        pays[0] += 1
        claims = {"payer": payer, "request": req, "idempotency": idem,
                  "challenge": challenge_digest(challenge)}
        return sign(claims, key, "x402-authorization+jws", "demo-k1")
    adapter = Adapter(store, server, key, "demo-k1", "demo-issuer",
                      "http://127.0.0.1", "demo-payer", clock)
    url = "http://127.0.0.1/run?q=one"
    result = adapter.execute(url, "{}", "happy", {}, pay)
    assert result["body"]["ok"] and pays[0] == 1 and server.writes == 1
    server2 = FakeServer(store, key, "demo-k1", "demo-issuer", clock)
    adapter2 = Adapter(store, server2, key, "demo-k1", "demo-issuer",
                       "http://127.0.0.1", "demo-payer", clock)
    before = (pays[0], server2.writes)
    adapter2.execute(url, "{}", "happy", {}, pay)
    assert (pays[0] - before[0], server2.writes - before[1]) == (0, 0)
    server.fail_once = True
    adapter.execute(url, "{}", "retry", {}, pay)
    assert pays[0] == 2
    failures = [
        lambda: adapter.execute(url, "x", "happy", {}, pay),
        lambda: adapter.execute(url + "2", "{}", "happy", {}, pay),
        lambda: adapter.execute(url, "{}", "inject", {"AuThOrIzAtIoN": "x"}, pay),
        lambda: adapter.execute("http://evil.invalid/run", "{}", "origin", {}, pay),
    ]
    old = pays[0]
    for case in failures:
        try:
            case()
            raise AssertionError("expected safety failure")
        except SafetyError:
            pass
    assert pays[0] == old
    expired_store = {"issued": {}, "bindings": {}, "cache": {}}
    expired_server = FakeServer(expired_store, key, "demo-k1", "demo-issuer",
                                lambda: 1000)
    now[0] = 1060
    expired_adapter = Adapter(expired_store, expired_server, key, "demo-k1",
                              "demo-issuer", "http://127.0.0.1",
                              "demo-payer", clock)
    before = (pays[0], expired_server.writes, len(expired_store["cache"]))
    try:
        expired_adapter.execute(url, "{}", "expired", {}, pay)
        raise AssertionError("expected expiry")
    except SafetyError:
        pass
    assert before == (pays[0], expired_server.writes, len(expired_store["cache"]))
    print("AGOS_RUNTIME_OK")

if __name__ == "__main__":
    main()
