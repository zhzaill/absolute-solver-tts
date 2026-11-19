"""句子级流式合成：切句、首句快参数、前导静音裁剪、逐段交付。

控制面的四条规则借自 Amadeus（红莉希）的 TTS 管线：

1. 句子先切成单元，**首句走另一条参数路径**（更短、步数更少、语速略快），
   并且第一段一合成完就交付，不等后面的句子。
2. 每段音频按「第一个有声帧（10 ms / -45 dBFS）+ 50 ms 预滚」裁掉模型生成的
   开头静音。GPT-SoVITS 每段开头有 0.8–1.0 s 静音，不裁就等于白送掉一整个首声预算。
3. 段与段之间按序交付；某段失败时补一段 40 ms 静音**占位**，并如实标注失败，
   免得下游播放泵停在一个永远不会来的序号上。
4. 计时只认「第一个有声样本」，不认 HTTP 首包，也不认 WAV 头。

这里只做「文本 → 一串分段 WAV」。合成本身仍交给上游 HTTP 接口，本模块不碰模型。
"""
from __future__ import annotations

import io
import math
import struct
import time
import wave
from array import array
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple

# ---------------------------------------------------------------- 切句

STRONG_ENDINGS = "。！？!?\n"
"""强句末：一定切。"""

WEAK_ENDINGS = "，,、；;"
"""弱停顿：首句必切；后续句要够长才切。"""

CLOSERS = "”’」』）)】]\"'…"
"""句末标点后面可能跟着的收尾符号，跟着本句走。"""

DOT = "."

FIRST_SENTENCE_EARLY_CUT_CHARS = 11
"""首句可见字数达到这里、又还没有句末标点时，就在安全边界切开先送合成。"""

WEAK_ENDING_MIN_CHARS = 5
"""非首句在弱停顿处切，本行至少要这么长。"""

UNIT_MAX_CHARS = 120
"""单个合成单元的字数上限；超了先找弱停顿，找不到就硬切。"""


@dataclass
class Unit:
    """一个待合成的句子单元。"""

    index: int  # 从 0 开始
    text: str
    first: bool

    @property
    def chars(self) -> int:
        return len(self.text)


def _safe_cut(text: str, at: int) -> int:
    """把切点挪到不拆数字/字母串的位置。"""
    size = len(text)
    if at <= 0 or at >= size:
        return max(0, min(at, size))
    left, right = text[at - 1], text[at]
    if left.isdigit() and right.isdigit():
        while at < size and text[at].isdigit():
            at += 1
        return at
    if (left.isascii() and left.isalnum()) and (right.isascii() and right.isalnum()):
        # 英文单词中间：向后推到词尾
        while at < size and text[at].isascii() and text[at].isalnum():
            at += 1
        return at
    return at


def _absorb_closers(text: str, at: int) -> int:
    """把紧跟句末的引号、括号收进本句。"""
    while at < len(text) and text[at] in CLOSERS:
        at += 1
    return at


def _is_dot_boundary(text: str, i: int) -> bool:
    """英文句点：数字、文件名、缩写里的点不算句末。"""
    prev = text[i - 1] if i else ""
    if prev and (prev.isalnum() or prev in "._-"):
        return False
    return True


def _cut_long_unit(text: str, limit: int) -> List[str]:
    """超长单元：优先在弱停顿断，其次硬切，都不拆数字。"""
    out: List[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind(ch) for ch in WEAK_ENDINGS)
        cut = cut + 1 if cut >= limit // 2 else limit
        cut = _safe_cut(rest, cut)
        if cut <= 0 or cut >= len(rest):
            break
        out.append(rest[:cut].strip())
        rest = rest[cut:]
    if rest.strip():
        out.append(rest.strip())
    return [item for item in out if item]


