"""
GPT-SoVITS OpenAI 兼容 API 网关
================================

把本地 GPT-SoVITS 模型暴露成标准的 OpenAI 语音接口，任何支持 OpenAI 的客户端
（OpenAI SDK、LangChain、SillyTavern、各种 TTS 前端）都能直接调用。

核心设计：**参考音频只需设一次**，之后客户端请求只要给 text。
（官方 api_v2.py 要求每次请求都传 ref_audio_path，这层网关补上这个缺口。）

对外接口
--------
  POST /v1/audio/speech          OpenAI 兼容：{"input": "...", "voice": "xxx"} → 音频
  GET  /v1/audio/voices          列出可用音色（= 每个模型一套参考音频）
  GET  /v1/models                OpenAI 兼容模型列表
  POST /v1/audio/voices          注册/更新音色（绑定模型 + 参考音频）
  GET  /healthz                  健康检查

事实依据（均已双次验证）
  - 官方接口 5 个：/tts /control /set_refer_audio /set_gpt_weights /set_sovits_weights
  - /tts 必填：text, text_lang, ref_audio_path, prompt_lang（api_v2.py:305-342）
  - 权重命名：SoVITS=.pth (config.py:95)，GPT=.ckpt (config.py:107)
  - 日志实测：/set_*_weights 返回 {"message":"success"}
"""

from __future__ import annotations

import io
import re
import json
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, List, Optional

import requests
import uvicorn
from fastapi import Body, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------

GATEWAY_DIR = Path(__file__).resolve().parent
WORKSPACE = GATEWAY_DIR.parent

# 网关自身端口（18080：空闲、不在系统保留区间、与原 7800/9880/9874 不冲突）
PORT = int(os.environ.get("GATEWAY_PORT", "18080"))
HOST = os.environ.get("GATEWAY_HOST", "127.0.0.1")

# 上游官方 api_v2.py
UPSTREAM_PORT = int(os.environ.get("GPTSOVITS_API_PORT", "9880"))
UPSTREAM = f"http://127.0.0.1:{UPSTREAM_PORT}"

# 可选 API Key；为空则不校验（局域网内网使用）
API_KEY = os.environ.get("GATEWAY_API_KEY", "").strip()

STATE_FILE = Path(
    os.environ.get("GATEWAY_STATE_FILE", str(GATEWAY_DIR / "gateway_state.json"))
).expanduser()

CORS_ORIGINS = [
    value.strip()
    for value in os.environ.get("GATEWAY_CORS_ORIGINS", "*").split(",")
    if value.strip()
]


def find_install() -> Optional[Path]:
    env = os.environ.get("GPTSOVITS_HOME")
    if env and (Path(env) / "api_v2.py").is_file():
        return Path(env)
    for base in (GATEWAY_DIR, WORKSPACE):
        if (base / "api_v2.py").is_file() and (base / "webui.py").is_file():
            return base
        if base.is_dir():
            for c in base.iterdir():
                if c.is_dir() and (c / "api_v2.py").is_file() and (c / "webui.py").is_file():
                    return c
    return None


INSTALL = find_install()

SOVITS_DIRS = [
    "SoVITS_weights", "SoVITS_weights_v2", "SoVITS_weights_v3",
    "SoVITS_weights_v4", "SoVITS_weights_v2Pro", "SoVITS_weights_v2ProPlus",
]
GPT_DIRS = [
    "GPT_weights", "GPT_weights_v2", "GPT_weights_v3",
    "GPT_weights_v4", "GPT_weights_v2Pro", "GPT_weights_v2ProPlus",
]

DEFAULT_STATE: dict[str, Any] = {
    # 音色表：voice_id -> {model, gpt, sovits, ref_audio, ref_text, ref_lang, text_lang}
    "voices": {},
    "default_voice": None,
}


# ----------------------------------------------------------------------------
# 状态
# ----------------------------------------------------------------------------


def load_state() -> dict[str, Any]:
    if STATE_FILE.is_file():
        try:
            s = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            s.setdefault("voices", {})
            s.setdefault("default_voice", None)
            return s
        except Exception:
            pass
    return json.loads(json.dumps(DEFAULT_STATE))


