# Deployment

## Prerequisites

- An installed GPT-SoVITS runtime with `api_v2.py`
- Python 3.10 or newer
- Node.js 22.19 or newer for DSH and the terminal client
- A compatible GPT and SoVITS checkpoint
- A reference WAV and its exact transcript
- Written permission to use the voice and reference recording

The repository intentionally does not install or download model assets.

## Mode A: gateway on the same machine

### 1. Configure the install root

```powershell
$env:GPTSOVITS_HOME = "D:\GPT-SoVITS"
```

The directory must contain `api_v2.py` and `webui.py`.

### 2. Create the gateway environment

```powershell
.\scripts\setup-gateway.ps1
```

### 3. Set a key

Generate a long random token and keep it outside Git:

```powershell
$env:GATEWAY_API_KEY = "<long-random-token>"
```

The gateway binds `127.0.0.1` by default. No key is required for loopback-only
development, but a key is recommended even then so the DSH configuration is
representative of production.

### 4. Start GPT-SoVITS upstream

Start the installed `api_v2.py` on port `9880` using its normal launch procedure.
Then start the gateway:

```powershell
.\scripts\start-gateway.ps1
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:18080/healthz
```

### 5. Register a voice

```powershell
Copy-Item .\config\voices.example.json .\config\voices.local.json
notepad .\config\voices.local.json
.\scripts\check-assets.ps1 -Manifest .\config\voices.local.json
.\scripts\register-voices.ps1 `
  -Manifest .\config\voices.local.json `
  -ApiKey $env:GATEWAY_API_KEY
```

`ref_text` must be the exact words spoken in `ref_audio`. A structurally valid
manifest with the wrong transcript produces a valid WAV that no longer sounds
like the intended speaker.

## Mode B: gateway on a model server

Run the gateway on the server with loopback binding. From the DSH machine, create
an SSH forward:

```powershell
.\scripts\start-tunnel.ps1 `
  -ServerHost "192.0.2.10" `
  -UserName "tts" `
  -KeyFile "$env:USERPROFILE\.ssh\id_ed25519"
```

The client still calls `http://127.0.0.1:18080/v1`. The gateway remains inaccessible
from the rest of the network except through the SSH session.

For unattended operation, put the tunnel under the operating system's service
manager or a scheduled task that reconnects after failures. Do not store a password
in the repository or command line.

## DSH plugin installation

Preferred: use DSH's plugin manager or graphical plugin page if available.

Manual fallback:

```powershell
.\scripts\install-plugin.ps1 `
  -ProfileDirectory "$env:USERPROFILE\.dsh\profiles\desktop"
```

The script:

1. packs `plugin/`;
2. backs up the profile `package.json` and lockfile;
3. adds the local tarball dependency;
4. adds `dsh-tts` to `dsh.profile.bundles`;
5. runs `pnpm install`.

Restart DSH after replacing an installed bundle. Create a new conversation and
select the voice preset.

## Gateway configuration

| Variable | Default | Meaning |
|---|---|---|
| `GPTSOVITS_HOME` | none | GPT-SoVITS install root |
| `GATEWAY_HOST` | `127.0.0.1` | Bind address |
| `GATEWAY_PORT` | `18080` | Gateway port |
| `GPTSOVITS_API_PORT` | `9880` | Upstream API port |
| `GATEWAY_API_KEY` | empty | Optional bearer/API key |
| `GATEWAY_STATE_FILE` | `gateway/gateway_state.json` | Runtime voice registry |
| `GATEWAY_CORS_ORIGINS` | `*` | Comma-separated browser origins |

Binding to a non-loopback address without a key is rejected.

## Plugin configuration

| Key | Environment variable | Default |
|---|---|---|
| `baseUrl` | `DSH_TTS_BASE_URL` | `http://127.0.0.1:18080/v1` |
| `model` | `DSH_TTS_MODEL` | `tts-1` |
| `voice` | `DSH_TTS_VOICE` | `local_voice` |
| `language` | `DSH_TTS_LANGUAGE` | `zh` |
| `promptLanguage` | `DSH_TTS_PROMPT_LANGUAGE` | `zh` |
| `apiKey` | `DSH_TTS_API_KEY` | empty |
| `timeoutMs` | `DSH_TTS_TIMEOUT_MS` | `120000` |
| `cacheEntries` | `DSH_TTS_CACHE_ENTRIES` | `32` |

The plugin's default endpoint is loopback because DSH commonly runs on a different
origin from the gateway. Use the SSH tunnel rather than hard-coding a private LAN
address.

## Service ownership

Use the service manager to supervise:

- GPT-SoVITS `api_v2.py`
- the gateway
- the SSH tunnel when remote

Only the gateway should expose an HTTP port. The upstream should remain loopback-only.
The SSH tunnel should use key authentication and `BatchMode=yes`.

## Upgrade

1. Drain or stop synthesis requests.
2. Back up `gateway_state.json`.
3. Replace code.
4. Run `.\scripts\run-tests.ps1`.
5. Restart the gateway.
6. Check `/healthz`.
7. Synthesize a short Chinese and a short Japanese sentence.
8. Run `tts --check` if ASR is available.
