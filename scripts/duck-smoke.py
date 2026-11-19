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
    parser.add_argument("--target", default="", help="鸭身 SSH 目标，如 radxa@192.168.67.200；留空用本机假板子")
    parser.add_argument("--device", default="", help="板端 ALSA 设备，如 plughw:CARD=aic3104,DEV=0")
    parser.add_argument("--plink", default=os.environ.get("PLINK", ""), help="plink 路径；留空用 ssh")
    parser.add_argument("--host-key", default="", help="plink 的 -hostkey 指纹")
    parser.add_argument("--password", default=os.environ.get("DUCK_PASSWORD", ""), help="plink 的 -pw")
    parser.add_argument("--warm-seconds", type=float, default=0.0,
                        help="先让 SSH 会话建立并等这么久，再发请求；用来把会话开销和合成开销分开")
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
    relay_args = [sys.executable, "-u", RELAY, "--receipt-timeout", "20"]
    if args.target:
        relay_args += ["--target", args.target]
        if args.plink:
            relay_args += ["--plink", args.plink]
        if args.host_key:
            relay_args += ["--host-key", args.host_key]
        if args.password:
            relay_args += ["--password", args.password]
        if args.device:
            relay_args += ["--device", args.device]
    else:
        relay_args += ["--local", "--aplay", f"{sys.executable} {fake}"]
    relay = subprocess.Popen(relay_args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)

    # 边收边记时间：板端回执里的 ms 是 aplay 的时长，回执到达时间减掉它，
    # 就是「板子开始放这一段」在本机时钟上的位置，不用同步两台机器的时钟。
    import threading

    arrivals = []

    def pump():
        assert relay.stdout is not None
        for raw in relay.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            arrivals.append((time.time(), frame))

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()

    if args.warm_seconds > 0:
        time.sleep(args.warm_seconds)
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
    reader.join(timeout=60)
    receipts = [frame for _at, frame in arrivals]
    body = [r for r in receipts if "summary" not in r]
    summary = [r for r in receipts if "summary" in r]

    for receipt in body:
        print(json.dumps({"event": "receipt", **receipt}, ensure_ascii=False))

    matched = sum(
        1 for index, receipt in enumerate(body)
        if index < len(sent)
        and receipt.get("bytes") == sent[index][0]
        and receipt.get("sha256") == sent[index][1]
        and receipt.get("ok")
    )
    calls = sum(1 for line in open(log, encoding="utf-8")) if os.path.exists(log) else 0
    first_sound = None
    for at, frame in arrivals:
        if "summary" in frame:
            continue
        if isinstance(frame.get("ms"), int):
            first_sound = int((at - started) * 1000) - frame["ms"]
            break
    result = {
        "event": "duck",
        "target": args.target or "local-fake",
        "device": args.device or "-",
        "sent": len(sent),
        "receipts": len(body),
        "matched": matched,
        "aplay_calls": calls if not args.target else "n/a (real board)",
        "first_handoff_ms": first_handoff,
        # 板端自己记的：从板端会话建立起，到第一段交给 aplay 的毫秒数
        "first_duck_play_ms": body[0].get("t_start_ms") if body else None,
        # 本机时钟上：请求发出 → 板子开始放第一段（由回执到达时刻减 aplay 时长推得）
        "first_sound_ms": first_sound,
        "total_ms": int((time.time() - started) * 1000),
        "summary": summary[0]["summary"] if summary else None,
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))
    # 真板子上没有假 aplay 的日志，只核对回执是否与发送记录逐段相符
    ok = matched == len(sent) and (args.target or calls == len(sent))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
