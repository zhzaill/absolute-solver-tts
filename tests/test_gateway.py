from __future__ import annotations

import io
import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import gateway.gateway as gateway


def pcm_wav(sample: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(sample * 16000)
    return output.getvalue()


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

        cls.headers = {"Authorization": "Bearer unit-auth"}

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def setUp(self) -> None:
        config_path = self.root / "config.json"
        self.enterContext(patch.multiple(gateway, INSTALL=self.root, CONFIG_PATH=config_path,
                                         _CONF={}, _CONF_MTIME=-1.0, _KEY_TOUCH={}))
        cfg = gateway._config_template()
        cfg["auth"]["cookie_secret"] = "test-session-secret"
        cfg["keys"] = [{"id": "test", "key": "unit-auth", "enabled": True}]
        gateway.save_config(cfg)
        self.admin_headers = {"X-Admin-Token": gateway.issue_session(cfg)[0]}
        self.client = self.enterContext(TestClient(gateway.app))

    def register_voice(self) -> None:
        response = self.client.post(
            "/admin/api/voices",
            headers=self.admin_headers,
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
            "/admin/api/voices",
            headers=self.admin_headers,
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
            content = pcm_wav(b"\x20\x00")
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
        self.assertEqual(captured["url"], "http://127.0.0.1:9880/tts")
        self.assertEqual(captured["json"]["text_lang"], "ja")
        self.assertEqual(captured["json"]["prompt_lang"], "zh")

    def test_refuses_successful_but_unusable_wav(self) -> None:
        self.register_voice()
        payload = {"input": "Test", "voice": "local_voice", "response_format": "wav"}
        silent = pcm_wav(b"\x00\x00")
        truncated = pcm_wav(b"\x20\x00")[:-2]
        for invalid in (b"", b"invalid WAV", silent, truncated):
            with self.subTest(size=len(invalid)), patch.object(
                gateway, "_call_upstream", return_value=type("Upstream", (), {"status_code": 200, "content": invalid})()
            ):
                client = self.client.post("/v1/audio/speech", headers=self.headers, json=payload)
                admin = self.client.post("/admin/api/test", headers=self.admin_headers, json=payload)
                self.assertEqual(client.status_code, 502)
                self.assertEqual(admin.status_code, 502)

    def test_upstream_load_rejects_path_escape(self) -> None:
        class Alive:
            status_code = 200

        with patch.object(gateway, "upstream_alive", return_value=True):
            response = self.client.post(
                "/admin/api/upstream/load",
                headers=self.admin_headers,
                json={"gpt": "../outside.ckpt"},
            )
        self.assertEqual(response.status_code, 400)

    def test_state_is_json_serializable(self) -> None:
        self.register_voice()
        state = json.loads(gateway.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(state["defaults"]["voice"], "local_voice")
        self.assertIn("local_voice", state["voices"])


if __name__ == "__main__":
    unittest.main()
