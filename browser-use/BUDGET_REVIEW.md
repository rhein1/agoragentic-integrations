# Browser staging byte-bound regression

The aggregate ceiling is enforced before every write from the already verified source descriptor, not after copying the next whole file. Descriptor size is checked against the remaining allowance before reading; a bounded one-byte overrun probe catches growth without writing overflow bytes. Existing post-read identity comparisons, full-tree verification, runtime pins, cancellation, and private-copy cleanup remain in force.

Run both provider-free suites with:

```sh
python -m unittest discover -s browser-use -p 'test_*proof.py'
```

The six added tests include an eight-byte aggregate limit with two six-byte files (six bytes copied before refusal, not twelve), exact-boundary and empty-file acceptance, refusal before read, growth during copy, post-copy identity changes, and invalid budgets. The workflow runs these with the existing 15 boundary tests and real-browser qualification on the declared Ubuntu 24.04 / CPython 3.12.10 target. Local new-test execution used Linux / Python 3.13.5; it is not a new target-platform or real-browser qualification claim.

The private copy is not an OS sandbox or protection from a malicious same-user/privileged process. No target URL, provider, deployment, payment, or custody authority is added.
