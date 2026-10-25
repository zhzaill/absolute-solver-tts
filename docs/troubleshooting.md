# Troubleshooting

## `--status` says unreachable

Check:

```powershell
Invoke-RestMethod http://127.0.0.1:18080/healthz
Get-NetTCPConnection -LocalPort 18080 -State Listen
```

If the gateway is remote, confirm the SSH forward is still alive.

If `--status` says `reachable` but not `healthy`, the host answered on a path that
is not the expected `/healthz`. Set `healthUrl` or `DSH_TTS_HEALTH_URL` explicitly.
This does not necessarily mean synthesis is broken.

## A reverse proxy or custom provider is used

`baseUrl` may include a path prefix. If the provider does not append
`/audio/speech`, set the exact `speechUrl`. If it uses `api-key` instead of
Bearer auth, set:

```yaml
authHeader: api-key
authScheme: ""
```

The plugin never prints the key. Use `tts_status` to inspect the selected endpoint,
auth header name and extra header names.

## `401 Invalid API key`

Set the same `GATEWAY_API_KEY` on both sides:

```powershell
$env:GATEWAY_API_KEY = "<value>"
```

For DSH, use the plugin `apiKey` field or `DSH_TTS_API_KEY`.

Never put a real key in `config/plugin.example.yml`.

## `503` upstream not running

The gateway can reach its own port but not GPT-SoVITS port `9880`.
Start the installed `api_v2.py` and retry `/healthz`.

## Audio exists but sounds like a different sentence

Start with the text language. A Chinese frontend reading Japanese text can drop
kana and invent a shorter Chinese sentence while producing technically valid audio.

Use:

```json
{
  "text_lang": "ja",
  "prompt_lang": "zh"
}
```

`prompt_lang` describes the reference recording, not the requested text.

## Voice identity is unstable or noisy

Check that `ref_text` exactly matches the words in `ref_audio`. This is a semantic
check; file existence and non-empty text are not enough.

Also check:

- reference audio contains one clear speaker;
- there is no background music or clipping;
- weights pair the intended GPT and SoVITS checkpoints;
- the selected voice ID is the one sent by the client.

## Windows console shows garbled text

The terminal code page may not render UTF-8. Prefer escaped JSON or write reports to
a UTF-8 file. Do not infer the cause from mojibake; inspect the original bytes.

## `tts.cmd` executes fragments of comments

`.cmd` files require CRLF line endings. This repository enforces CRLF through
`.gitattributes`. If a file was converted to LF, restore CRLF.

Also remember that `#` is not a comment marker in `cmd.exe`. A command such as:

```text
tts "hello" # note
```

passes `#` and `note` as extra arguments. The CLI rejects multiple positional
arguments rather than silently speaking them.

## Browser does not play the returned audio

The plugin returns a DSH same-origin URL. Direct gateway URLs may be blocked by CORS
or mixed-content policy. Confirm the plugin's `/dsh-tts/audio` route is mounted.

The interactive player is registered by the root-level `dsh-tts-browser` bundle through
`tool.call.toolview` for key `tts_speak`, using the result's `presentationMeta`.
It does not depend on Markdown links or conversation DOM scanning.
Automatic playback can still be blocked by the browser's user-activation policy;
the native controls remain available for a click.

## Streaming implementation plays too fast or slow

GPT-SoVITS output in the measured deployment is 32 kHz. OpenAI-style PCM streaming
clients may assume 24 kHz because the protocol carries no sample-rate field.

Any SSE implementation must resample to the rate expected by the client. Do not
label 32 kHz PCM as 24 kHz.

## Fixed seed still produces different bytes

Compare content and audio shape, not hashes. GPU nondeterminism can produce a
one-LSB difference even with identical headers and sample counts.

## Pipe `|` or angle brackets behave strangely in PowerShell

`<` and `>` are redirection operators. Quote real file paths and never use angle
brackets as shell placeholders.

## Non-loopback gateway exits at startup

This is intentional. Either bind to loopback or set `GATEWAY_API_KEY`.
