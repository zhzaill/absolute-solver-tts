# dsh-tts-browser

Root-level DSH browser bundle for `tts_speak` results.

It follows the DSH tool-view contract used by `dsh-comfyui`:

- the host tool attaches `output.presentationMeta`;
- this client registers `tool.call.toolview` with key `tts_speak`;
- the settled card renders a native `<audio controls>` element;
- multiple speech cards share one client-side queue and play in arrival order.

It does not scan or mutate conversation Markdown.
