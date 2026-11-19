#!/usr/bin/env python3
"""Verify a Cortico WAV and hand it to an explicitly selected MicroDuck ALSA sink."""

import argparse
import hashlib
import io
import json
import math
import re
import shlex
import struct
import subprocess
import sys
import wave
from pathlib import Path

MAX_BYTES = 8 * 1024 * 1024

# Executed on the authenticated Linux host. Buffering the bounded file lets us
# verify its digest before sending any samples to ALSA.
REMOTE = """
import hashlib, json, subprocess, sys
device, expected, limit = sys.argv[1:]
data = sys.stdin.buffer.read(int(limit) + 1)
digest = hashlib.sha256(data).hexdigest()
if len(data) > int(limit) or digest != expected:
    raise SystemExit("WAV payload does not match the source")
result = subprocess.run(["aplay", "-q", "-D", device], input=data, timeout=40)
if result.returncode:
    raise SystemExit(result.returncode)
print(json.dumps({"player": "aplay", "device": device, "sha256": digest,
                  "bytes": len(data), "alsa_exit_code": result.returncode}))
"""


def inspect_wav(data: bytes) -> dict:
    if len(data) > MAX_BYTES:
        raise ValueError("WAV is larger than 8 MiB")
    with wave.open(io.BytesIO(data), "rb") as wav:
        rate, channels, nframes = wav.getframerate(), wav.getnchannels(), wav.getnframes()
        if wav.getsampwidth() != 2 or channels not in (1, 2) or not 8000 <= rate <= 48000:
            raise ValueError("Expected 16-bit PCM WAV, mono or stereo, 8–48 kHz")
        if not 0 < nframes <= 30 * rate:
            raise ValueError("Expected a clip of up to 30 seconds")
        pcm = wav.readframes(nframes)
    if len(pcm) != nframes * channels * 2:
        raise ValueError("WAV PCM is truncated")
    peak, squares = 0, 0
    for (value,) in struct.iter_unpack("<h", pcm):
        peak = max(peak, abs(value))
        squares += value * value
    if not peak:
        raise ValueError("WAV is digitally silent")
    return {
        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
        "sample_rate_hz": rate, "channels": channels, "pcm_bits": 16,
        "duration_seconds": round(nframes / rate, 3), "peak": peak,
        "rms": round(math.sqrt(squares / (nframes * channels)), 1),
    }


def play(data: bytes, report: dict, target: str, device: str, known_hosts: Path, identity: Path | None) -> dict:
    command = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", f"UserKnownHostsFile={known_hosts}", "-o", "ConnectTimeout=5"]
    if identity:
        command += ["-o", "IdentitiesOnly=yes", "-i", str(identity)]
    remote = shlex.join(["python3", "-c", REMOTE, device, report["sha256"], str(MAX_BYTES)])
    result = subprocess.run(command + [target, remote], input=data, capture_output=True, timeout=55)
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[-400:]
        raise ValueError(f"SSH/ALSA exit {result.returncode}: {detail}")
    receipt = json.loads(result.stdout)
    if receipt != {"player": "aplay", "device": device, "sha256": report["sha256"],
                   "bytes": len(data), "alsa_exit_code": 0}:
        raise ValueError("Remote playback receipt did not match the verified WAV")
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--ssh", metavar="USER@HOST", help="Omit to validate locally without sending audio")
    parser.add_argument("--device", help="ALSA device, e.g. plughw:CARD=Speak,DEV=0")
    parser.add_argument("--known-hosts", type=Path, help="Known-hosts file with the verified board key")
    parser.add_argument("--identity", type=Path)
    args = parser.parse_args()
    if args.ssh:
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*", args.ssh):
            parser.error("--ssh must be USER@HOST (hostname or IPv4 address)")
        if not args.known_hosts or not args.known_hosts.is_file():
            parser.error("--ssh requires an existing --known-hosts file")
        if not args.device or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:=.,-]{0,95}", args.device):
            parser.error("--ssh requires an explicit ALSA --device")
    elif args.device or args.known_hosts or args.identity:
        parser.error("Remote playback options require --ssh")
    try:
        with args.wav.open("rb") as file:
            data = file.read(MAX_BYTES + 1)
        report = inspect_wav(data)
        if args.ssh:
            report["playback"] = play(data, report, args.ssh, args.device,
                                      args.known_hosts.resolve(), args.identity)
        print(json.dumps(report))
    except (OSError, EOFError, ValueError, wave.Error, subprocess.TimeoutExpired) as error:
        print(f"MicroDuck WAV check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
