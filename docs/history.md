# History and measured findings

This is a sanitized technical history. Personal paths, hosts, credentials, private
logs, and third-party voice assets are intentionally excluded.

## Lineage

The DSH TTS client is adapted from the OpenAI-compatible TTS work in
[Code-Amadeus/Amadeus](https://github.com/Code-Amadeus/Amadeus). That lineage
includes the buffered WAV/SSE client contract, explicit language handling, the
same-origin audio design, and the practice of checking spoken content rather than
trusting file size alone.

Because this repository includes modified Amadeus-derived code, it is licensed
under AGPL-3.0. See `CREDITS.md` for the acknowledgement and `LICENSE` for the
full terms.

## Why the gateway exists

GPT-SoVITS' native API requires a reference audio path and transcript on each
request. Most OpenAI-compatible clients send only model, text, voice, format, and
speed. The gateway adds a stable voice registry so clients can send only a voice ID.

## The language-loss failure

An early deployment produced healthy WAV files with no obvious signal defects.
Listening and ASR round-trip later showed that Japanese text had been rendered by
a Chinese frontend.

Observed Japanese test sentence:

```text
今日のデプロイは無事に完了したわ。
```

Wrong configuration produced a short Chinese sentence with the kana and the word
for deployment missing. The signal metrics were almost identical to the correct
render.

Conclusion:

- Open synthetic speech can be fluent and still say the wrong thing.
- Signal metrics cannot replace content verification.
- The receiver must infer or require a language when the transport schema does not
  carry one.

The gateway now uses explicit request language, then script inference, then the
voice default.

## Reference transcript mismatch

A reference pack passed structural validation while its `ref_text` was unrelated
to the recording. Output became noisy and lost speaker identity even though no file
was missing.

Conclusion:

- Structural validation is necessary but not semantic validation.
- The exact transcript must be confirmed by listening or a reliable ASR pass.

## Reproducibility experiment

Two runs with the same seed produced:

- identical byte counts;
- identical WAV headers;
- identical sample counts;
- maximum sample difference of 1 LSB;
- 99.97% identical samples.

Conclusion:

- A fixed seed makes content checks reproducible.
- A file-hash assertion is an invalid regression oracle for this engine.

## Three verification gates

The investigation converged on three orthogonal checks:

1. signal integrity;
2. content fidelity;
3. voice identity.

The second gate was missing in the first deployment. ASR round-trip exposed the
sentence-level failure.

Later tests showed the limit of ASR: punctuation, numeric normalization, and
near-homophones can differ without proving synthesis failure. Content checks must
therefore classify sentence-level errors differently from word-level review items.

## Performance

On the measured server GPU, buffered GPT-SoVITS synthesis reached an RTF of roughly
0.44-0.56 after reference and language issues were fixed. Output was 32 kHz mono.

This was faster than real time, but the gateway remained buffered because streaming
is a protocol change, not a performance flag.

## Windows shell failures

Two failures were caused by command examples rather than TTS:

1. a `.cmd` file used LF instead of CRLF, so `cmd.exe` misparsed comment text;
2. a placeholder using angle brackets was interpreted as redirection before Node
   started.

The CLI now rejects extra positional arguments and unknown options instead of
silently adding them to the spoken sentence.

## Delivery decision

The final layout uses:

- one gateway process;
- one DSH provider plugin;
- one SSH-forwarding path for remote models;
- no bundled voice, weight, or reference asset.

This keeps code versionable while treating model assets as separately governed
runtime data.
