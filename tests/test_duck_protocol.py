"""MicroDuck 播放协议的契约测试（不需要鸭子、不需要 SSH、不需要声卡）。

按 docs/TASK-BLACKBOARD.md 的「板端约定」逐条验：
  1. 多段一连接、回执 seq 递增、sha256 由板端自己算；
  2. 半帧、越界长度、非 16 位 PCM 都要失败且说得出原因；
  3. 跨读边界（一个字节一个字节喂）不能把帧读坏；
  4. 主机端把回执与发送记录对上，缺回执记为未知、不重播。
"""
from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELAY = ROOT / "scripts" / "duck_relay.py"

FAKE_APLAY = """\
import os, sys
data = sys.stdin.buffer.read()
log = os.environ.get('DUCK_FAKE_LOG')
if log:
    with open(log, 'a', encoding='utf-8') as handle:
        handle.write(os.environ.get('DUCK_FAKE_LABEL', 'call') + ' ' + str(len(data)) + '\\n')
code = int(os.environ.get('DUCK_FAKE_EXIT', '0'))
if code:
    sys.stderr.write('fake aplay refused\\n')
sys.exit(code)
"""


def tone_wav(seconds: float = 0.05, rate: int = 16000, width: int = 2) -> bytes:
    output = io.BytesIO()
    if width != 2:
        # 手搓 8 位 WAV，用来测「非 16 位」的拒绝
        frames = bytes(int(128 + 60 * ((i // 8) % 2)) for i in range(int(rate * seconds)))
        with wave.open(output, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(1)
            writer.setframerate(rate)
            writer.writeframes(frames)
        return output.getvalue()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        frames = b"".join(struct.pack("<h", 6000 if (i // 8) % 2 else -6000) for i in range(int(rate * seconds)))
        writer.writeframes(frames)
    return output.getvalue()


def frame(wav: bytes) -> bytes:
    return struct.pack("<I", len(wav)) + wav


class DuckProtocolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.fake = self.dir / "fake_aplay.py"
        self.fake.write_text(FAKE_APLAY, encoding="utf-8")
        self.log = self.dir / "aplay.log"
        self.env = {
            **os.environ,
            "DUCK_FAKE_LOG": str(self.log),
            "PYTHONIOENCODING": "utf-8",
        }

    def run_relay(self, payload: bytes, extra_env: dict | None = None, chunks: int = 0):
        env = dict(self.env)
        if extra_env:
            env.update(extra_env)
        command = [
            sys.executable, str(RELAY), "--local",
            "--aplay", f'{sys.executable} {self.fake}',
            "--receipt-timeout", "10",
        ]
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        if chunks and chunks > 1:
            step = max(1, len(payload) // chunks)
            for start in range(0, len(payload), step):
                process.stdin.write(payload[start:start + step])
                process.stdin.flush()
        else:
            process.stdin.write(payload)
            process.stdin.flush()
        out, err = process.communicate(timeout=60)
        lines = [json.loads(line) for line in out.decode("utf-8").splitlines() if line.strip()]
        return process.returncode, lines, err.decode("utf-8", "replace")

    def aplay_calls(self) -> int:
        if not self.log.exists():
            return 0
        return len([line for line in self.log.read_text(encoding="utf-8").splitlines() if line.strip()])

    def test_two_segments_get_two_receipts(self):
        first, second = tone_wav(0.05), tone_wav(0.08)
        code, lines, _err = self.run_relay(frame(first) + frame(second))
        receipts = [line for line in lines if "summary" not in line]
        self.assertEqual(code, 0)
        self.assertEqual([r["seq"] for r in receipts], [0, 1])
        self.assertTrue(all(r["ok"] for r in receipts))
        self.assertEqual(receipts[0]["bytes"], len(first))
        self.assertEqual(receipts[0]["alsa_exit_code"], 0)
        self.assertEqual(self.aplay_calls(), 2, "每段一次 aplay")
        summary = [line for line in lines if "summary" in line][0]["summary"]
        self.assertEqual((summary["sent"], summary["ok"], summary["unknown"]), (2, 2, []))

    def test_checksum_is_computed_by_the_board(self):
        import hashlib

        wav = tone_wav()
        _code, lines, _err = self.run_relay(frame(wav))
        receipt = [line for line in lines if "summary" not in line][0]
        self.assertEqual(receipt["sha256"], hashlib.sha256(wav).hexdigest())

    def test_frame_split_across_many_reads(self):
        wav = tone_wav(0.1)
        payload = frame(wav) + frame(wav)
        code, lines, _err = self.run_relay(payload, chunks=len(payload))
        receipts = [line for line in lines if "summary" not in line]
        self.assertEqual(code, 0)
        self.assertEqual(len(receipts), 2)
        self.assertTrue(all(r["ok"] for r in receipts))

    def run_player(self, payload: bytes):
        """直接跑板端播放器，验证它自己对坏帧的判定（绕过主机端的预校验）。"""
        command = [sys.executable, "-u", str(ROOT / "scripts" / "duck_player.py"),
                   "--aplay", f"{sys.executable} {self.fake}"]
        process = subprocess.run(command, input=payload, capture_output=True, timeout=60, env=self.env)
        lines = [json.loads(line) for line in process.stdout.decode("utf-8").splitlines() if line.strip()]
        return process.returncode, lines

    def test_zero_length_frame_is_rejected_by_the_board(self):
        code, lines = self.run_player(struct.pack("<I", 0))
        self.assertNotEqual(code, 0)
        self.assertFalse(lines[0]["ok"])
        self.assertIn("越界", lines[0]["error"])

    def test_truncated_payload_is_rejected_by_the_board(self):
        code, lines = self.run_player(struct.pack("<I", 500) + b"RIFF" + b"\x00" * 20)
        self.assertNotEqual(code, 0)
        self.assertFalse(lines[0]["ok"])
        self.assertIn("截断", lines[0]["error"])

    def test_relay_refuses_to_send_a_bad_frame(self):
        code, lines, err = self.run_relay(struct.pack("<I", 0))
        summary = [line for line in lines if "summary" in line][0]["summary"]
        self.assertNotEqual(code, 0, "主机端预校验就该失败，不把垃圾发给板子")
        self.assertTrue(summary["failed"])
        self.assertIn("越界", summary["error"] or err)

    def test_non_16bit_wav_is_rejected_but_session_continues(self):
        bad = tone_wav(0.05, width=1)
        good = tone_wav(0.05)
        code, lines, _err = self.run_relay(frame(bad) + frame(good))
        receipts = [line for line in lines if "summary" not in line]
        self.assertEqual([r["seq"] for r in receipts], [0, 1])
        self.assertFalse(receipts[0]["ok"])
        self.assertIn("16 位", receipts[0]["error"])
        self.assertTrue(receipts[1]["ok"], "坏的段不带走后面的段")
        self.assertNotEqual(code, 0, "有失败段时整体按失败返回")

    def test_aplay_failure_reports_exit_code(self):
        _code, lines, _err = self.run_relay(frame(tone_wav()), {"DUCK_FAKE_EXIT": "3"})
        receipt = [line for line in lines if "summary" not in line][0]
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["alsa_exit_code"], 3)
        self.assertIn("fake aplay refused", receipt["error"])

    def test_clean_eof_at_segment_boundary_is_success(self):
        code, lines, _err = self.run_relay(b"")
        summary = [line for line in lines if "summary" in line][0]["summary"]
        self.assertEqual(code, 0)
        self.assertEqual(summary["sent"], 0)


if __name__ == "__main__":
    unittest.main()