def split_units(
    text: str,
    *,
    first_early_cut: int = FIRST_SENTENCE_EARLY_CUT_CHARS,
    max_chars: int = UNIT_MAX_CHARS,
) -> List[Unit]:
    """把整段文本切成句子单元。

    首句没有长度下限（任何标点都切），并且在 ``first_early_cut`` 个字之后做一次
    早切，让第一段尽快进合成；后续句在强句末切，在弱停顿处要求至少
    ``WEAK_ENDING_MIN_CHARS`` 个字，避免把「嗯，」切成一段。
    """
    body = str(text or "").strip()
    if not body:
        return []

    pieces: List[str] = []
    buf: List[str] = []
    first_done = False

    def flush() -> None:
        piece = "".join(buf).strip()
        buf.clear()
        if piece:
            pieces.append(piece)

    i = 0
    size = len(body)
    while i < size:
        ch = body[i]
        buf.append(ch)
        i += 1
        visible = len("".join(buf).strip())

        boundary = False
        if ch == "\n":
            boundary = True
        elif ch in STRONG_ENDINGS:
            boundary = True
        elif ch == DOT:
            boundary = _is_dot_boundary(body, i - 1)
        elif ch in WEAK_ENDINGS:
            boundary = (not first_done) or visible >= WEAK_ENDING_MIN_CHARS

        if boundary:
            # 收尾符号与后续空白跟着本句
            while i < size and body[i] in CLOSERS:
                buf.append(body[i])
                i += 1
            flush()
            first_done = True
            continue

        if not first_done and first_early_cut and visible >= first_early_cut:
            at = _safe_cut(body, i)
            head = body[:at].strip()
            tail = body[at:]
            buf.clear()
            if head:
                pieces.append(head)
            first_done = True
            body = tail
            size = len(body)
            i = 0
            continue

    flush()

    expanded: List[str] = []
    for piece in pieces:
        cleaned = " ".join(piece.split())
        if not cleaned:
            continue
        expanded.extend(_cut_long_unit(cleaned, max_chars) if len(cleaned) > max_chars else [cleaned])

    return [Unit(index=n, text=item, first=(n == 0)) for n, item in enumerate(expanded)]


# ---------------------------------------------------------------- 前导静音
#
# 与 Amadeus tts/speech_onset.py 同一套定义：0.01 s 窗、-45 dBFS、0.05 s 预滚。
# 两处必须共用，否则「首声」与「能听见」差 0.8–1.0 s。

VOICED_FRAME_DBFS = -45.0
SPEECH_PREROLL_SECONDS = 0.05
_FRAME_SECONDS = 0.01

VOICED_FRAME_RMS = 10.0 ** (VOICED_FRAME_DBFS / 20.0)


def first_voiced_frame(samples: array, frame: int) -> Optional[int]:
    """第一个达到有声阈值的 10 ms 窗起点（样本序号），没有则 None。"""
    if frame <= 0 or not samples:
        return None
    threshold = int(VOICED_FRAME_RMS * 32767)
    threshold_sq = threshold * threshold
    start = 0
    total = len(samples)
    while start + frame <= total:
        energy = 0
        for value in samples[start:start + frame]:
            energy += int(value) * int(value)
        if energy >= threshold_sq * frame:
            return start
        start += frame
    return None


def speech_start(samples: array, rate: int) -> int:
    """应从这里开始播放该段音频（无声段则从 0 开始）。"""
    frame = max(1, int(round(rate * _FRAME_SECONDS)))
    onset = first_voiced_frame(samples, frame)
    if onset is None:
        return 0
    return max(0, onset - int(round(rate * SPEECH_PREROLL_SECONDS)))


