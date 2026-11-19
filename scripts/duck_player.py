#!/usr/bin/env python3
"""板端播放器：从 stdin 读「长度前缀 + 完整 WAV」，逐段交给 aplay，并逐段回执。

协议（见 docs/TASK-BLACKBOARD.md「MicroDuck 板端约定」）：

  主机 → 板端 stdin : 反复的 `uint32_le(n) + n 字节完整 WAV`，1 ≤ n ≤ 8 MiB
  板端 → 主机 stdout: 每段一行 JSON。seq 从 0 起按连接递增；bytes / sha256 由板端
                     对收到的 WAV 自己算；alsa_exit_code 只有真的跑过 aplay 并退出
                     才是整数，否则 null。

这个文件同时是「板端脚本本体」和「主机端 bootstrap 的来源」：主机把本文件源码
base64 后经 SSH 送过去，板子用 python3 - 直接执行，所以板上不需要预装任何东西。

诊断一律走 stderr，stdout 只放回执。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shlex
import struct
import subprocess
import sys
import time
import wave
from array import array

MAX_FRAME = 8 * 1024 * 1024
MIN_FRAME = 1

PLAYER_COMMAND: list[str] = []


def emit(receipt: dict, log_path: str = "") -> None:
    line = json.dumps(receipt, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    if log_path:
        try:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(time.strftime("%Y-%m-%dT%H:%M:%S") + " " + line + "\n")
        except OSError as error:
            sys.stderr.write(f"cannot write {log_path}: {error}\n")


def read_exact(stream, count: int) -> bytes | None:
    """读满 count 字节；不足说明对端断了或半帧结束，返回 None。"""
    chunks = []
    remaining = count
    while remaining > 0:
        piece = stream.read(remaining)
        if not piece:
            return None
        chunks.append(piece)
        remaining -= len(piece)
    return b"".join(chunks)


def validate_wav(data: bytes) -> tuple[bool, str, int, int, int]:
    """认格式：(ok, 原因, 采样率, 声道, 位宽)。只接受 PCM 16 位、单/双声道。"""
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        return False, "不是 RIFF/WAVE", 0, 0, 0
    offset = 12
    rate = channels = width = 0
    fmt_tag = None
    pcm_bytes = 0
    size = len(data)
    while offset + 8 <= size:
        chunk_id = data[offset:offset + 4]
        chunk_size = struct.unpack("<I", data[offset + 4:offset + 8])[0]
        body = offset + 8
        end = min(size, body + chunk_size) if chunk_size else size
        if chunk_id == b"fmt " and body + 16 <= size:
            fmt_tag, channels, rate = struct.unpack("<HHI", data[body:body + 8])
            width = struct.unpack("<H", data[body + 14:body + 16])[0] // 8
        elif chunk_id == b"data":
            pcm_bytes = end - body
            break
        offset = end if chunk_size else size
    if fmt_tag is None:
        return False, "缺少可用的 fmt 块", rate, channels, width
    if fmt_tag != 1:
        return False, f"不是 PCM 编码（fmt={fmt_tag}）", rate, channels, width
    if not rate or not channels or not width:
        return False, "缺少可用的 fmt 块", rate, channels, width
    if width != 2:
        return False, f"只接受 16 位 PCM（收到 {width * 8} 位）", rate, channels, width
    if channels not in (1, 2):
        return False, f"只接受单/双声道（收到 {channels}）", rate, channels, width
    if not 8000 <= rate <= 48000:
        return False, f"采样率超出 8–48 kHz（收到 {rate}）", rate, channels, width
    if pcm_bytes <= 0:
        return False, "没有 PCM 数据", rate, channels, width
    return True, "", rate, channels, width


def _fmt_is_pcm(data: bytes) -> bool:
    offset = 12
    size = len(data)
    while offset + 8 <= size:
        chunk_size = struct.unpack("<I", data[offset + 4:offset + 8])[0]
        body = offset + 8
        if data[offset:offset + 4] == b"fmt " and body + 2 <= size:
            return struct.unpack("<H", data[body:body + 2])[0] == 1
        offset = body + chunk_size if chunk_size else size
    return False


def play(wav: bytes, command: list[str]) -> tuple[int | None, str]:
    """交给 aplay；返回 (退出码, 错误)。"""
    try:
        result = subprocess.run(command, input=wav, capture_output=True, timeout=120)
    except FileNotFoundError as error:
        return None, f"找不到播放器：{error}"
    except subprocess.TimeoutExpired:
        return None, "播放器超时（120 s）"
    if result.returncode != 0:
        detail = (result.stderr or b"").decode("utf-8", "replace").strip()
        return result.returncode, detail[:300] or f"退出码 {result.returncode}"
    return 0, ""


def scale_wav(data: bytes, gain: float) -> bytes:
    """按增益缩放 16 位 PCM，返回新的 WAV。board 上的 aplay 不做软件音量，只能自己缩。"""
    if gain >= 0.999:
        return data
    rate, channels, width, pcm = split_pcm(data)
    if width != 2:
        return data
    usable = len(pcm) - (len(pcm) % 2)
    samples = array("h")
    samples.frombytes(pcm[:usable])
    for index, value in enumerate(samples):
        samples[index] = int(value * gain)
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(width)
        writer.setframerate(rate)
        writer.writeframes(samples.tobytes())
    return output.getvalue()


def split_pcm(data: bytes) -> tuple[int, int, int, bytes]:
    """拆出 (采样率, 声道, 位宽, PCM)，不信任头里声明的长度。"""
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("不是 RIFF/WAVE 音频")
    _ok, _reason, rate, channels, width = validate_wav(data)
    offset = 12
    size = len(data)
    pcm = b""
    while offset + 8 <= size:
        chunk_id = data[offset:offset + 4]
        chunk_size = struct.unpack("<I", data[offset + 4:offset + 8])[0]
        body = offset + 8
        end = min(size, body + chunk_size) if chunk_size else size
        if chunk_id == b"data":
            pcm = data[body:end] if chunk_size else data[body:]
            break
        offset = end if chunk_size else size
    return rate, channels, width, pcm


def serve(stream, command: list[str], log_path: str = "", gain: float = 1.0) -> int:
    seq = 0
    session_start = time.time()
    while True:
        header = stream.read(4)
        if not header:
            return 0  # 段边界上的 EOF：正常结束
        if len(header) < 4:
            emit({"seq": seq, "ok": False, "bytes": 0, "sha256": "", "alsa_exit_code": None,
                  "error": "头部被截断（半帧结束）"}, log_path)
            return 2
        size = int.from_bytes(header, "little")
        if size < MIN_FRAME or size > MAX_FRAME:
            emit({"seq": seq, "ok": False, "bytes": size, "sha256": "", "alsa_exit_code": None,
                  "error": f"帧长度越界：{size}（允许 1–{MAX_FRAME}）"}, log_path)
            return 2
        wav = read_exact(stream, size)
        if wav is None:
            emit({"seq": seq, "ok": False, "bytes": 0, "sha256": "", "alsa_exit_code": None,
                  "error": "载荷被截断（半帧结束）"}, log_path)
            return 2

        digest = hashlib.sha256(wav).hexdigest()
        ok, reason, rate, channels, width = validate_wav(wav)
        if not ok:
            emit({"seq": seq, "ok": False, "bytes": len(wav), "sha256": digest,
                  "alsa_exit_code": None, "error": reason}, log_path)
            seq += 1
            continue

        started = time.time()
        payload = wav
        if gain < 0.999:
            try:
                payload = scale_wav(wav, gain)
            except (ValueError, wave.Error) as error:
                emit({"seq": seq, "ok": False, "bytes": len(wav), "sha256": digest,
                      "alsa_exit_code": None, "error": f"缩放失败：{error}"}, log_path)
                seq += 1
                continue
        # 回执里的 sha256 始终是「收到的那份」——主机就是拿它核对发送记录的
        code, error = play(payload, command)
        receipt = {
            "seq": seq,
            "ok": code == 0,
            "bytes": len(wav),
            "sha256": digest,
            "alsa_exit_code": code,
            "rate": rate,
            "channels": channels,
            "player": " ".join(PLAYER_COMMAND),
            "gain": round(gain, 2),
            # 从本次会话开始到这一段交给 aplay 的毫秒数：鸭身首声就从这里算
            "t_start_ms": int((started - session_start) * 1000),
            "ms": int((time.time() - started) * 1000),
        }
        if error:
            receipt["error"] = error
        emit(receipt, log_path)
        seq += 1


def split_command(text: str) -> list[str]:
    """拆播放命令。Windows 上不能按 POSIX 规则拆——反斜杠会被当转义符吃掉。"""
    parts = shlex.split(text, posix=(os.name != "nt"))
    out = []
    for part in parts:
        if len(part) >= 2 and part[0] == part[-1] and part[0] in "\"'":
            part = part[1:-1]
        out.append(part)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MicroDuck 板端分段播放器")
    parser.add_argument("--aplay", default="aplay -q", help="播放器命令（默认 aplay -q）")
    parser.add_argument("--device", default="", help="ALSA 设备，如 plughw:CARD=Speak,DEV=0")
    parser.add_argument("--log", default="", help="把每段回执也追加写进这个文件，便于事后取证")
    parser.add_argument("--gain", type=float, default=1.0, help="软件音量 0–1；板上的 aplay 不做音量")
    args = parser.parse_args(argv)

    command = split_command(args.aplay)
    if args.device:
        command += ["-D", args.device]
    command.append("-")
    PLAYER_COMMAND[:] = command
    gain = min(1.0, max(0.0, float(args.gain)))
    return serve(sys.stdin.buffer, command, args.log, gain)


if __name__ == "__main__":
    sys.exit(main())
