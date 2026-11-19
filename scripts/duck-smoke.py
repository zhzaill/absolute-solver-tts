#!/usr/bin/env python3
"""鸭身链路冒烟：真实网关分段 → 主机播放适配 → 假板子播放器。

不碰真鸭子，验的是「帧协议在真实音频上是否自洽」：
  * 每段的 sha256 由板端自己算，回到主机与发送记录对得上；
  * 多段共用一条会话、seq 递增、每段一次 aplay；
  * 首段从请求发出到交给播放器的毫秒数（鸭身端的首声估算就用它 + SSH 往返）。

用法：
  python scripts/duck-smoke.py "要说的话" [--no-play]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import struct
import subprocess
import sys
import time
import wave

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELAY = os.path.join(ROOT, "scripts", "duck_relay.py")

FAKE_APLAY = """\
import os, sys
data = sys.stdin.buffer.read()
with open(os.environ['DUCK_FAKE_LOG'], 'a', encoding='utf-8') as handle:
    handle.write(str(len(data)) + '\\n')
sys.exit(0)
"""


def key() -> str:
    if os.environ.get("TTS_KEY"):
        return os.environ["TTS_KEY"].strip()
    path = os.path.join(os.environ.get("TEMP", "/tmp"), "tts-key.txt")
    if os.path.exists(path):
        return open(path, encoding="utf-8").read().strip()
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("text", nargs="?", default="你好，我是科提科。这一句先到，下一句随后就来。")
    parser.add_argument("--base", default=os.environ.get("TTS_BASE", "http://127.0.0.1:18080"))
    parser.add_argument("--voice", default=os.environ.get("TTS_VOICE", "xxx_trained"))
    args = parser.parse_args()

    workdir = os.path.join(os.environ.get("TEMP", "/tmp"), "duck-smoke")
    os.makedirs(workdir, exist_ok=True)
    fake = os.path.join(workdir, "fake_aplay.py")
    log = os.path.join(workdir, "aplay.log")
    with open(fake, "w", encoding="utf-8") as handle:
        handle.write(FAKE_APLAY)
    if os.path.exists(log):
        os.remove(log)

    env = {**os.environ, "DUCK_FAKE_LOG": log}
    relay = subprocess.Popen(
        [sys.executable, "-u", RELAY, "--local", "--aplay", f"{sys.executable} {fake}", "--receipt-timeout", "20"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
    )

    started = time.time()
    response = requests.post(
        f"{args.base.rstrip('/')}/v1/audio/segments",
        json={"input": args.text, "voice": args.voice},
        headers={"Authorization": f"Bearer {key()}"},
        stream=True,
        timeout=180,
    )
    response.raise_for_status()

    sent = []
    buffer = b""
    first_handoff = None
    for chunk in response.iter_content(16384):
        buffer += chunk
        while len(buffer) >= 5:
            size = int.from_bytes(buffer[0:4], "little")
            if len(buffer) < 5 + size:
                break
            kind = buffer[4]
            payload = buffer[5:5 + size]
            buffer = buffer[5 + size:]
            if kind != 1:
                meta = json.loads(payload.decode("utf-8"))
                if meta.get("kind") == "segment":
                    print(json.dumps({"event": "segment", **meta, "at_ms": int((time.time() - started) * 1000)}), flush=True)
                continue
            import hashlib

            digest = hashlib.sha256(payload).hexdigest()
            relay.stdin.write(struct.pack("<I", len(payload)) + payload)
            relay.stdin.flush()
            if first_handoff is None:
                first_handoff = int((time.time() - started) * 1000)
            sent.append((len(payload), digest))

    relay.stdin.close()
    out, _ = relay.communicate(timeout=120)
    receipts = [json.loads(line) for line in out.decode("utf-8").splitlines() if line.strip()]
    body = [r for r in receipts if "summary" not in r]
    summary = [r for r in receipts if "summary" in r]

    matched = sum(
        1 for index, receipt in enumerate(body)
        if index < len(sent)
        and receipt.get("bytes") == sent[index][0]
        and receipt.get("sha256") == sent[index][1]
        and receipt.get("ok")
    )
    calls = sum(1 for line in open(log, encoding="utf-8")) if os.path.exists(log) else 0
    result = {
        "event": "duck",
        "sent": len(sent),
        "receipts": len(body),
        "matched": matched,
        "aplay_calls": calls,
        "first_handoff_ms": first_handoff,
        "total_ms": int((time.time() - started) * 1000),
        "summary": summary[0]["summary"] if summary else None,
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0 if matched == len(sent) and calls == len(sent) else 1


if __name__ == "__main__":
    sys.exit(main())