def _fade(samples: array, rate: int, fade_in: float = 0.008, fade_out: float = 0.015) -> None:
    """段首 8 ms 淡入、段尾 15 ms 淡出，避免拼接处的爆音。"""
    count = len(samples)
    tail = min(count // 2, int(rate * fade_out))
    head = min(count // 2, int(rate * fade_in))
    for i in range(head):
        samples[i] = int(samples[i] * (i / head)) if head else samples[i]
    for i in range(tail):
        gain = i / tail if tail else 1.0
        samples[count - 1 - i] = int(samples[count - 1 - i] * gain)


@dataclass
class TrimResult:
    wav: bytes
    lead_ms: float
    audio_seconds: float
    rate: int


def split_wav(data: bytes) -> Tuple[int, int, int, bytes]:
    """拆出 (采样率, 声道, 位宽, PCM)，不信任头里声明的长度。

    上游流式模式的 WAV 头是按「长度未知」写出来的：`data` 块的长度字段是 0，
    但后面紧跟着真正的 PCM。`wave` 模块会因此读出 0 帧，所以这里自己走 chunk 表，
    再把 PCM 取到字节流末尾。
    """
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("不是 RIFF/WAVE 音频")
    offset = 12
    rate = 0
    channels = 0
    width = 0
    pcm = b""
    size = len(data)
    while offset + 8 <= size:
        chunk_id = data[offset:offset + 4]
        chunk_size = struct.unpack("<I", data[offset + 4:offset + 8])[0]
        body_start = offset + 8
        body_end = min(size, body_start + chunk_size) if chunk_size else size
        if chunk_id == b"fmt " and body_start + 16 <= size:
            _fmt, channels, rate = struct.unpack("<HHI", data[body_start:body_start + 8])
            width = struct.unpack("<H", data[body_start + 14:body_start + 16])[0] // 8
        elif chunk_id == b"data":
            # 流式头的 chunk_size 可能是 0：PCM 一直到结尾
            pcm = data[body_start:body_end] if chunk_size else data[body_start:]
            break
        offset = body_end if chunk_size else size
    if not rate or not channels or not width:
        raise ValueError("WAV 缺少可用的 fmt 块")
    return rate, channels, width, pcm


def trim_wav(data: bytes) -> TrimResult:
    """裁掉开头的生成静音并做段首尾淡化；返回新的 WAV 字节。"""
    rate, channels, width, pcm = split_wav(data)
    if width != 2:
        # 只处理 16 位 PCM：其它位宽原样返回，但仍如实报长度
        frame_bytes = max(1, channels * width)
        seconds = len(pcm) / frame_bytes / rate if rate else 0.0
        return TrimResult(wav=data, lead_ms=0.0, audio_seconds=seconds, rate=rate)

    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % (2 * channels))] if channels > 1 else pcm[: len(pcm) - (len(pcm) % 2)])
    mono = array("h", samples[::channels]) if channels > 1 else samples

    start = speech_start(mono, rate)
    lead_ms = start * 1000.0 / rate if rate else 0.0
    if start:
        if channels > 1:
            samples = samples[start * channels:]
        else:
            samples = samples[start:]
    _fade(samples, rate)

    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(width)
        writer.setframerate(rate)
        writer.writeframes(samples.tobytes())
    seconds = len(samples) / channels / rate if (channels and rate) else 0.0
    return TrimResult(wav=output.getvalue(), lead_ms=lead_ms, audio_seconds=seconds, rate=rate)


def silence_wav(seconds: float = 0.04, rate: int = 32000) -> bytes:
    """占位音频：某段合成失败时用它顶住序号，播放器不会卡死。"""
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\x00\x00" * int(rate * seconds))
    return output.getvalue()


# ---------------------------------------------------------------- 参数

@dataclass
class Tier:
    """一套合成参数；首句与后续句各一套。"""

    sample_steps: int = 16
    speed: float = 0.97
    streaming_mode: int = 2


FIRST_TIER = Tier(sample_steps=4, speed=1.067, streaming_mode=3)
"""首句：4 步 CFM、语速略快、流式档位 3（首块更快）。"""

LATER_TIER = Tier(sample_steps=16, speed=0.97, streaming_mode=2)
"""后续句：16 步、正常语速、流式档位 2。"""

_pcm_cache: Dict[str, Any] = {}


# ---------------------------------------------------------------- 逐段合成

