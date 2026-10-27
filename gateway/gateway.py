"""TTS Service —— 局域网共享的 OpenAI 兼容语音合成服务
=====================================================

一个进程同时提供三件事：

  1. **OpenAI 兼容接口**（给 Hub、DSH 插件、AnythingLLM、SillyTavern 等客户端）
       POST /v1/audio/speech     合成，返回音频
       GET  /v1/audio/voices     可用音色
       GET  /v1/models           OpenAI 兼容模型列表
       GET  /healthz             健康检查（公开，供探活使用）
  2. **配置界面**（浏览器打开 http://<服务器>:18080/admin）
       音色管理、客户端密钥、服务设置、上游进程、最近请求、调用示例
  3. **浏览器侧播放**：配置界面里可直接试听，不需要额外工具

设计边界（2026-10-27 定稿）
--------------------------
  * 客户端鉴权：`Authorization: Bearer sk-...` 或 `x-api-key`，多把密钥、可停用、可轮换。
  * 管理鉴权：独立管理员口令，HttpOnly 会话 Cookie；不与客户端密钥共用。
  * 监听地址来自 config.json（默认 0.0.0.0:18080），因此必须存在管理员口令与至少一把客户端密钥。
  * **不做伪流式**：上游分段响应在本服务被完整收齐后再返回。`/v1/audio/speech` 返回的是
    完整音频，与 OpenAI 的语义一致。Provider 侧流式 PCM 属于独立任务，见
    `D:\\11\\Logs\\2026-10-27-tts-streaming-pcm-可行性判定.md`。
  * 参考音频只需注册一次（`/v1/audio/voices`），之后客户端只传 text；语言由文本推断，
    可用 `text_lang` 显式覆盖。

运行
----
    python gateway.py                 # 读取同目录 config.json
    TTS_CONFIG=... python gateway.py  # 指定配置文件

配套启动器（含崩溃/改端口后的自动重启）见 `run-tts-service.cmd`。
"""

from __future__ import annotations

import collections
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
import uvicorn
from fastapi import Body, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

VERSION = "2.0.0"
SERVICE_NAME = "tts-service"
ADMIN_COOKIE = "tts_admin"

GATEWAY_DIR = Path(__file__).resolve().parent
UI_DIR = GATEWAY_DIR / "ui"
CONFIG_PATH = Path(os.environ.get("TTS_CONFIG", str(GATEWAY_DIR / "config.json"))).expanduser()
LEGACY_STATE_PATH = GATEWAY_DIR / "gateway_state.json"

# 退出码 75：请求启动器重启（配置改了监听地址/并发时需要重新 bind）。
EXIT_RESTART = 75


# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": 2,
    "server": {
        "host": "0.0.0.0",
        "port": 18080,
        # 写进调用示例里给客户端用的地址；留空则由监听地址推断
        "public_base_url": "",
    },
    "upstream": {
        "base": "http://127.0.0.1:9880",
        "api_host": "127.0.0.1",
        "api_port": 9880,
        "config_path": "GPT_SoVITS/configs/tts_infer.yaml",
        "log_path": "",
        "timeout_seconds": 600,
        "start_timeout_seconds": 180,
    },
    "auth": {
        "admin_password_hash": "",
        "cookie_secret": "",
        "session_hours": 12,
        "allow_remote_setup": False,
    },
    "keys": [],
    "defaults": {"voice": None, "response_format": "wav", "speed": 1.0},
    "limits": {"max_input_chars": 2000, "max_concurrent": 2},
    # voice_id -> {gpt, sovits, ref_audio, ref_text, ref_lang, text_lang, speed, auto_text_lang}
    "voices": {},
}

RESTART_FIELDS = {
    "server.host",
    "server.port",
    "limits.max_concurrent",
}

CONFIG_LOCK = threading.RLock()
_CONF: Dict[str, Any] = {}
_CONF_MTIME: float = -1.0


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _config_template() -> Dict[str, Any]:
    return json.loads(json.dumps(DEFAULT_CONFIG))


def _read_config_file() -> Dict[str, Any]:
    if not CONFIG_PATH.is_file():
        return {}
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def save_config(cfg: Dict[str, Any]) -> None:
    global _CONF, _CONF_MTIME
    with CONFIG_LOCK:
        _atomic_write(CONFIG_PATH, json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
        _CONF = cfg
        try:
            _CONF_MTIME = CONFIG_PATH.stat().st_mtime
        except OSError:
            _CONF_MTIME = -1.0


def load_config(force: bool = False) -> Dict[str, Any]:
    """读取配置；文件被外部改动时自动重新加载。"""
    global _CONF, _CONF_MTIME
    with CONFIG_LOCK:
        try:
            mtime = CONFIG_PATH.stat().st_mtime
        except OSError:
            mtime = -1.0
        if _CONF and not force and mtime == _CONF_MTIME:
            return _CONF
        cfg = _deep_merge(_config_template(), _read_config_file())
        if not cfg["auth"].get("cookie_secret"):
            cfg["auth"]["cookie_secret"] = secrets.token_hex(32)
        _CONF = cfg
        _CONF_MTIME = mtime
        return cfg


def _migrate_legacy_state(cfg: Dict[str, Any]) -> bool:
    """把 v1 的 gateway_state.json（音色表）并入 v2 配置。"""
    if cfg.get("voices"):
        return False
    if not LEGACY_STATE_PATH.is_file():
        return False
    try:
        old = json.loads(LEGACY_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return False
    voices = old.get("voices") or {}
    if not isinstance(voices, dict) or not voices:
        return False
    cfg["voices"] = voices
    if not cfg["defaults"].get("voice"):
        cfg["defaults"]["voice"] = old.get("default_voice") or next(iter(voices), None)
    return True


def bootstrap_config() -> Dict[str, Any]:
    """首次启动：迁移旧音色、写死 Cookie 密钥、从环境变量取管理员口令。"""
    cfg = load_config(force=True)
    changed = not CONFIG_PATH.is_file()
    if _migrate_legacy_state(cfg):
        changed = True
    if not cfg["auth"].get("cookie_secret"):
        cfg["auth"]["cookie_secret"] = secrets.token_hex(32)
        changed = True
    env_password = os.environ.get("TTS_ADMIN_PASSWORD", "").strip()
    if env_password and not cfg["auth"].get("admin_password_hash"):
        cfg["auth"]["admin_password_hash"] = hash_password(env_password)
        changed = True
    if changed:
        save_config(cfg)
    return cfg


# ----------------------------------------------------------------------------
# 口令 / 会话 / 客户端密钥
# ----------------------------------------------------------------------------

PBKDF2_ROUNDS = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS
    ).hex()
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt}${digest}"


