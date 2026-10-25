from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import gateway.gateway as gateway


class GatewayTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        (cls.root / "api_v2.py").write_text("# fixture\n", encoding="utf-8")
        (cls.root / "webui.py").write_text("# fixture\n", encoding="utf-8")
        (cls.root / "outputs").mkdir()
        (cls.root / "outputs" / "reference.wav").write_bytes(
            b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt "
        )
        (cls.root / "GPT_weights").mkdir()
        (cls.root / "GPT_weights" / "voice.ckpt").write_bytes(b"fixture")
        (cls.root / "SoVITS_weights").mkdir()
        (cls.root / "SoVITS_weights" / "voice.pth").write_bytes(b"fixture")

        cls.old_env = {
            key: os.environ.get(key)
            for key in (
                "GPTSOVITS_HOME",
                "GATEWAY_API_KEY",
                "GATEWAY_STATE_FILE",
                "GATEWAY_HOST",
            )
        }
        os.environ["GPTSOVITS_HOME"] = str(cls.root)
        os.environ["GATEWAY_API_KEY"] = "unit" + "-auth"
        os.environ["GATEWAY_STATE_FILE"] = str(cls.root / "gateway_state.json")
        os.environ["GATEWAY_HOST"] = "127.0.0.1"

        gateway.INSTALL = cls.root
        gateway.STATE_FILE = cls.root / "gateway_state.json"
        gateway.API_KEY = "unit" + "-auth"
        gateway.STATE_FILE.unlink(missing_ok=True)
        cls.client = TestClient(gateway.app)
        cls.headers = {"Authorization": "Bearer unit-auth"}

    @classmethod
    def tearDownClass(cls) -> None:
        for key, value in cls.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.temp.cleanup()

    def setUp(self) -> None:
        gateway.STATE_FILE.unlink(missing_ok=True)

    def register_voice(self) -> None:
        response = self.client.post(
            "/v1/audio/voices",
            headers=self.headers,
            json={
                "id": "local_voice",
                "gpt": "GPT_weights/voice.ckpt",
                "sovits": "SoVITS_weights/voice.pth",
                "ref_audio": "outputs/reference.wav",
                "ref_text": "exact reference transcript",
                "ref_lang": "zh",
                "text_lang": "zh",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)

    def test_health_does_not_require_a_key(self) -> None:
        with patch.object(gateway, "upstream_alive", return_value=False):
            response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], True)
        self.assertEqual(response.json()["upstream_alive"], False)

    def test_voice_listing_requires_a_key(self) -> None:
        response = self.client.get("/v1/audio/voices")
        self.assertEqual(response.status_code, 401)
        response = self.client.get("/v1/audio/voices", headers=self.headers)
        self.assertEqual(response.status_code, 200)

    def test_reference_path_escape_is_rejected(self) -> None:
        response = self.client.post(
            "/v1/audio/voices",
            headers=self.headers,
            json={
                "id": "bad",
                "ref_audio": "../outside.wav",
                "ref_text": "text",
            },
        )
        self.assertEqual(response.status_code, 400)

    def test_speech_declares_inferred_language(self) -> None:
        self.register_voice()
        captured: dict[str, object] = {}

        class Alive:
            status_code = 200

        class Upstream:
            status_code = 200
            content = b"RIFF....WAVE"
            text = ""

        def fake_post(url: str, json: dict, timeout: float) -> Upstream:
            captured["url"] = url
            captured["json"] = json
            captured["timeout"] = timeout
            return Upstream()

        with patch.object(gateway.requests, "get", return_value=Alive()):
            with patch.object(gateway.requests, "post", side_effect=fake_post):
                response = self.client.post(
                    "/v1/audio/speech",
                    headers=self.headers,
                    json={
                        "model": "tts-1",
                        "voice": "local_voice",
                        "input": "今日のデプロイは完了した。",
                        "response_format": "wav",
                    },
                )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(captured["url"], f"http://127.0.0.1:{gateway.UPSTREAM_PORT}/tts")
        self.assertEqual(captured["json"]["text_lang"], "ja")
        self.assertEqual(captured["json"]["prompt_lang"], "zh")

    def test_upstream_load_rejects_path_escape(self) -> None:
        class Alive:
            status_code = 200

        with patch.object(gateway, "upstream_alive", return_value=True):
            response = self.client.post(
                "/admin/upstream/load",
                headers=self.headers,
                json={"gpt": "../outside.ckpt"},
            )
        self.assertEqual(response.status_code, 400)

    def test_state_is_json_serializable(self) -> None:
        self.register_voice()
        state = json.loads(gateway.STATE_FILE.read_text(encoding="utf-8"))
        self.assertEqual(state["default_voice"], "local_voice")
        self.assertIn("local_voice", state["voices"])


if __name__ == "__main__":
    unittest.main()