def save_state(s: dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


def upstream_alive(timeout: float = 2.0) -> bool:
    try:
        return requests.get(f"{UPSTREAM}/docs", timeout=timeout).status_code == 200
    except Exception:
        return False


# --- text language inference -------------------------------------------------
# The OpenAI /v1/audio/speech schema has no field for the language of `input`,
# so Amadeus's openai_compatible backend cannot transmit it: its payload is
# only {model, input, voice, response_format, speed}. A GPT-SoVITS-class engine
# selects its frontend from text_lang, so unconditionally reusing the voice's
# configured language reads Japanese text with the Chinese frontend and drops
# the kana. Infer it from the text instead, and keep the configured value as
# the last resort. A voice can opt out with "auto_text_lang": false.
_KANA_RE = re.compile(r'[\u3040-\u309f\u30a0-\u30ff]')
_HAN_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')
_LATIN_RE = re.compile(r'[A-Za-z]')


def _detect_text_lang(text: str) -> str:
    """Best-effort language of the text to synthesize: ja, zh, en or ''."""
    value = str(text or '')
    if _KANA_RE.search(value):
        return 'ja'
    if _HAN_RE.search(value):
        return 'zh'
    if _LATIN_RE.search(value):
        return 'en'
    return ''

def check_key(authorization: Optional[str], x_api_key: Optional[str]) -> None:
    if not API_KEY:
        return
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif x_api_key:
        token = x_api_key.strip()
    if not secrets.compare_digest(token, API_KEY):
        raise HTTPException(401, "Invalid API key")


def resolve_install_file(
    relative_path: str,
    *,
    label: str,
    extensions: tuple[str, ...],
) -> Path:
    """Resolve a runtime asset inside GPTSOVITS_HOME, rejecting path escapes."""
    if not INSTALL:
        raise HTTPException(400, "未找到 GPT-SoVITS 安装目录，不能校验资产路径")
    raw = str(relative_path or "").strip()
    if not raw:
        raise HTTPException(400, f"{label} 不能为空")
    root = INSTALL.resolve()
    candidate = (root / raw).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise HTTPException(400, f"{label} 必须位于 GPT-SoVITS 目录内") from None
    if candidate.suffix.lower() not in extensions:
        allowed = ", ".join(extensions)
        raise HTTPException(400, f"{label} 扩展名必须是 {allowed}")
    if not candidate.is_file():
        raise HTTPException(400, f"{label} 不存在: {raw}")
    return candidate


# ----------------------------------------------------------------------------
# 应用
# ----------------------------------------------------------------------------

app = FastAPI(title="GPT-SoVITS OpenAI Gateway", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or ["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.get("/")
def root(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_key(authorization, x_api_key)
    s = load_state()
    return {
        "service": "GPT-SoVITS OpenAI Gateway",
        "upstream": UPSTREAM,
        "upstream_alive": upstream_alive(),
        "auth_required": bool(API_KEY),
        "voices": list(s["voices"].keys()),
        "default_voice": s["default_voice"],
        "endpoints": {
            "speech": "POST /v1/audio/speech",
            "voices": "GET|POST /v1/audio/voices",
            "models": "GET /v1/models",
            "health": "GET /healthz",
        },
    }


@app.get("/healthz")
def healthz():
    return {"ok": True, "upstream_alive": upstream_alive(), "ts": int(time.time())}


# ---------------- 音色管理 ----------------


@app.get("/v1/audio/voices")
def list_voices(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_key(authorization, x_api_key)
    s = load_state()
    return {
        "default": s["default_voice"],
        "voices": [
            {"id": vid, **{k: v for k, v in v.items() if k != "model"}}
            for vid, v in s["voices"].items()
        ],
    }


@app.post("/v1/audio/voices")
def upsert_voice(
    payload: dict = Body(...),
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    """
    注册/更新一个音色。客户端之后只需用 voice id 调用 /v1/audio/speech。
    """
    check_key(authorization, x_api_key)

    vid = (payload.get("id") or "").strip()
    if not vid:
        raise HTTPException(400, "id is required (音色名)")

    ref = (payload.get("ref_audio") or "").strip()
    ref_text = (payload.get("ref_text") or "").strip()
    if not ref:
        raise HTTPException(400, "ref_audio is required（参考音频相对路径，如 output/x.wav）")
    if not ref_text:
        raise HTTPException(400, "ref_text is required（参考音频的原文，必须完全一致）")

    resolve_install_file(
        ref,
        label="参考音频",
        extensions=(".wav", ".mp3", ".flac", ".m4a", ".ogg"),
    )

    gpt = payload.get("gpt") or None
    sovits = payload.get("sovits") or None
    if gpt:
        resolve_install_file(gpt, label="GPT 权重", extensions=(".ckpt",))
    if sovits:
        resolve_install_file(sovits, label="SoVITS 权重", extensions=(".pth",))

    s = load_state()
    s["voices"][vid] = {
        "gpt": gpt,
        "sovits": sovits,
        "ref_audio": ref,
        "ref_text": ref_text,
        "ref_lang": payload.get("ref_lang", "zh"),
        "text_lang": payload.get("text_lang", payload.get("ref_lang", "zh")),
        "speed": float(payload.get("speed", 1.0)),
    }
    if not s["default_voice"]:
        s["default_voice"] = vid
    save_state(s)
    return {"ok": True, "voice": vid, "default": s["default_voice"]}


@app.post("/v1/audio/voices/default")
def set_default_voice(
    payload: dict = Body(...),
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_key(authorization, x_api_key)
    vid = (payload.get("id") or "").strip()
    s = load_state()
    if vid not in s["voices"]:
        raise HTTPException(404, f"音色不存在: {vid}")
    s["default_voice"] = vid
    save_state(s)
    return {"ok": True, "default": vid}


@app.delete("/v1/audio/voices/{vid}")
def delete_voice(
    vid: str,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_key(authorization, x_api_key)
    s = load_state()
    if vid not in s["voices"]:
        raise HTTPException(404, "音色不存在")
    del s["voices"][vid]
    if s["default_voice"] == vid:
        s["default_voice"] = next(iter(s["voices"]), None)
    save_state(s)
    return {"ok": True}


# ---------------- OpenAI 兼容 ----------------


@app.get("/v1/models")
def list_models(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    """OpenAI 兼容模型列表。"""
    check_key(authorization, x_api_key)
    s = load_state()
    scanned = scan_weights()
    now = int(time.time())
    data = []
    for vid in s["voices"]:
        data.append({"id": vid, "object": "model", "created": now, "owned_by": "gpt-sovits"})
    for kind, items in scanned.items():
        for it in items:
            if it["builtin"]:
                continue
            data.append({
                "id": f"{kind.lower()}:{it['name']}",
                "object": "model", "created": it["mtime"], "owned_by": "gpt-sovits",
            })
    if not data:
        data.append({"id": "gpt-sovits", "object": "model", "created": now, "owned_by": "gpt-sovits"})
    return {"object": "list", "data": data}


def scan_weights() -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {"SoVITS": [], "GPT": []}
    if not INSTALL:
        return out
    for kind, dirs, ext in (("SoVITS", SOVITS_DIRS, ".pth"), ("GPT", GPT_DIRS, ".ckpt")):
        for d in dirs:
            full = INSTALL / d
            if not full.is_dir():
                continue
            for f in sorted(full.iterdir()):
                if f.is_file() and f.suffix.lower() == ext:
                    out[kind].append({
                        "name": f.stem, "rel": f"{d}/{f.name}",
                        "size": f.stat().st_size, "mtime": int(f.stat().st_mtime),
                        "builtin": False,
                    })
    return out


@app.post("/v1/audio/speech")
async def speech(
    request: Request,
    payload: dict = Body(...),
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    """
    OpenAI 兼容语音合成。

    请求体：
      {
        "input": "要说的文字",          # 必填（兼容 "text"）
        "voice": "音色名",              # 可选，缺省用默认音色
        "response_format": "wav",       # 可选，wav|mp3|opus|aac|flac|pcm
        "speed": 1.0,                   # 可选
        "__ref_audio": "output/x.wav",  # 可选，临时指定参考音频（无需预注册）
        "__ref_text": "...",            # 与上面配对
        "__prompt_lang": "zh"
      }
    """
    check_key(authorization, x_api_key)

    if not upstream_alive():
        raise HTTPException(503, f"上游 TTS 服务未运行（{UPSTREAM}）。请先启动 api_v2.py")

    text = (payload.get("input") or payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "input is required")

    s = load_state()
    vid = (payload.get("voice") or payload.get("voice_id") or s["default_voice"] or "").strip()

    cfg: dict[str, Any]
    if vid and vid in s["voices"]:
        cfg = dict(s["voices"][vid])
    elif payload.get("__ref_audio"):
        resolve_install_file(
            payload["__ref_audio"],
            label="临时参考音频",
            extensions=(".wav", ".mp3", ".flac", ".m4a", ".ogg"),
        )
        cfg = {
            "gpt": None, "sovits": None,
            "ref_audio": payload["__ref_audio"],
            "ref_text": payload.get("__ref_text", ""),
            "ref_lang": payload.get("__prompt_lang", "zh"),
            "text_lang": (payload.get("text_lang") or "").strip()
                or _detect_text_lang(text)
                or payload.get("__prompt_lang", "zh"),
            "speed": 1.0,
        }
    else:
        raise HTTPException(
            400,
            "没有可用音色。请先 POST /v1/audio/voices 注册，或在请求里带 __ref_audio/__ref_text。"
            + (f"（当前音色: {list(s['voices'].keys())}）" if s["voices"] else ""),
        )

    if not cfg.get("ref_text"):
        raise HTTPException(400, f"音色 '{vid}' 缺少 ref_text（参考音频原文）")

    fmt = (payload.get("response_format") or "wav").lower()
    if fmt == "mp3":
        fmt = "aac"  # 上游只支持 wav/raw/ogg/aac

    body = {
        "text": text,
        "text_lang": (payload.get("text_lang") or "").strip()
        or (_detect_text_lang(text) if cfg.get("auto_text_lang", True) else "")
        or cfg.get("text_lang", "zh"),
        "ref_audio_path": cfg["ref_audio"],
        "prompt_text": cfg["ref_text"],
        "prompt_lang": payload.get("prompt_lang") or cfg.get("ref_lang", "zh"),
        "top_k": payload.get("top_k", 15),
        "top_p": payload.get("top_p", 1),
        "temperature": payload.get("temperature", 1),
        "text_split_method": payload.get("text_split_method", "cut5"),
        "batch_size": 1,
        "speed_factor": float(payload.get("speed") or cfg.get("speed") or 1.0),
        "repetition_penalty": payload.get("repetition_penalty", 1.35),
        "seed": payload.get("seed", -1),
        "media_type": fmt,
        "streaming_mode": bool(payload.get("stream", False)),
    }

    try:
        r = requests.post(f"{UPSTREAM}/tts", json=body,
                          timeout=float(payload.get("timeout", 600)))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"调用上游失败: {e}") from e

    if r.status_code != 200:
        raise HTTPException(r.status_code, f"上游返回: {r.text[:300]}")

    mime = {
        "wav": "audio/wav", "raw": "application/octet-stream",
        "ogg": "audio/ogg", "aac": "audio/aac",
    }.get(fmt, "audio/wav")

    return Response(content=r.content, media_type=mime)


# ----------------------------------------------------------------------------
# 上游服务管理
# ----------------------------------------------------------------------------

PROC: dict[str, Any] = {"popen": None, "log": None, "started_at": None}


@app.get("/admin/upstream/status")
def upstream_status(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_key(authorization, x_api_key)
    return {
        "upstream": UPSTREAM,
        "alive": upstream_alive(),
        "managed": PROC["popen"] is not None and PROC["popen"].poll() is None,
        "started_at": PROC["started_at"],
        "log_tail": _tail(40),
    }


def _tail(n: int = 40) -> list[str]:
    if not INSTALL:
        return []
    p = INSTALL / "gateway_upstream.log"
    if not p.is_file():
        return []
    try:
        return p.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
    except Exception:
        return []


@app.post("/admin/upstream/start")
def upstream_start(
    payload: dict = Body(default={}),
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_key(authorization, x_api_key)
    if upstream_alive():
        return {"ok": True, "already": True}
    if not INSTALL:
        raise HTTPException(400, "未找到 GPT-SoVITS 安装目录")
    python_candidates = [
        INSTALL / "runtime" / "python.exe",
        INSTALL / "runtime" / "python",
        INSTALL / ".venv" / "Scripts" / "python.exe",
        INSTALL / ".venv" / "bin" / "python",
    ]
    py = next((candidate for candidate in python_candidates if candidate.is_file()), None)
    if py is None:
        fallback = shutil.which("python3") or shutil.which("python")
        if fallback is None:
            raise HTTPException(400, "未找到 GPT-SoVITS 运行时 Python")
        py = Path(fallback)

    cfg = payload.get("config") or "GPT_SoVITS/configs/tts_infer.yaml"
    resolve_install_file(cfg, label="上游配置", extensions=(".yaml", ".yml"))
    logf = open(INSTALL / "gateway_upstream.log", "a", encoding="utf-8", buffering=1)
    logf.write(f"\n=== gateway start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
    p = subprocess.Popen(
        [str(py), "api_v2.py", "-a", "127.0.0.1", "-p", str(UPSTREAM_PORT), "-c", cfg],
        cwd=str(INSTALL), stdout=logf, stderr=subprocess.STDOUT,
    )
    PROC.update({"popen": p, "log": logf,
                 "started_at": time.strftime("%Y-%m-%d %H:%M:%S")})

    deadline = time.time() + 180
    while time.time() < deadline:
        if upstream_alive(2):
            return {"ok": True, "ready": True}
        if p.poll() is not None:
            raise HTTPException(500, f"进程退出 code={p.returncode}，见 gateway_upstream.log")
        time.sleep(2)
    return {"ok": True, "ready": False, "note": "仍在启动"}


@app.post("/admin/upstream/stop")
def upstream_stop(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    check_key(authorization, x_api_key)
    p = PROC.get("popen")
    if p is not None and p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            p.kill()
    if upstream_alive():
        try:
            requests.get(f"{UPSTREAM}/control", params={"command": "exit"}, timeout=10)
        except Exception:
            pass
    if PROC.get("log"):
        try:
            PROC["log"].close()
        except Exception:
            pass
    PROC.update({"popen": None, "log": None, "started_at": None})
    time.sleep(1)
    return {"ok": True, "alive": upstream_alive()}


@app.post("/admin/upstream/load")
def upstream_load(
    payload: dict = Body(...),
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    """把某个模型的权重加载进上游服务（热切换）。"""
    check_key(authorization, x_api_key)
    if not upstream_alive():
        raise HTTPException(503, "上游未运行")
    out: dict[str, Any] = {}
    for key in ("gpt", "sovits"):
        rel = payload.get(key)
        if not rel:
            continue
        extensions = (".ckpt",) if key == "gpt" else (".pth",)
        resolve_install_file(rel, label=f"{key} 权重", extensions=extensions)
        try:
            r = requests.get(f"{UPSTREAM}/set_{key}_weights",
                             params={"weights_path": rel}, timeout=180)
            out[key] = {"ok": r.status_code == 200, "status": r.status_code, "body": r.text[:200]}
        except Exception as e:  # noqa: BLE001
            out[key] = {"ok": False, "error": str(e)}
    if out and not any(v.get("ok") for v in out.values()):
        raise HTTPException(400, f"加载失败: {out}")
    return {"ok": True, "results": out}


if __name__ == "__main__":
    print("=" * 66)
    print(" GPT-SoVITS OpenAI Gateway")
    print("=" * 66)
    print(f" 安装目录 : {INSTALL or '【未找到】'}")
    print(f" 网关地址 : http://{HOST}:{PORT}")
    print(f" OpenAI   : POST http://<你的IP>:{PORT}/v1/audio/speech")
    print(f" 上游 TTS : {UPSTREAM}")
    print(f" 鉴权     : {'已启用 API Key' if API_KEY else '未启用（仅限回环地址）'}")
    print("=" * 66)
    if not API_KEY and HOST not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit(
            "拒绝在非回环地址上无鉴权启动。请设置 GATEWAY_API_KEY，"
            "或把 GATEWAY_HOST 改为 127.0.0.1。"
        )
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
