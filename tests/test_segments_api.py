from __future__ import annotations

import io
import json
import struct
import threading
import unittest
import wave
from unittest.mock import patch

from fastapi.testclient import TestClient

import gateway.gateway as gateway


def tone_wav(rate=32000, silence=0.5, voice=0.2) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        frames = [0] * int(rate * silence) + [9000, -9000] * int(rate * voice / 2)
        writer.writeframes(b"".join(struct.pack("<h", v) for v in frames))
    return output.getvalue()


def parse_frames(body: bytes):
    offset = 0
    metas, audios = [], []
    while offset < len(body):
        size, kind = struct.unpack("<IB", body[offset:offset + 5])
        payload = body[offset + 5:offset + 5 + size]
        assert len(payload) == size
        if kind == 0:
            metas.append(json.loads(payload.decode("utf-8")))
        else:
            audios.append(payload)
        offset += 5 + size
    assert offset == len(body)
    return metas, audios


class SegmentsEndpointTest(unittest.TestCase):
    def setUp(self) -> None:
        cfg = gateway._config_template()
        cfg["voices"] = {
            "unit": {
                "gpt": "", "sovits": "", "ref_audio": "outputs/ref.wav", "ref_text": "参考文本",
                "ref_lang": "zh", "text_lang": "zh", "speed": 1.0,
            }
        }
        self.cfg = cfg
        self.requests = []

        def fake_call(body, timeout):
            self.requests.append(dict(body))
            return tone_wav(), 80

        self.client = self.enterContext(TestClient(gateway.app))
        self.enterContext(patch.multiple(
            gateway,
            require_client=lambda *a, **k: {"name": "unit"},
            load_config=lambda *a, **k: self.cfg,
            _upstream_stream_call=lambda cfg: fake_call,
            _SLOTS=threading.BoundedSemaphore(4),
        ))

    def post(self, **payload):
        body = {"input": "你好。这是第二句。", "voice": "unit"}
        body.update(payload)
        return self.client.post("/v1/audio/segments", json=body)

    def test_stream_returns_frames_in_order(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("application/x-tts-segments"))
        self.assertEqual(response.headers["x-tts-engine"], "pipeline")

        metas, audios = parse_frames(response.content)
        kinds = [m["kind"] for m in metas]
        self.assertEqual(kinds[0], "plan")
        self.assertEqual(kinds[-1], "done")
        self.assertGreaterEqual(len(audios), 2)

        plan = metas[0]
        self.assertEqual(plan["count"], len(plan["units"]))
        segment_metas = [m for m in metas if m["kind"] == "segment"]
        self.assertEqual([m["index"] for m in segment_metas], list(range(len(segment_metas))))
        self.assertTrue(all(m["status"] == "ok" for m in segment_metas))

    def test_first_unit_uses_first_tier(self):
        self.post()
        self.assertGreaterEqual(len(self.requests), 2)
        first, later = self.requests[0], self.requests[1]
        self.assertEqual(first["sample_steps"], gateway.stream_pipeline.FIRST_TIER.sample_steps)
        self.assertEqual(later["sample_steps"], gateway.stream_pipeline.LATER_TIER.sample_steps)
        self.assertEqual(first["text_split_method"], "cut0")
        self.assertEqual(first["media_type"], "wav")

    def test_leading_silence_is_trimmed_before_delivery(self):
        response = self.post()
        metas, audios = parse_frames(response.content)
        segment_metas = [m for m in metas if m["kind"] == "segment"]
        self.assertGreater(segment_metas[0]["lead_ms"], 400)
        with wave.open(io.BytesIO(audios[0]), "rb") as reader:
            seconds = reader.getnframes() / reader.getframerate()
        # 0.5 s 静音被裁掉大半，只剩 50 ms 预滚 + 有声部分
        self.assertLess(seconds, 0.4)

    def test_empty_input_is_rejected(self):
        response = self.post(input="   ")
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
