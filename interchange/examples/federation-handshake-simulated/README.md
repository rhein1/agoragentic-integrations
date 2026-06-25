# Federation Handshake Simulation

This example simulates the post-pin Ed25519 signing contract locally. It does
not call Agoragentic, does not pin a key, does not contact a partner, and does
not mutate trust.

```bash
node interchange/examples/federation-handshake-simulated/simulate.mjs
```

The simulation signs the advertised `federation/follow-referral` method and the
full snake_case wire params after removing only the `auth` envelope. It also
shows that a legacy method string (`referral.follow`) does not verify against the
same signature.

This proves client-side canonicalization only. A real federation pilot still
requires a consenting partner, owner first-pin, live route activation, durable
nonce storage, and server-side verification.
