# Architecture

## Goals

The system separates four concerns that are often conflated:

1. **Synthesis** is performed by GPT-SoVITS.
2. **Policy and voice selection** are owned by the gateway.
3. **Delivery** is owned by the client or DSH plugin.
4. **Verification** checks both signal validity and spoken content.

This separation keeps model weights out of the client and lets one gateway serve
DSH, OpenAI-compatible applications, and shell scripts.

## Components

### GPT-SoVITS upstream

The independently installed `api_v2.py` listens on loopback port `9880`.
The gateway does not vendor its code or weights.

### OpenAI-compatible gateway

The gateway owns a small JSON state file that maps a stable voice ID to:

- GPT `.ckpt`
- SoVITS `.pth`
- reference audio
- exact reference transcript
- reference language
- default synthesis language
- speed

The state file is runtime data, not source code. It is ignored by Git.

The gateway exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness and upstream reachability |
| `GET` | `/` | Service summary |
| `GET` | `/v1/models` | OpenAI-compatible model list |
| `GET` | `/v1/audio/voices` | Registered voices |
| `POST` | `/v1/audio/voices` | Create or replace a voice |
| `POST` | `/v1/audio/voices/default` | Set the default voice |
| `DELETE` | `/v1/audio/voices/{id}` | Remove a voice |
| `POST` | `/v1/audio/speech` | Synthesize speech |
| `GET` | `/admin/upstream/status` | Upstream process status |
| `POST` | `/admin/upstream/start` | Start upstream when configured |
| `POST` | `/admin/upstream/stop` | Stop the managed upstream |
| `POST` | `/admin/upstream/load` | Load GPT/SoVITS weights |

When `GATEWAY_API_KEY` is set, non-health endpoints require:

```http
Authorization: Bearer <key>
```

or:

```http
X-API-Key: <key>
```

### DSH plugin

The plugin is a provider, not a second source of conversation or playback state.

It contributes:

- `tts_speak`: synthesize a bounded segment of speech.
- `tts_status`: report the effective endpoint and upstream state.
- `/dsh-tts/audio?id=...`: serve the cached WAV from the DSH web origin.
- `/dsh-tts/status`: expose non-secret runtime status.
- A voice contract in the system prompt.

The browser cannot treat a direct fetch to the gateway as same-origin. The plugin
stores the WAV under a content hash and returns a relative same-origin URL instead.

Connection resolution is provider-neutral:

1. `speechUrl` is used verbatim when supplied.
2. Otherwise `baseUrl` may be an origin, `/v1` root, path-prefixed root, or the
   final speech URL.
3. Auth may use `Authorization: Bearer`, a custom header, or a raw key.
4. Static routing headers and provider-specific body fields can be supplied.
5. Status output reports only redacted endpoints and header names.

### Terminal client

`plugin/bin/tts.mjs` drives the same client code without DSH:

```powershell
node plugin/bin/tts.mjs --status
node plugin/bin/tts.mjs "要合成的文本"
node plugin/bin/tts.mjs --check
```

## Language resolution

OpenAI's speech schema does not define `text_lang` or `prompt_lang`. GPT-SoVITS
does require them.

The gateway resolves the text language in this order:

1. explicit request `text_lang`
2. best-effort script detection
3. voice default `text_lang`

The reference language is independent:

1. explicit request `prompt_lang`
2. voice default `ref_lang`

A Chinese reference with Japanese target text is a valid cross-lingual pairing:
the reference anchors voice identity, while `text_lang` selects the text frontend.

Script detection is intentionally simple:

- kana -> `ja`
- Han characters -> `zh`
- Latin letters -> `en`

Pure Han text is ambiguous between Chinese and Japanese. Callers that know the
language must declare it.

## Verification model

There are three independent gates:

| Gate | Question | Typical method |
|---|---|---|
| Signal integrity | Is there non-broken audio? | WAV header, duration, clipping, noise metrics |
| Content fidelity | Did it say the intended sentence? | ASR round-trip or human listening |
| Voice identity | Does it sound like the intended speaker? | Reference comparison and human listening |

A valid WAV proves only the first gate. It cannot prove the other two.

ASR round-trip is also bounded. It can catch a sentence-level language failure,
but it may disagree on punctuation, number normalization, acronym pronunciation,
and near-homophones. Treat word-level differences as review signals, not automatic
certification.

## Reproducibility

GPT-SoVITS sampling is stochastic unless a seed is fixed. Even with a fixed seed,
GPU reduction order can produce tiny floating-point differences. In measured runs,
the WAV length and header were identical while samples differed by at most one
least-significant bit.

Therefore:

- pin a seed for regression checks;
- compare transcribed content, not file hashes;
- treat byte-for-byte equality as an invalid acceptance criterion.
