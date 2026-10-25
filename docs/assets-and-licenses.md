# Voice assets and licenses

## Repository policy

This repository does not distribute:

- GPT or SoVITS checkpoints;
- training corpora;
- reference recordings;
- cloned or impersonated voice models;
- character voice assets from games, animation, streams, or other media.

The repository cannot grant rights to a voice, a performance, a recording, or a
character likeness. Those rights are independent of the software license.

Extracting a voice from published media yourself does not create a right to
redistribute the resulting model, embeddings, or recordings. A "non-commercial"
label is a usage preference, not a license from the rightsholders. This repository
therefore does not host such a model or designate a third-party character voice as
its default.

## Bring your own voice

You may connect a voice only if you have the necessary rights and permissions.
Depending on the source, that can include:

- consent from the speaker;
- rights to the recordings used for training and inference;
- rights to the character or brand;
- compliance with the base model's license;
- compliance with the training-data source's terms.

Do not assume that "non-commercial", "research", "private use", or "the repository
takes no responsibility" creates permission.

## Required assets

Each local voice needs:

1. a GPT checkpoint ending in `.ckpt`;
2. a SoVITS checkpoint ending in `.pth`;
3. a clear reference recording;
4. the exact transcript of that recording;
5. the reference language;
6. a default target language.

Both model files are optional only when the upstream already has suitable weights
loaded. Supplying only one creates predictable mismatches and should be avoided.

## Storage

Keep assets outside this repository or in ignored runtime directories.

Recommended server layout:

```text
GPT-SoVITS/
  GPT_weights_v2/
    local_voice-e15.ckpt
  SoVITS_weights_v2/
    local_voice_e8_s208.pth
  outputs/voice/
    reference.wav
```

Recommended registry:

```text
gateway/gateway_state.json
```

Both the model files and the registry are ignored by Git.

## Preflight

```powershell
.\scripts\check-assets.ps1 `
  -Manifest .\config\voices.local.json `
  -GptSovitsHome $env:GPTSOVITS_HOME
```

The script checks:

- path containment;
- file existence;
- `.ckpt` and `.pth` extensions;
- RIFF/WAVE header for WAV references;
- non-empty reference transcript;
- SHA-256 of the reference for local audit.

It does not attempt to determine whether the transcript is semantically correct.
Listen to the reference or run an ASR comparison.

## Publishing a voice package

Before publishing any external voice package, verify:

- you have redistribution rights for every checkpoint;
- you have redistribution rights for the reference audio;
- the transcript is accurate;
- the package does not contain personal data;
- the base-model and upstream project licenses permit the distribution;
- the voice package has its own license and attribution.

This repository's AGPL-3.0 license applies to its code and documentation only.