def verify_password(password: str, encoded: str) -> bool:
    if not encoded or not password:
        return False
    try:
        algo, rounds, salt, digest = encoded.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("utf-8"), int(rounds)
        ).hex()
        return hmac.compare_digest(candidate, digest)
    except Exception:
        return False


def _sign_exp(exp: int, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"), f"v1:{exp}".encode("utf-8"), hashlib.sha256
    ).hexdigest()[:32]


def issue_session(cfg: Dict[str, Any]) -> Tuple[str, int]:
    ttl = int(float(cfg["auth"].get("session_hours") or 12) * 3600)
    ttl = max(300, min(ttl, 30 * 24 * 3600))
    exp = int(time.time()) + ttl
    return f"{exp}.{_sign_exp(exp, cfg['auth']['cookie_secret'])}", ttl


def session_valid(token: str, cfg: Dict[str, Any]) -> bool:
    if not token or "." not in token:
        return False
    exp_text, signature = token.split(".", 1)
    try:
        exp = int(exp_text)
    except ValueError:
        return False
    if exp < time.time():
        return False
    return hmac.compare_digest(signature, _sign_exp(exp, cfg["auth"]["cookie_secret"]))


def _owner_key(token: str, cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """在已启用密钥中做常量时间比对，返回命中的密钥记录。"""
    if not token:
        return None
    hit: Optional[Dict[str, Any]] = None
    for record in cfg.get("keys") or []:
        if not isinstance(record, dict):
            continue
        if not record.get("enabled", True):
            continue
        expected = str(record.get("key") or "")
        if expected and secrets.compare_digest(expected, token):
            hit = record
    return hit


_KEY_TOUCH: Dict[str, Tuple[int, float]] = {}
_KEY_TOUCH_LOCK = threading.Lock()


def _touch_key(record: Dict[str, Any]) -> None:
    """计数留在内存，靠周期性落盘避免每个请求都写磁盘。"""
    kid = str(record.get("id") or "")
    with _KEY_TOUCH_LOCK:
        count, last = _KEY_TOUCH.get(kid, (int(record.get("uses") or 0), 0.0))
        _KEY_TOUCH[kid] = (count + 1, time.time())


def _flush_key_usage() -> None:
    with _KEY_TOUCH_LOCK:
        if not _KEY_TOUCH:
            return
        pending = dict(_KEY_TOUCH)
        _KEY_TOUCH.clear()
    cfg = load_config()
    changed = False
    for record in cfg.get("keys") or []:
        kid = str(record.get("id") or "")
        if kid in pending:
            count, last = pending[kid]
            record["uses"] = count
            record["last_used_at"] = int(last)
            changed = True
    if changed:
        save_config(cfg)


def _flush_loop() -> None:
    while True:
        time.sleep(30)
        try:
            _flush_key_usage()
        except Exception:
            pass


def require_client(authorization: Optional[str], x_api_key: Optional[str]) -> Dict[str, Any]:
    cfg = load_config()
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif x_api_key:
        token = x_api_key.strip()
    if not (cfg.get("keys") or []):
        raise HTTPException(503, "服务尚未创建客户端密钥，请先在配置界面创建")
    record = _owner_key(token, cfg)
    if record is None:
        raise HTTPException(401, "Invalid API key")
    _touch_key(record)
    return record


def _admin_token(request: Request) -> str:
    return request.headers.get("x-admin-token") or request.cookies.get(ADMIN_COOKIE) or ""


def require_admin(request: Request) -> None:
    cfg = load_config()
    token = _admin_token(request)
    if not session_valid(token, cfg):
        raise HTTPException(401, "未登录或会话已过期")
    # 用 Cookie 鉴权的写操作要求自定义头，避免跨站表单直接改写配置。
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if not request.headers.get("x-admin-token") and request.headers.get("x-tts-admin") != "1":
            raise HTTPException(403, "缺少 X-TTS-Admin 请求头")


# ----------------------------------------------------------------------------
# 运行期统计
# ----------------------------------------------------------------------------

STATS_LOCK = threading.Lock()
STATS: Dict[str, Any] = {
    "started_at": time.time(),
    "speech_requests": 0,
    "speech_ok": 0,
    "speech_failed": 0,
    "chars": 0,
    "bytes": 0,
}
RECENT: "collections.deque[Dict[str, Any]]" = collections.deque(maxlen=100)
SLOT_LOCK = threading.Lock()
_SLOTS = threading.BoundedSemaphore(2)


def _record(entry: Dict[str, Any]) -> None:
    with STATS_LOCK:
        RECENT.appendleft(entry)
        STATS["speech_requests"] += 1
        if entry.get("status") and 200 <= int(entry["status"]) < 300:
            STATS["speech_ok"] += 1
            STATS["chars"] += int(entry.get("chars") or 0)
            STATS["bytes"] += int(entry.get("bytes") or 0)
        else:
            STATS["speech_failed"] += 1


# ----------------------------------------------------------------------------
# 上游（GPT-SoVITS api_v2.py）
# ----------------------------------------------------------------------------

_KANA_RE = re.compile(r"[\u3040-\u309f\u30a0-\u30ff]")
_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_RE = re.compile(r"[A-Za-z]")


def _detect_text_lang(text: str) -> str:
    """尽力判断文本语言：ja / zh / en / 空。"""
    value = str(text or "")
    if _KANA_RE.search(value):
        return "ja"
    if _HAN_RE.search(value):
        return "zh"
    if _LATIN_RE.search(value):
        return "en"
    return ""


def find_install() -> Optional[Path]:
    env = os.environ.get("GPTSOVITS_HOME")
    if env and (Path(env) / "api_v2.py").is_file():
        return Path(env)
    for base in (GATEWAY_DIR, GATEWAY_DIR.parent):
        if (base / "api_v2.py").is_file() and (base / "webui.py").is_file():
            return base
        if base.is_dir():
            for child in base.iterdir():
                if child.is_dir() and (child / "api_v2.py").is_file() and (child / "webui.py").is_file():
                    return child
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

_ALIVE_CACHE = {"at": 0.0, "value": False}


def upstream_base(cfg: Dict[str, Any]) -> str:
    base = str(cfg["upstream"].get("base") or "").strip()
    if base:
        return base.rstrip("/")
    return f"http://{cfg['upstream'].get('api_host', '127.0.0.1')}:{int(cfg['upstream'].get('api_port', 9880))}"


def upstream_alive(timeout: float = 3.0, cache_seconds: float = 5.0) -> bool:
    """仅供探活与界面显示：GPU 正在合成时 /docs 可能慢，超时给足并缓存。

    合成路径**不**依赖它——那里直接打上游，按真实异常分类（见 `_call_upstream`）。
    """
    now = time.time()
    if now - _ALIVE_CACHE["at"] < cache_seconds:
        return bool(_ALIVE_CACHE["value"])
    try:
        alive = requests.get(f"{upstream_base(load_config())}/docs", timeout=timeout).status_code == 200
    except Exception:
        alive = False
    _ALIVE_CACHE.update({"at": now, "value": alive})
    return alive


def _call_upstream(cfg: Dict[str, Any], body: Dict[str, Any]) -> requests.Response:
    """合成调用只在这里发出；把传输层异常翻译成可诊断的 HTTP 错误。

    2026-10-27 修：原先合成前先探 /docs，并发合成时该探针 2 秒超时会导致整段
    被误判为"上游未运行"（实测 5 段里丢掉 1 段）。探测只用于展示，不再拦截请求。
    """
    try:
        return requests.post(
            f"{upstream_base(cfg)}/tts",
            json=body,
            timeout=float(cfg["upstream"].get("timeout_seconds") or 600),
        )
    except requests.exceptions.Timeout as error:
        raise HTTPException(504, f"上游合成超时（{upstream_base(cfg)}）: {error}") from error
    except requests.exceptions.ConnectionError as error:
        raise HTTPException(503, f"上游 TTS 未运行（{upstream_base(cfg)}）: {error}") from error
    except Exception as error:  # noqa: BLE001
        raise HTTPException(502, f"调用上游失败: {error}") from error


def resolve_install_file(relative_path: str, *, label: str, extensions: Tuple[str, ...]) -> Path:
    """校验运行时资产位于 GPT-SoVITS 目录内，拒绝路径逃逸。"""
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
        raise HTTPException(400, f"{label} 扩展名必须是 {', '.join(extensions)}")
    if not candidate.is_file():
        raise HTTPException(400, f"{label} 不存在: {raw}")
    return candidate


def scan_weights() -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {"SoVITS": [], "GPT": []}
    if not INSTALL:
        return out
    for kind, dirs, ext in (("SoVITS", SOVITS_DIRS, ".pth"), ("GPT", GPT_DIRS, ".ckpt")):
        for directory in dirs:
            full = INSTALL / directory
            if not full.is_dir():
                continue
            for item in sorted(full.iterdir()):
                if item.is_file() and item.suffix.lower() == ext:
                    out[kind].append(
                        {
                            "name": item.stem,
                            "rel": f"{directory}/{item.name}",
                            "size": item.stat().st_size,
                            "mtime": int(item.stat().st_mtime),
                        }
                    )
    return out


# ----------------------------------------------------------------------------
# 应用
# ----------------------------------------------------------------------------

app = FastAPI(title="TTS Service", version=VERSION, docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "PUT", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["x-request-id", "x-tts-ms", "x-tts-voice", "x-tts-chars"],
)


def _public_base(cfg: Dict[str, Any], request: Optional[Request] = None) -> str:
    configured = str(cfg["server"].get("public_base_url") or "").strip().rstrip("/")
    if configured:
        return configured
    host = str(cfg["server"].get("host") or "")
    port = int(cfg["server"].get("port") or 18080)
    if host in ("", "0.0.0.0"):
        if request is not None:
            host = request.headers.get("host", "").split(":")[0] or "127.0.0.1"
        else:
            host = "127.0.0.1"
    return f"http://{host}:{port}"


def _mask(key: str) -> str:
    if len(key) <= 12:
        return "sk-…"
    return f"{key[:6]}…{key[-4:]}"


def _key_view(record: Dict[str, Any]) -> Dict[str, Any]:
    key = str(record.get("key") or "")
    return {
        "id": record.get("id"),
        "name": record.get("name"),
        "mask": _mask(key),
        "enabled": bool(record.get("enabled", True)),
        "created_at": record.get("created_at"),
        "last_used_at": record.get("last_used_at"),
        "uses": record.get("uses") or 0,
        "note": record.get("note") or "",
    }


def _voice_view(vid: str, voice: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": vid,
        "gpt": voice.get("gpt"),
        "sovits": voice.get("sovits"),
        "ref_audio": voice.get("ref_audio"),
        "ref_text": voice.get("ref_text"),
        "ref_lang": voice.get("ref_lang", "zh"),
        "text_lang": voice.get("text_lang", voice.get("ref_lang", "zh")),
        "speed": voice.get("speed", 1.0),
        "auto_text_lang": bool(voice.get("auto_text_lang", True)),
    }


# ---------------------------------------------------------------- 公开探活

@app.get("/healthz")
def healthz():
    cfg = load_config()
    return {
        "ok": True,
        "service": SERVICE_NAME,
        "version": VERSION,
        "upstream": upstream_base(cfg),
        "upstream_alive": upstream_alive(),
        "ts": int(time.time()),
    }


@app.get("/")
def index():
    return RedirectResponse(url="/admin", status_code=307)


# ---------------------------------------------------------------- OpenAI 兼容

@app.get("/v1/models")
def list_models(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    require_client(authorization, x_api_key)
    cfg = load_config()
    now = int(time.time())
    data: List[Dict[str, Any]] = []
    for vid in cfg.get("voices") or {}:
        data.append({"id": vid, "object": "model", "created": now, "owned_by": SERVICE_NAME})
    data.append({"id": "tts-1", "object": "model", "created": now, "owned_by": SERVICE_NAME})
    return {"object": "list", "data": data}


@app.get("/v1/audio/voices")
def list_voices(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    require_client(authorization, x_api_key)
    cfg = load_config()
    return {
        "default": cfg["defaults"].get("voice"),
        "voices": [
            {"id": vid, "ref_lang": v.get("ref_lang", "zh"), "speed": v.get("speed", 1.0)}
            for vid, v in (cfg.get("voices") or {}).items()
        ],
    }


def _speech_payload(
    payload: Dict[str, Any], cfg: Dict[str, Any]
) -> Tuple[str, Dict[str, Any], str]:
    text = str(payload.get("input") or payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "input is required")
    max_chars = int(cfg["limits"].get("max_input_chars") or 2000)
    if len(text) > max_chars:
        raise HTTPException(413, f"input 过长（{len(text)} 字符，上限 {max_chars}）")

    voices: Dict[str, Any] = cfg.get("voices") or {}
    vid = str(payload.get("voice") or payload.get("voice_id") or cfg["defaults"].get("voice") or "").strip()
    if vid and vid in voices:
        voice_cfg = dict(voices[vid])
    elif payload.get("ref_audio"):
        resolve_install_file(
            payload["ref_audio"],
            label="临时参考音频",
            extensions=(".wav", ".mp3", ".flac", ".m4a", ".ogg"),
        )
        voice_cfg = {
            "gpt": None,
            "sovits": None,
            "ref_audio": payload["ref_audio"],
            "ref_text": payload.get("ref_text", ""),
            "ref_lang": payload.get("prompt_lang", "zh"),
            "text_lang": str(payload.get("text_lang") or "").strip(),
            "speed": 1.0,
        }
    else:
        known = ", ".join(list(voices.keys())[:8]) or "无"
        raise HTTPException(400, f"没有可用音色（可用: {known}）。请先在配置界面注册音色。")

    if not voice_cfg.get("ref_text"):
        raise HTTPException(400, f"音色 '{vid}' 缺少 ref_text（参考音频原文）")

    fmt = str(payload.get("response_format") or cfg["defaults"].get("response_format") or "wav").lower()
    if fmt == "mp3":
        fmt = "aac"  # 上游只支持 wav/raw/ogg/aac
    if fmt not in ("wav", "raw", "ogg", "aac"):
        raise HTTPException(400, f"不支持的 response_format: {fmt}")

    text_lang = str(payload.get("text_lang") or "").strip()
    if not text_lang:
        if voice_cfg.get("auto_text_lang", True):
            text_lang = _detect_text_lang(text)
        text_lang = text_lang or voice_cfg.get("text_lang") or "zh"

    body = {
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": voice_cfg["ref_audio"],
        "prompt_text": voice_cfg["ref_text"],
        "prompt_lang": str(payload.get("prompt_lang") or voice_cfg.get("ref_lang") or "zh"),
        "top_k": payload.get("top_k", 15),
        "top_p": payload.get("top_p", 1),
        "temperature": payload.get("temperature", 1),
        "text_split_method": payload.get("text_split_method", "cut5"),
        "batch_size": 1,
        "speed_factor": float(payload.get("speed") or voice_cfg.get("speed") or cfg["defaults"].get("speed") or 1.0),
        "repetition_penalty": payload.get("repetition_penalty", 1.35),
        "seed": payload.get("seed", -1),
        "media_type": fmt,
        # 上游流式在网关这一跳被收齐后整段返回；不冒充流式。
        "streaming_mode": 0,
    }
    return text, body, fmt


MIME = {
    "wav": "audio/wav",
    "raw": "application/octet-stream",
    "ogg": "audio/ogg",
    "aac": "audio/aac",
}


@app.post("/v1/audio/speech")
def speech(
    payload: Dict[str, Any] = Body(...),
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    """OpenAI 兼容语音合成。同步端点，由 FastAPI 放进线程池，不阻塞事件循环。"""
    started = time.time()
    client = require_client(authorization, x_api_key)
    cfg = load_config()
    voice = str(payload.get("voice") or cfg["defaults"].get("voice") or "")
    text, upstream_body, fmt = _speech_payload(payload, cfg)

    acquired = _SLOTS.acquire(timeout=30)
    if not acquired:
        _record({
            "ts": int(time.time()), "client": client.get("name"), "voice": voice,
            "chars": len(text), "status": 429, "ms": int((time.time() - started) * 1000),
            "bytes": 0, "error": "concurrency limit",
        })
        raise HTTPException(429, "服务繁忙：并发已满，请稍后重试")
    try:
        response = _call_upstream(cfg, upstream_body)
    except HTTPException as error:
        _record({
            "ts": int(time.time()), "client": client.get("name"), "voice": voice,
            "chars": len(text), "status": error.status_code,
            "ms": int((time.time() - started) * 1000), "bytes": 0,
            "error": str(error.detail)[:160],
        })
        raise
    finally:
        _SLOTS.release()

    elapsed = int((time.time() - started) * 1000)
    if response.status_code != 200:
        _record({
            "ts": int(time.time()), "client": client.get("name"), "voice": voice,
            "chars": len(text), "status": response.status_code, "ms": elapsed,
            "bytes": 0, "error": response.text[:160],
        })
        raise HTTPException(502, f"上游返回 {response.status_code}: {response.text[:300]}")

    audio = response.content
    _record({
        "ts": int(time.time()), "client": client.get("name"), "voice": voice,
        "chars": len(text), "status": 200, "ms": elapsed, "bytes": len(audio), "error": None,
    })
    return Response(
        content=audio,
        media_type=MIME.get(fmt, "audio/wav"),
        headers={
            "x-request-id": secrets.token_hex(6),
            "x-tts-ms": str(elapsed),
            "x-tts-voice": voice,
            "x-tts-chars": str(len(text)),
            "cache-control": "no-store",
        },
    )


# ---------------------------------------------------------------- 配置界面

@app.get("/admin")
def admin_page():
    page = UI_DIR / "index.html"
    if not page.is_file():
        raise HTTPException(500, f"配置界面缺失: {page}")
    return FileResponse(page, media_type="text/html; charset=utf-8", headers={"cache-control": "no-store"})


@app.get("/admin/app.css")
def admin_css():
    return FileResponse(
        UI_DIR / "app.css", media_type="text/css; charset=utf-8", headers={"cache-control": "no-store"}
    )


@app.get("/admin/app.js")
def admin_js():
    return FileResponse(
        UI_DIR / "app.js",
        media_type="application/javascript; charset=utf-8",
        headers={"cache-control": "no-store"},
    )


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


# ---------------------------------------------------------------- 管理 API

@app.get("/admin/api/session")
def api_session(request: Request):
    cfg = load_config()
    token = _admin_token(request)
    return {
        "authenticated": session_valid(token, cfg),
        "needs_setup": not bool(cfg["auth"].get("admin_password_hash")),
        "service": SERVICE_NAME,
        "version": VERSION,
    }


@app.post("/admin/api/setup")
def api_setup(payload: Dict[str, Any] = Body(...), request: Request = None):
    cfg = load_config()
    if cfg["auth"].get("admin_password_hash"):
        raise HTTPException(400, "管理员口令已设置，不能重复初始化")
    client_host = (request.client.host if request.client else "") or ""
    if not cfg["auth"].get("allow_remote_setup") and client_host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "只允许在本机完成初始化；请在服务器上打开配置界面")
    password = str(payload.get("password") or "")
    if len(password) < 8:
        raise HTTPException(400, "管理员口令至少 8 位")
    cfg["auth"]["admin_password_hash"] = hash_password(password)
    save_config(cfg)
    token, ttl = issue_session(cfg)
    response = JSONResponse({"ok": True, "token": token, "expires_in": ttl})
    _set_cookie(response, token, ttl)
    return response


def _set_cookie(response: Response, token: str, ttl: int) -> None:
    response.set_cookie(
        ADMIN_COOKIE, token, max_age=ttl, httponly=True, samesite="lax", path="/"
    )


@app.post("/admin/api/login")
def api_login(payload: Dict[str, Any] = Body(...)):
    cfg = load_config()
    password = str(payload.get("password") or "")
    if not cfg["auth"].get("admin_password_hash"):
        raise HTTPException(400, "尚未设置管理员口令")
    if not verify_password(password, cfg["auth"]["admin_password_hash"]):
        time.sleep(0.4)  # 轻微延迟，降低暴力尝试速率
        raise HTTPException(401, "口令错误")
    token, ttl = issue_session(cfg)
    response = JSONResponse({"ok": True, "token": token, "expires_in": ttl})
    _set_cookie(response, token, ttl)
    return response


@app.post("/admin/api/logout")
def api_logout(request: Request):
    response = JSONResponse({"ok": True})
    response.delete_cookie(ADMIN_COOKIE, path="/")
    return response


@app.post("/admin/api/password")
def api_password(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    cfg = load_config()
    current = str(payload.get("current") or "")
    new = str(payload.get("password") or "")
    if not verify_password(current, cfg["auth"].get("admin_password_hash", "")):
        raise HTTPException(401, "当前口令错误")
    if len(new) < 8:
        raise HTTPException(400, "新口令至少 8 位")
    cfg["auth"]["admin_password_hash"] = hash_password(new)
    save_config(cfg)
    return {"ok": True}


@app.get("/admin/api/overview")
def api_overview(request: Request):
    require_admin(request)
    cfg = load_config()
    with STATS_LOCK:
        stats = dict(STATS)
        recent = list(RECENT)[:20]
    keys = cfg.get("keys") or []
    return {
        "service": SERVICE_NAME,
        "version": VERSION,
        "listen": {"host": cfg["server"].get("host"), "port": cfg["server"].get("port")},
        "public_base_url": _public_base(cfg, request),
        "upstream": {
            "base": upstream_base(cfg),
            "alive": upstream_alive(cache_seconds=0),
            "managed": PROC["popen"] is not None and PROC["popen"].poll() is None,
            "pid": PROC["popen"].pid if PROC["popen"] is not None and PROC["popen"].poll() is None else None,
            "started_at": PROC["started_at"],
            "install": str(INSTALL) if INSTALL else None,
        },
        "defaults": cfg["defaults"],
        "counts": {
            "voices": len(cfg.get("voices") or {}),
            "keys": len(keys),
            "keys_enabled": sum(1 for k in keys if k.get("enabled", True)),
            "speech_requests": stats["speech_requests"],
            "speech_ok": stats["speech_ok"],
            "speech_failed": stats["speech_failed"],
            "chars": stats["chars"],
            "bytes": stats["bytes"],
            "uptime_seconds": int(time.time() - stats["started_at"]),
        },
        "checks": {
            "has_admin_password": bool(cfg["auth"].get("admin_password_hash")),
            "has_client_key": any(k.get("enabled", True) for k in keys),
            "install_found": INSTALL is not None,
        },
        "recent": recent,
    }


@app.get("/admin/api/requests")
def api_requests(request: Request, limit: int = 50):
    require_admin(request)
    with STATS_LOCK:
        return {"requests": list(RECENT)[: max(1, min(int(limit), 100))]}


# ---- 音色

@app.get("/admin/api/voices")
def api_voices(request: Request):
    require_admin(request)
    cfg = load_config()
    return {
        "default": cfg["defaults"].get("voice"),
        "voices": [_voice_view(vid, v) for vid, v in (cfg.get("voices") or {}).items()],
        "weights": scan_weights(),
    }


@app.post("/admin/api/voices")
def api_upsert_voice(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    vid = str(payload.get("id") or "").strip()
    if not vid:
        raise HTTPException(400, "id 不能为空")
    if not re.fullmatch(r"[\w.\-]{1,48}", vid):
        raise HTTPException(400, "id 只能用字母、数字、下划线、点、短横线，长度 1-48")
    ref_audio = str(payload.get("ref_audio") or "").strip()
    ref_text = str(payload.get("ref_text") or "").strip()
    if not ref_audio or not ref_text:
        raise HTTPException(400, "ref_audio 与 ref_text 都是必填")
    resolve_install_file(ref_audio, label="参考音频", extensions=(".wav", ".mp3", ".flac", ".m4a", ".ogg"))
    gpt = payload.get("gpt") or None
    sovits = payload.get("sovits") or None
    if gpt:
        resolve_install_file(gpt, label="GPT 权重", extensions=(".ckpt",))
    if sovits:
        resolve_install_file(sovits, label="SoVITS 权重", extensions=(".pth",))

    cfg = load_config()
    cfg.setdefault("voices", {})[vid] = {
        "gpt": gpt,
        "sovits": sovits,
        "ref_audio": ref_audio,
        "ref_text": ref_text,
        "ref_lang": str(payload.get("ref_lang") or "zh"),
        "text_lang": str(payload.get("text_lang") or payload.get("ref_lang") or "zh"),
        "speed": float(payload.get("speed") or 1.0),
        "auto_text_lang": bool(payload.get("auto_text_lang", True)),
    }
    if not cfg["defaults"].get("voice"):
        cfg["defaults"]["voice"] = vid
    save_config(cfg)
    return {"ok": True, "voice": vid, "default": cfg["defaults"].get("voice")}


@app.post("/admin/api/voices/default")
def api_default_voice(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    vid = str(payload.get("id") or "").strip()
    cfg = load_config()
    if vid not in (cfg.get("voices") or {}):
        raise HTTPException(404, f"音色不存在: {vid}")
    cfg["defaults"]["voice"] = vid
    save_config(cfg)
    return {"ok": True, "default": vid}


@app.delete("/admin/api/voices/{vid}")
def api_delete_voice(request: Request, vid: str):
    require_admin(request)
    cfg = load_config()
    voices = cfg.get("voices") or {}
    if vid not in voices:
        raise HTTPException(404, "音色不存在")
    voices.pop(vid)
    if cfg["defaults"].get("voice") == vid:
        cfg["defaults"]["voice"] = next(iter(voices), None)
    save_config(cfg)
    return {"ok": True}


# ---- 客户端密钥

def _new_key_record(name: str, note: str) -> Dict[str, Any]:
    return {
        "id": secrets.token_hex(4),
        "name": (name or "").strip() or "unnamed",
        "key": "sk-" + secrets.token_hex(24),
        "enabled": True,
        "created_at": int(time.time()),
        "last_used_at": None,
        "uses": 0,
        "note": (note or "").strip(),
    }


@app.get("/admin/api/keys")
def api_keys(request: Request):
    require_admin(request)
    cfg = load_config()
    return {"keys": [_key_view(k) for k in (cfg.get("keys") or [])]}


@app.post("/admin/api/keys")
def api_create_key(request: Request, payload: Dict[str, Any] = Body(default={})):
    require_admin(request)
    cfg = load_config()
    record = _new_key_record(payload.get("name"), payload.get("note"))
    cfg.setdefault("keys", []).append(record)
    save_config(cfg)
    # 明文只在创建时返回一次
    return {"ok": True, "key": record["key"], "record": _key_view(record)}


@app.put("/admin/api/keys/{kid}")
def api_update_key(request: Request, kid: str, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    cfg = load_config()
    for record in cfg.get("keys") or []:
        if record.get("id") == kid:
            if "name" in payload:
                record["name"] = str(payload["name"]).strip() or record.get("name")
            if "note" in payload:
                record["note"] = str(payload["note"])
            if "enabled" in payload:
                record["enabled"] = bool(payload["enabled"])
            save_config(cfg)
            return {"ok": True, "record": _key_view(record)}
    raise HTTPException(404, "密钥不存在")


@app.post("/admin/api/keys/{kid}/reveal")
def api_reveal_key(request: Request, kid: str):
    require_admin(request)
    cfg = load_config()
    for record in cfg.get("keys") or []:
        if record.get("id") == kid:
            return {"key": record.get("key")}
    raise HTTPException(404, "密钥不存在")


@app.delete("/admin/api/keys/{kid}")
def api_delete_key(request: Request, kid: str):
    require_admin(request)
    cfg = load_config()
    keys = cfg.get("keys") or []
    kept = [k for k in keys if k.get("id") != kid]
    if len(kept) == len(keys):
        raise HTTPException(404, "密钥不存在")
    cfg["keys"] = kept
    save_config(cfg)
    return {"ok": True}


# ---- 设置

@app.get("/admin/api/settings")
def api_settings(request: Request):
    require_admin(request)
    cfg = load_config()
    return {
        "server": cfg["server"],
        "upstream": cfg["upstream"],
        "defaults": cfg["defaults"],
        "limits": cfg["limits"],
        "auth": {
            "session_hours": cfg["auth"].get("session_hours"),
            "allow_remote_setup": bool(cfg["auth"].get("allow_remote_setup")),
            "has_admin_password": bool(cfg["auth"].get("admin_password_hash")),
        },
        "install": str(INSTALL) if INSTALL else None,
        "config_path": str(CONFIG_PATH),
        "restart_fields": sorted(RESTART_FIELDS),
    }


@app.put("/admin/api/settings")
def api_update_settings(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    cfg = load_config()
    restart_required: List[str] = []

    def apply(section: str, key: str, value: Any) -> None:
        if value is None:
            return
        cfg.setdefault(section, {})[key] = value
        if f"{section}.{key}" in RESTART_FIELDS:
            restart_required.append(f"{section}.{key}")

    server = payload.get("server") or {}
    if "host" in server:
        host = str(server["host"]).strip()
        if host not in ("0.0.0.0", "127.0.0.1", "localhost"):
            raise HTTPException(400, "监听地址只支持 0.0.0.0 / 127.0.0.1 / localhost")
        apply("server", "host", host)
    if "port" in server:
        apply("server", "port", int(server["port"]))
    if "public_base_url" in server:
        apply("server", "public_base_url", str(server["public_base_url"]).strip())

    upstream = payload.get("upstream") or {}
    for key in ("base", "api_host", "config_path", "log_path"):
        if key in upstream:
            apply("upstream", key, str(upstream[key]).strip())
    if "api_port" in upstream:
        apply("upstream", "api_port", int(upstream["api_port"]))
    for key in ("timeout_seconds", "start_timeout_seconds"):
        if key in upstream:
            apply("upstream", key, int(upstream[key]))

    defaults = payload.get("defaults") or {}
    if "voice" in defaults:
        voice = str(defaults["voice"] or "").strip() or None
        if voice and voice not in (cfg.get("voices") or {}):
            raise HTTPException(400, f"默认音色不存在: {voice}")
        apply("defaults", "voice", voice)
    if "response_format" in defaults:
        apply("defaults", "response_format", str(defaults["response_format"]))
    if "speed" in defaults:
        apply("defaults", "speed", float(defaults["speed"]))

    limits = payload.get("limits") or {}
    if "max_input_chars" in limits:
        apply("limits", "max_input_chars", max(1, int(limits["max_input_chars"])))
    if "max_concurrent" in limits:
        apply("limits", "max_concurrent", max(1, int(limits["max_concurrent"])))

    auth = payload.get("auth") or {}
    if "session_hours" in auth:
        apply("auth", "session_hours", max(1, int(auth["session_hours"])))
    if "allow_remote_setup" in auth:
        cfg["auth"]["allow_remote_setup"] = bool(auth["allow_remote_setup"])

    save_config(cfg)
    return {"ok": True, "restart_required": sorted(set(restart_required))}


# ---- 健康自检

@app.post("/admin/api/selfcheck")
def api_selfcheck(request: Request, payload: Dict[str, Any] = Body(default={})):
    """给配置界面的「健康自检」用：逐项给出可判断的结论，而不是一个笼统的 200。"""
    require_admin(request)
    cfg = load_config()
    checks: List[Dict[str, Any]] = []

    def add(check_id: str, title: str, ok: bool, detail: str, action: str = "") -> None:
        checks.append({"id": check_id, "title": title, "ok": ok, "detail": detail, "action": action})

    started = time.time()
    add(
        "admin",
        "管理员口令",
        bool(cfg["auth"].get("admin_password_hash")),
        "已设置" if cfg["auth"].get("admin_password_hash") else "未设置，配置界面处于初始化状态",
        "" if cfg["auth"].get("admin_password_hash") else "#/security",
    )
    enabled_keys = [k for k in (cfg.get("keys") or []) if k.get("enabled", True)]
    add(
        "keys",
        "客户端密钥",
        bool(enabled_keys),
        f"{len(enabled_keys)} 把启用 / 共 {len(cfg.get('keys') or [])} 把",
        "" if enabled_keys else "#/keys",
    )
    voices = cfg.get("voices") or {}
    add(
        "voices",
        "音色表",
        bool(voices),
        f"{len(voices)} 个音色，默认 {cfg['defaults'].get('voice') or '未设置'}",
        "" if voices else "#/voices",
    )
    add(
        "install",
        "GPT-SoVITS 安装目录",
        INSTALL is not None,
        str(INSTALL) if INSTALL else "未找到，音色编辑与上游启动不可用",
        "" if INSTALL else "#/settings",
    )

    probe_started = time.time()
    alive = upstream_alive(cache_seconds=0)
    add(
        "upstream",
        "上游 TTS",
        alive,
        f"{upstream_base(cfg)} · {'在线' if alive else '离线'}（{int((time.time() - probe_started) * 1000)} ms）",
        "" if alive else "#/upstream",
    )

    if payload.get("synthesize"):
        voice = cfg["defaults"].get("voice")
        if not voices or not voice:
            add("synthesis", "合成自检", False, "没有可用音色，跳过合成", "#/voices")
        else:
            t0 = time.time()
            try:
                text, body, _fmt = _speech_payload(
                    {"input": "自检：图书馆的灯还亮着。", "voice": voice}, cfg
                )
                response = _call_upstream(cfg, body)
                if response.status_code != 200:
                    add("synthesis", "合成自检", False,
                        f"上游返回 {response.status_code}: {response.text[:120]}", "#/upstream")
                else:
                    add("synthesis", "合成自检", True,
                        f"{voice} · {len(response.content):,} B · {int((time.time() - t0) * 1000)} ms", "")
            except HTTPException as error:
                add("synthesis", "合成自检", False, str(error.detail)[:160], "#/upstream")
            except Exception as error:  # noqa: BLE001
                add("synthesis", "合成自检", False, str(error)[:160], "#/upstream")

    return {
        "ok": all(item["ok"] for item in checks),
        "elapsed_ms": int((time.time() - started) * 1000),
        "checks": checks,
    }


# ---- 试听

@app.post("/admin/api/test")
def api_test(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    cfg = load_config()
    started = time.time()
    text, upstream_body, fmt = _speech_payload(payload, cfg)
    response = _call_upstream(cfg, upstream_body)
    if response.status_code != 200:
        raise HTTPException(502, f"上游返回 {response.status_code}: {response.text[:300]}")
    elapsed = int((time.time() - started) * 1000)
    return Response(
        content=response.content,
        media_type=MIME.get(fmt, "audio/wav"),
        headers={"x-tts-ms": str(elapsed), "cache-control": "no-store"},
    )


# ---- 上游进程

PROC: Dict[str, Any] = {"popen": None, "log": None, "started_at": None}


def _upstream_log_path(cfg: Dict[str, Any]) -> Optional[Path]:
    configured = str(cfg["upstream"].get("log_path") or "").strip()
    if configured:
        return Path(configured)
    for candidate in (
        GATEWAY_DIR / "gateway_upstream.log",
        (INSTALL / "gateway_upstream.log") if INSTALL else None,
        (INSTALL.parent / "logs" / "gateway_upstream.log") if INSTALL else None,
    ):
        if candidate and candidate.is_file():
            return candidate
    return (GATEWAY_DIR / "gateway_upstream.log")


def _tail(path: Optional[Path], n: int = 80) -> List[str]:
    if path is None or not path.is_file():
        return []
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
    except Exception:
        return []


@app.get("/admin/api/upstream")
def api_upstream(request: Request, tail: int = 40):
    require_admin(request)
    cfg = load_config()
    return {
        "base": upstream_base(cfg),
        "alive": upstream_alive(cache_seconds=0),
        "managed": PROC["popen"] is not None and PROC["popen"].poll() is None,
        "pid": PROC["popen"].pid if PROC["popen"] is not None and PROC["popen"].poll() is None else None,
        "started_at": PROC["started_at"],
        "install": str(INSTALL) if INSTALL else None,
        "log_path": str(_upstream_log_path(cfg)),
        "log_tail": _tail(_upstream_log_path(cfg), max(1, min(int(tail), 400))),
    }


@app.post("/admin/api/upstream/start")
def api_upstream_start(request: Request, payload: Dict[str, Any] = Body(default={})):
    require_admin(request)
    cfg = load_config()
    if upstream_alive(cache_seconds=0):
        return {"ok": True, "already": True}
    if not INSTALL:
        raise HTTPException(400, "未找到 GPT-SoVITS 安装目录（设置 GPTSOVITS_HOME 或把它放在同目录）")
    python_candidates = [
        INSTALL / "runtime" / "python.exe",
        INSTALL / "runtime" / "python",
        INSTALL / ".venv" / "Scripts" / "python.exe",
        INSTALL / ".venv" / "bin" / "python",
    ]
    python = next((c for c in python_candidates if c.is_file()), None)
    if python is None:
        fallback = shutil.which("python3") or shutil.which("python")
        if fallback is None:
            raise HTTPException(400, "未找到 GPT-SoVITS 运行时 Python")
        python = Path(fallback)

    config_rel = str(payload.get("config") or cfg["upstream"].get("config_path") or "GPT_SoVITS/configs/tts_infer.yaml")
    resolve_install_file(config_rel, label="上游配置", extensions=(".yaml", ".yml"))
    log_path = _upstream_log_path(cfg)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = open(log_path, "a", encoding="utf-8", buffering=1)
    log_file.write(f"\n=== upstream start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
    # 上游永远只监听回环地址：外部只认本服务。
    host = str(cfg["upstream"].get("api_host") or "127.0.0.1")
    port = str(int(cfg["upstream"].get("api_port") or 9880))
    proc = subprocess.Popen(
        [str(python), "api_v2.py", "-a", host, "-p", port, "-c", config_rel],
        cwd=str(INSTALL),
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    PROC.update({"popen": proc, "log": log_file, "started_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    deadline = time.time() + float(cfg["upstream"].get("start_timeout_seconds") or 180)
    while time.time() < deadline:
        if upstream_alive(2, cache_seconds=0):
            return {"ok": True, "ready": True, "pid": proc.pid}
        if proc.poll() is not None:
            raise HTTPException(500, f"上游进程退出 code={proc.returncode}，见 {log_path}")
        time.sleep(2)
    return {"ok": True, "ready": False, "pid": proc.pid, "note": "仍在启动"}


@app.post("/admin/api/upstream/stop")
def api_upstream_stop(request: Request):
    require_admin(request)
    cfg = load_config()
    proc = PROC.get("popen")
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
    if upstream_alive(cache_seconds=0):
        try:
            requests.get(f"{upstream_base(cfg)}/control", params={"command": "exit"}, timeout=10)
        except Exception:
            pass
    log_file = PROC.get("log")
    if log_file:
        try:
            log_file.close()
        except Exception:
            pass
    PROC.update({"popen": None, "log": None, "started_at": None})
    time.sleep(1)
    return {"ok": True, "alive": upstream_alive(cache_seconds=0)}


@app.post("/admin/api/upstream/load")
def api_upstream_load(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    cfg = load_config()
    if not upstream_alive(cache_seconds=0):
        raise HTTPException(503, "上游未运行")
    results: Dict[str, Any] = {}
    for key in ("gpt", "sovits"):
        rel = payload.get(key)
        if not rel:
            continue
        extensions = (".ckpt",) if key == "gpt" else (".pth",)
        resolve_install_file(rel, label=f"{key} 权重", extensions=extensions)
        try:
            response = requests.get(
                f"{upstream_base(cfg)}/set_{key}_weights", params={"weights_path": rel}, timeout=180
            )
            results[key] = {
                "ok": response.status_code == 200,
                "status": response.status_code,
                "body": response.text[:200],
            }
        except Exception as error:  # noqa: BLE001
            results[key] = {"ok": False, "error": str(error)}
    if results and not any(v.get("ok") for v in results.values()):
        raise HTTPException(400, f"加载失败: {results}")
    return {"ok": True, "results": results}


@app.post("/admin/api/restart")
def api_restart(request: Request):
    require_admin(request)

    def _exit_soon() -> None:
        time.sleep(0.4)
        os._exit(EXIT_RESTART)

    threading.Thread(target=_exit_soon, daemon=True).start()
    return {"ok": True, "restarting": True}


# ----------------------------------------------------------------------------
# 启动
# ----------------------------------------------------------------------------

def _reset_slots() -> None:
    global _SLOTS
    cfg = load_config()
    _SLOTS = threading.BoundedSemaphore(max(1, int(cfg["limits"].get("max_concurrent") or 2)))


def main() -> None:
    cfg = bootstrap_config()
    _reset_slots()
    threading.Thread(target=_flush_loop, daemon=True).start()

    host = str(cfg["server"].get("host") or "0.0.0.0")
    port = int(cfg["server"].get("port") or 18080)

    print("=" * 68)
    print(f" TTS Service v{VERSION}")
    print("=" * 68)
    print(f" 配置文件   : {CONFIG_PATH}")
    print(f" 安装目录   : {INSTALL or '【未找到】'}")
    print(f" 监听       : http://{host}:{port}")
    print(f" 配置界面   : http://127.0.0.1:{port}/admin")
    print(f" OpenAI     : POST http://<服务器IP>:{port}/v1/audio/speech")
    print(f" 上游 TTS   : {upstream_base(cfg)}")
    print(f" 客户端密钥 : {len(cfg.get('keys') or [])} 把")
    print(f" 管理员口令 : {'已设置' if cfg['auth'].get('admin_password_hash') else '【未设置】'}")
    print("=" * 68)

    if host not in ("127.0.0.1", "localhost", "::1"):
        if not cfg["auth"].get("admin_password_hash"):
            raise SystemExit("拒绝在非回环地址上启动：请先设置管理员口令（TTS_ADMIN_PASSWORD）")
        if not any(k.get("enabled", True) for k in (cfg.get("keys") or [])):
            raise SystemExit("拒绝在非回环地址上启动：请先创建至少一把客户端密钥")

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
