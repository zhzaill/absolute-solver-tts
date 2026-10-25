# Security policy

## Reporting

Do not open a public issue for a credential leak, authentication bypass, path
traversal, arbitrary file load, or remote code execution finding.

Report privately to the repository owner through GitHub's private security
advisory feature.

## Deployment baseline

- Bind both GPT-SoVITS upstream and the gateway to `127.0.0.1`.
- Use an SSH tunnel for remote access.
- If a non-loopback bind is unavoidable, set a long random `GATEWAY_API_KEY`.
- Keep `gateway_state.json`, model weights, reference audio, logs, and environment
  files outside version control.
- Run the gateway under a dedicated operating-system account.
- Treat voice checkpoints as untrusted input. Prefer formats loaded by the upstream
  project rather than custom pickle loaders.

The gateway rejects non-loopback startup without a key and validates runtime asset
paths against the configured GPT-SoVITS root.

## Secret handling

The repository includes `scripts/check-secrets.ps1`. It is a guardrail, not a
replacement for reviewing staged files and provider-side secret scanning.
