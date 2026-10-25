# Contributing

## Before opening a pull request

1. Run `.\scripts\run-tests.ps1`.
2. Run `.\scripts\check-secrets.ps1`.
3. Confirm that no generated WAV, checkpoint, reference recording, runtime state,
   private address, credential, or third-party character asset is staged.
4. Describe changes to the wire protocol, security boundary, or asset policy
   explicitly.

## Style

- Keep gateway code compatible with Python 3.10 or newer.
- Keep plugin runtime dependencies at zero unless a dependency removes substantial
  complexity.
- Treat DSH as the authority for conversation and session state.
- Treat the local audio device queue as the authority for playback completion.
- Keep OpenAI-compatible behavior explicit; document any extension field.
- Do not weaken authentication or path validation for convenience.

## Commit messages

Use a short imperative subject. Examples:

```text
gateway: reject non-loopback startup without auth
plugin: preserve inferred-language provenance
docs: document reference transcript verification
```

## Voice assets

Do not submit model weights or reference recordings unless the repository owner has
explicitly changed the project policy and the rights for redistribution are
documented. A code contribution must not contain an asset merely because it works
locally.
