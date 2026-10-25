from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests


def silent_wav() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 1600)
    return buffer.getvalue()


class FakeUpstreamHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/docs":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length))
        if not payload.get("text_lang"):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"missing text_lang")
            return
        audio = silent_wav()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, format: str, *args: object) -> None:
        return


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class GatewayHttpIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.install = cls.root / "gpt-sovits"
        (cls.install / "outputs").mkdir(parents=True)
        (cls.install / "GPT_weights").mkdir()
        (cls.install / "SoVITS_weights").mkdir()
        (cls.install / "api_v2.py").write_text("# fixture\n", encoding="utf-8")
        (cls.install / "webui.py").write_text("# fixture\n", encoding="utf-8")
        (cls.install / "GPT_weights" / "voice.ckpt").write_bytes(b"fixture")
        (cls.install / "SoVITS_weights" / "voice.pth").write_bytes(b"fixture")
        (cls.install / "outputs" / "reference.wav").write_bytes(silent_wav())

        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstreamHandler)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()

        cls.port = free_port()
        cls.auth_key = "integration" + "-auth"
        env = os.environ.copy()
        env.update(
            {
                "GPTSOVITS_HOME": str(cls.install),
                "GPTSOVITS_API_PORT": str(cls.upstream.server_port),
                "GATEWAY_HOST": "127.0.0.1",
                "GATEWAY_PORT": str(cls.port),
                "GATEWAY_API_KEY": cls.auth_key,
                "GATEWAY_STATE_FILE": str(cls.root / "gateway_state.json"),
            }
        )
        repo_root = Path(__file__).resolve().parents[1]
        cls.stdout = (cls.root / "gateway.stdout.log").open("w+", encoding="utf-8")
        cls.stderr = (cls.root / "gateway.stderr.log").open("w+", encoding="utf-8")
        cls.gateway = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "gateway.gateway:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(cls.port),
            ],
            cwd=repo_root,
            env=env,
            stdout=cls.stdout,
            stderr=cls.stderr,
        )

        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                response = requests.get(f"http://127.0.0.1:{cls.port}/healthz", timeout=0.5)
                if response.status_code == 200:
                    return
            except requests.RequestException:
                pass
            if cls.gateway.poll() is not None:
                break
            time.sleep(0.1)

        cls.stderr.flush()
        cls.stderr.seek(0)
        raise RuntimeError(f"gateway did not start:\n{cls.stderr.read()}")

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.gateway.poll() is None:
            cls.gateway.terminate()
            try:
                cls.gateway.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls.gateway.kill()
                cls.gateway.wait(timeout=5)
        cls.stdout.close()
        cls.stderr.close()
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.upstream_thread.join(timeout=5)
        cls.temp.cleanup()

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.auth_key}"}

    def test_end_to_end_http_contract(self) -> None:
        base = f"http://127.0.0.1:{self.port}"

        unauthenticated = requests.get(f"{base}/v1/audio/voices", timeout=5)
        self.assertEqual(unauthenticated.status_code, 401)

        registration = requests.post(
            f"{base}/v1/audio/voices",
            headers=self.headers(),
            json={
                "id": "local_voice",
                "gpt": "GPT_weights/voice.ckpt",
                "sovits": "SoVITS_weights/voice.pth",
                "ref_audio": "outputs/reference.wav",
                "ref_text": "reference transcript",
                "ref_lang": "zh",
                "text_lang": "zh",
            },
            timeout=10,
        )
        self.assertEqual(registration.status_code, 200, registration.text)

        synthesis = requests.post(
            f"{base}/v1/audio/speech",
            headers=self.headers(),
            json={
                "model": "tts-1",
                "voice": "local_voice",
                "input": "今日のデプロイは完了した。",
                "response_format": "wav",
            },
            timeout=15,
        )
        self.assertEqual(synthesis.status_code, 200, synthesis.text)
        self.assertEqual(synthesis.headers["Content-Type"].split(";")[0], "audio/wav")
        self.assertEqual(synthesis.content[:4], b"RIFF")
        self.assertEqual(synthesis.content[8:12], b"WAVE")


if __name__ == "__main__":
    unittest.main()
