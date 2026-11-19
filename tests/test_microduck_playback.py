import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import wave


path = Path(__file__).resolve().parents[1] / "scripts" / "play-microduck.py"
spec = importlib.util.spec_from_file_location("microduck_playback", path)
player = importlib.util.module_from_spec(spec)
spec.loader.exec_module(player)


def clip(sample):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(sample * 1600)
    return out.getvalue()


class MicroDuckPlaybackTest(unittest.TestCase):
    def test_digital_silence_and_truncation_fail_before_transport(self):
        with self.assertRaisesRegex(ValueError, "digitally silent"):
            player.inspect_wav(clip(b"\0\0"))
        with self.assertRaisesRegex(ValueError, "truncated"):
            player.inspect_wav(clip(b"\x20\0")[:-2])

    def test_ssh_transport_requires_the_matching_alsa_receipt(self):
        data = clip(b"\x20\0")
        report = player.inspect_wav(data)
        device = "plughw:CARD=Speaker,DEV=0"
        receipt = {"player": "aplay", "device": device, "bytes": len(data),
                   "sha256": report["sha256"], "alsa_exit_code": 0}
        with tempfile.TemporaryDirectory() as tmp:
            args = (data, report, "radxa@microduck.local", device, Path(tmp) / "known_hosts", None)
            with patch.object(player.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, json.dumps(receipt).encode(), b""
            )) as run:
                self.assertEqual(player.play(*args), receipt)
                self.assertIn("StrictHostKeyChecking=yes", run.call_args.args[0])
                self.assertEqual(run.call_args.kwargs["input"], data)
                run.return_value.stdout = json.dumps({**receipt, "sha256": "incorrect"}).encode()
                with self.assertRaisesRegex(ValueError, "receipt"):
                    player.play(*args)
                run.return_value.returncode = 1
                run.return_value.stderr = b"ALSA device busy"
                with self.assertRaisesRegex(ValueError, "ALSA device busy"):
                    player.play(*args)