@dataclass
class Segment:
    index: int
    text: str
    wav: bytes
    status: str  # ok | failed | silence
    chars: int = 0
    upstream_ms: int = 0
    first_byte_ms: int = 0
    audio_seconds: float = 0.0
    lead_ms: float = 0.0
    rate: int = 0
    error: str = ""

    def meta(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "text": self.text,
            "chars": self.chars or len(self.text),
            "status": self.status,
            "upstream_ms": self.upstream_ms,
            "first_byte_ms": self.first_byte_ms,
            "audio_seconds": round(self.audio_seconds, 3),
            "lead_ms": round(self.lead_ms, 1),
            "rate": self.rate,
            "bytes": len(self.wav),
            "error": self.error,
            "rtf": round(self.upstream_ms / 1000.0 / self.audio_seconds, 3) if self.audio_seconds else None,
        }


#: 调上游：接收请求体，返回 (wav 字节, 首个字节耗时毫秒)。
UpstreamCall = Callable[[Dict[str, Any], float], Tuple[bytes, int]]


def synthesize(
    text: str,
    body_for: Callable[[Unit, Tier], Dict[str, Any]],
    call: UpstreamCall,
    *,
    timeout: float = 600.0,
    first_tier: Tier = FIRST_TIER,
    later_tier: Tier = LATER_TIER,
    units: Optional[Iterable[Unit]] = None,
) -> Iterator[Segment]:
    """把文本逐句合成，按顺序产出 ``Segment``。

    ``body_for(unit, tier)`` 负责把单元和参数档位变成上游请求体；``call`` 负责真的发出去。
    首段失败时仍返回占位静音，调用方拿到的永远是一串连续的段。
    """
    planned = list(units) if units is not None else split_units(text)
    rate_hint = 32000
    for unit in planned:
        tier = first_tier if unit.first else later_tier
        started = time.time()
        try:
            payload, first_byte_ms = call(body_for(unit, tier), timeout)
            trimmed = trim_wav(payload)
            rate_hint = trimmed.rate or rate_hint
            yield Segment(
                index=unit.index,
                text=unit.text,
                wav=trimmed.wav,
                status="ok",
                chars=unit.chars,
                upstream_ms=int((time.time() - started) * 1000),
                first_byte_ms=first_byte_ms,
                audio_seconds=trimmed.audio_seconds,
                lead_ms=trimmed.lead_ms,
                rate=trimmed.rate,
            )
        except Exception as error:  # noqa: BLE001 - 一段失败不能带走整轮
            yield Segment(
                index=unit.index,
                text=unit.text,
                wav=silence_wav(0.04, rate_hint),
                status="failed",
                chars=unit.chars,
                upstream_ms=int((time.time() - started) * 1000),
                audio_seconds=0.04,
                rate=rate_hint,
                error=str(error)[:200],
            )


# ---------------------------------------------------------------- 分帧协议
#
# 每帧：4 字节小端长度 + 1 字节类型 + 载荷。
# 类型 0 = JSON（清单/段元数据），类型 1 = WAV 字节。

FRAME_META = 0
FRAME_AUDIO = 1


def pack_frame(kind: int, payload: bytes) -> bytes:
    return struct.pack("<IB", len(payload), kind) + payload


def pack_meta(kind: str, **fields: Any) -> bytes:
    body = {"kind": kind}
    body.update(fields)
    import json

    return pack_frame(FRAME_META, json.dumps(body, ensure_ascii=False).encode("utf-8"))


def iter_frames(
    text: str,
    body_for: Callable[[Unit, Tier], Dict[str, Any]],
    call: UpstreamCall,
    **kwargs: Any,
) -> Iterator[bytes]:
    """产出协议帧：plan → (meta, audio)×N → done。"""
    planned = kwargs.pop("units", None)
    if planned is None:
        planned = split_units(text)
    planned = list(planned)
    yield pack_meta("plan", units=[u.text for u in planned], count=len(planned))
    total_ms = 0
    for segment in synthesize(text, body_for, call, units=planned, **kwargs):
        total_ms += segment.upstream_ms
        yield pack_meta("segment", **segment.meta())
        yield pack_frame(FRAME_AUDIO, segment.wav)
    yield pack_meta("done", segments=len(planned), upstream_ms=total_ms)
