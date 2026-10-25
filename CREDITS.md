# Credits and lineage

## Amadeus

Absolute Solver TTS is built on the TTS client contract, language-loss analysis,
same-origin delivery model, and parts of the implementation developed by the
[Amadeus project](https://github.com/Code-Amadeus/Amadeus).

The DSH voice plugin is an adaptation of Amadeus's OpenAI-compatible TTS backend.
Its buffered WAV/SSE client shape, language handling, capability boundaries, and
verification philosophy descend from that work. This repository is distributed
under AGPL-3.0 because it includes and modifies Amadeus-derived code.

Thank you to the Amadeus maintainers and contributors for publishing their work
and its reasoning under a free-software license.

Amadeus is an independent project. This repository is not endorsed by or
affiliated with its maintainers.

## DeepSeek Harness

The `plugin/` package targets DeepSeek Harness (DSH) through its bundle, tool,
prompt, and web-server extension surfaces. DSH is not vendored here.

## GPT-SoVITS

The gateway targets an independently installed GPT-SoVITS runtime. GPT-SoVITS
code, model weights, and voice assets are not vendored here.

## Voice assets

No voice model, checkpoint, reference recording, or third-party character voice
is part of this repository. See `docs/assets-and-licenses.md`.
