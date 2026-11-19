#!/usr/bin/env python3
"""主机端播放适配：把分帧 WAV 经一条 SSH 会话送到板端，逐段核对回执。

自己的 stdin 也是同一套帧（`uint32_le(n) + n 字节 WAV`），所以上游（Coo 的 World、
调试脚本）只要按协议写字节即可。stdout 逐行转发板端回执，最后一行是 summary。

分工按 docs/TASK-BLACKBOARD.md：
  * 主机约束待播量、负责取消与丢弃；
  * 段边界 EOF 正常收尾；半帧、越界长度、断连都算会话失败；
  * 超时或缺回执记为「结果未知」，**不自动重播**。

用法：
  python scripts/duck_relay.py --local --aplay "python fake_aplay.py"     # 本机假板子
  python scripts/duck_relay.py --ssh radxa@microduck.local --device plughw:CARD=Speak,DEV=0
  python scripts/duck_relay.py --ssh ... --plink "C:\\Program Files\\PuTTY\\plink.exe"
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import queue
import shlex
import subprocess
import sys
import threading
import time

MAX_FRAME = 8 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))
PLAYER = os.path.join(HERE, "duck_player.py")

BOOTSTRAP = (
    "import sys,base64;"
    "n=int(sys.stdin.buffer.readline());"
    "src=base64.b64decode(sys.stdin.buffer.read(n));"
    "exec(compile(src,'duck_player.py','exec'),{'__name__':'__main__'})"
)


def log(message: str) -> None:
    sys.stderr.write(f"[duck] {message}\n")
    sys.stderr.flush()


def build_command(args) -> list[str]:
    if args.local:
        command = [sys.executable, "-u", PLAYER, "--aplay", args.aplay]
        if args.device:
            command += ["--device", args.device]
        return command
    if args.plink:
        command = [args.plink, "-batch", "-ssh"]
        if args.host_key:
            command += ["-hostkey", args.host_key]
        if args.password:
            command += ["-pw", args.password]
    else:
        command = ["ssh", "-o", "BatchMode=yes"]
    if args.identity:
        command += ["-i", args.identity]
    command += [args.target, f"python3 -u -c {shlex.quote(BOOTSTRAP)}"]
    return command


def read_frames(stream):
    """从 stdin 读帧，yield (index, wav)；半帧或越界长度抛 ValueError。"""
    index = 0
    while True:
        header = stream.read(4)
        if not header:
            return
        if len(header) < 4:
            raise ValueError("帧头被截断（半帧结束）")
        size = int.from_bytes(header, "little")
        if size < 1 or size > MAX_FRAME:
            raise ValueError(f"帧长度越界：{size}（允许 1–{MAX_FRAME}）")
        remaining = size
        chunks = []
        while remaining > 0:
            piece = stream.read(remaining)
            if not piece:
                raise ValueError(f"第 {index} 帧载荷被截断")
            chunks.append(piece)
            remaining -= len(piece)
        yield index, b"".join(chunks)
        index += 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="MicroDuck 主机端播放适配")
    parser.add_argument("--local", action="store_true", help="不起 SSH，本机直接跑板端播放器")
    parser.add_argument("--target", default="", help="SSH 目标，如 radxa@microduck.local")
    parser.add_argument("--device", default="", help="板端 ALSA 设备")
    parser.add_argument("--aplay", default="aplay -q", help="板端播放命令（--local 时用）")
    parser.add_argument("--plink", default="", help="plink 路径；留空用 ssh")
    parser.add_argument("--host-key", default="", help="plink 的 -hostkey 指纹")
    parser.add_argument("--password", default="", help="plink 的 -pw（不推荐放命令行）")
    parser.add_argument("--identity", default="", help="SSH 私钥")
    parser.add_argument("--max-pending", type=int, default=3, help="最多几段未回执")
    parser.add_argument("--receipt-timeout", type=float, default=30.0, help="等回执的秒数")
    args = parser.parse_args(argv)

    if not args.local and not args.target:
        log("--target 或 --local 必须给一个")
        return 2

    command = build_command(args)
    log("会话：" + " ".join(command[:2]))
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)

    receipts: "queue.Queue[dict]" = queue.Queue()
    state = {"failed": False, "error": "", "rust": ""}

    def pump() -> None:
        assert child.stdout is not None
        for raw in child.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                receipts.put(json.loads(line))
            except json.JSONDecodeError:
                state["failed"] = True
                state["error"] = f"板端输出了非 JSON：{line[:120]}"

    threading.Thread(target=pump, daemon=True).start()

    if not args.local:  # 本机模式不需要送源码
        with open(PLAYER, "rb") as handle:
            source = base64.b64encode(handle.read())
        child.stdin.write(f"{len(source)}\n".encode("ascii") + source)
        child.stdin.flush()

    sent: list[tuple[int, int, str]] = []   # (index, bytes, sha256)
    seen: dict[int, dict] = {}
    started = time.time()

    def take_receipt(timeout: float) -> bool:
        try:
            receipt = receipts.get(timeout=timeout)
        except queue.Empty:
            return False
        seq = receipt.get("seq")
        if isinstance(seq, int):
            seen[seq] = receipt
        if isinstance(seq, int) and 0 <= seq < len(sent):
            _index, size, digest = sent[seq]
            if receipt.get("bytes") != size:
                receipt["mismatch"] = f"bytes {receipt.get('bytes')} != {size}"
            if receipt.get("sha256") and receipt["sha256"] != digest:
                receipt["mismatch"] = "sha256 与发送记录不一致"
        sys.stdout.write(json.dumps(receipt, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return True

    try:
        for index, wav in read_frames(sys.stdin.buffer):
            while len(sent) - len(seen) >= args.max_pending:
                if not take_receipt(args.receipt_timeout):
                    log("等回执超时：后续记为结果未知")
                    state["rust"] = "timeout"
                    break
            digest = hashlib.sha256(wav).hexdigest()
            child.stdin.write(len(wav).to_bytes(4, "little") + wav)
            child.stdin.flush()
            sent.append((index, len(wav), digest))
        child.stdin.close()
    except (BrokenPipeError, ValueError) as error:
        log(f"发送失败：{error}")
        state["failed"] = True
        state["error"] = str(error)

    deadline = time.time() + args.receipt_timeout
    while len(seen) < len(sent) and time.time() < deadline:
        if not take_receipt(max(0.1, deadline - time.time())):
            break

    unknown = [index for index, _b, _d in sent if index not in seen]
    ok_count = sum(1 for receipt in seen.values() if receipt.get("ok"))
    summary = {
        "sent": len(sent),
        "ok": ok_count,
        "unknown": unknown,
        "failed": state["failed"],
        "error": state["error"],
        "ms": int((time.time() - started) * 1000),
    }
    sys.stdout.write(json.dumps({"summary": summary}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    if child.poll() is None:
        child.terminate()
    failed = state["failed"] or bool(unknown) or ok_count != len(sent)
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
