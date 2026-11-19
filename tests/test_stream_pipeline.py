from __future__ import annotations

import io
import struct
import unittest
import wave

from gateway import stream_pipeline as sp


def wav_bytes(samples, rate=32000) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"".join(struct.pack("<h", int(s)) for s in samples))
    return output.getvalue()


def read_samples(data: bytes):
    with wave.open(io.BytesIO(data), "rb") as reader:
        frames = reader.readframes(reader.getnframes())
        rate = reader.getframerate()
    return list(struct.unpack("<%dh" % (len(frames) // 2), frames)), rate


class SplitUnitsTest(unittest.TestCase):
    def test_first_sentence_goes_early(self):
        units = sp.split_units("这是第一句话没有任何标点但是很长所以应该被早切开然后再继续")
        self.assertTrue(units[0].first)
        self.assertLessEqual(units[0].chars, 16)
        self.assertEqual([u.index for u in units], list(range(len(units))))

    def test_strong_ending_before_early_cut(self):
        units = sp.split_units("你好。第二句在这里。")
        self.assertEqual([u.text for u in units], ["你好。", "第二句在这里。"])
        self.assertTrue(units[0].first)
        self.assertFalse(units[1].first)

    def test_short_first_clause_merges_into_first_unit(self):
        # 「嗯，」太短，盖不住第二段的合成时间，所以并进首段
        units = sp.split_units("嗯，这件事让我想想再说。")
        self.assertEqual(units[0].text, "嗯，这件事让我想想再说。")

    def test_first_clause_cuts_once_long_enough(self):
        units = sp.split_units("先说一句，然后我们再继续往下说别的。")
        self.assertEqual(units[0].text, "先说一句，")
        self.assertGreaterEqual(units[1].chars, 1)

    def test_weak_ending_needs_length_after_first(self):
        units = sp.split_units("这是第一句。嗯，后面还有内容要继续说完。")
        self.assertEqual(units[1].text, "嗯，后面还有内容要继续说完。")

    def test_decimal_point_is_not_a_break(self):
        # 首句早切可以切在数字后面，但绝不能把数字本身切开
        units = sp.split_units("圆周率是3.14159这个数字大家都知道。")
        self.assertIn("3.14159", units[0].text)
        self.assertTrue(all("3." not in u.text or "3.14159" in u.text for u in units))

    def test_file_name_is_not_a_break(self):
        units = sp.split_units("请打开file.txt这个文件。")
        joined = "|".join(u.text for u in units)
        self.assertIn("file.txt", joined)
        self.assertTrue(all(not u.text.endswith("file.tx") for u in units))

    def test_closing_quote_stays_with_sentence(self):
        units = sp.split_units("他说「好的。」然后就走了。")
        self.assertTrue(units[0].text.endswith("」"))
        self.assertIn("好的。", units[0].text)

    def test_empty_text(self):
        self.assertEqual(sp.split_units("   "), [])

    def test_long_unit_is_split(self):
        text = "这是一段很长的句子，" * 12
        units = sp.split_units(text, max_chars=40)
        self.assertTrue(all(u.chars <= 40 for u in units))
        self.assertGreater(len(units), 1)


class TrimWavTest(unittest.TestCase):
    def test_leading_silence_is_trimmed_with_preroll(self):
        rate = 32000
        silence = [0] * int(rate * 0.8)
        tone = [8000, -8000] * int(rate * 0.1)
        result = sp.trim_wav(wav_bytes(silence + tone, rate))
        samples, out_rate = read_samples(result.wav)
        self.assertEqual(out_rate, rate)
        # 0.8 s 静音 → 保留 50 ms 预滚，剩约 0.05 s 静音
        self.assertAlmostEqual(result.lead_ms, 750.0, delta=15.0)
        self.assertLess(len(samples), len(silence + tone))
        self.assertGreater(len(samples), len(tone))

    def test_voiced_from_start_keeps_everything(self):
        rate = 32000
        tone = [8000, -8000] * int(rate * 0.1)
        result = sp.trim_wav(wav_bytes(tone, rate))
        self.assertEqual(result.lead_ms, 0.0)

    def test_all_silence_is_left_whole(self):
        rate = 32000
        result = sp.trim_wav(wav_bytes([0] * int(rate * 0.2), rate))
        self.assertEqual(result.lead_ms, 0.0)
        self.assertAlmostEqual(result.audio_seconds, 0.2, places=2)

    def test_fade_does_not_change_length(self):
        rate = 32000
        tone = [12000] * int(rate * 0.1)
        result = sp.trim_wav(wav_bytes(tone, rate))
        samples, _ = read_samples(result.wav)
        self.assertEqual(len(samples), len(tone))


class SynthesizeTest(unittest.TestCase):
    def setUp(self):
        self.rate = 32000
        self.quiet = wav_bytes([0] * int(self.rate * 0.7) + [9000, -9000] * int(self.rate * 0.05), self.rate)

    def test_segments_come_in_order_and_first_uses_first_tier(self):
        seen = []

        def body_for(unit, tier):
            seen.append((unit.index, tier.sample_steps, tier.streaming_mode))
            return {"text": unit.text}

        def call(body, timeout):
            return self.quiet, 120

        segments = list(sp.synthesize("你好。第二句话在这里。", body_for, call))
        self.assertEqual([s.index for s in segments], [0, 1])
        self.assertEqual([s.status for s in segments], ["ok", "ok"])
        self.assertEqual(seen[0][1], sp.FIRST_TIER.sample_steps)
        self.assertEqual(seen[1][1], sp.LATER_TIER.sample_steps)
        self.assertGreater(segments[0].lead_ms, 600)

    def test_failed_segment_yields_placeholder_and_keeps_going(self):
        def call(body, timeout):
            if "第二" in body["text"]:
                raise RuntimeError("upstream down")
            return self.quiet, 90

        segments = list(sp.synthesize("第一句。第二句话失败。第三句正常。", lambda unit, tier: {"text": unit.text}, call))
        self.assertEqual([s.status for s in segments], ["ok", "failed", "ok"])
        self.assertGreater(segments[1].audio_seconds, 0)

    def test_frames_are_length_prefixed(self):
        def call(body, timeout):
            return self.quiet, 50

        frames = b"".join(sp.iter_frames("只有一句话。", lambda unit, tier: {"text": unit.text}, call))
        offset = 0
        kinds = []
        while offset < len(frames):
            size, kind = struct.unpack("<IB", frames[offset:offset + 5])
            payload = frames[offset + 5:offset + 5 + size]
            self.assertEqual(len(payload), size)
            kinds.append(kind)
            offset += 5 + size
        self.assertEqual(offset, len(frames))
        self.assertEqual(kinds[0], sp.FRAME_META)
        self.assertIn(sp.FRAME_AUDIO, kinds)
        self.assertEqual(kinds[-1], sp.FRAME_META)


class StreamingWavTest(unittest.TestCase):
    """上游流式模式的 WAV 头把 data 长度写成 0，PCM 却跟在后面。"""

    @staticmethod
    def header_only(rate: int, payload_len_hint: int = 0) -> bytes:
        return (
            b"RIFF" + (36 + payload_len_hint).to_bytes(4, "little") + b"WAVEfmt "
            + (16).to_bytes(4, "little") + (1).to_bytes(2, "little")
            + (1).to_bytes(2, "little") + rate.to_bytes(4, "little")
            + (rate * 2).to_bytes(4, "little") + (2).to_bytes(2, "little")
            + (16).to_bytes(2, "little") + b"data" + payload_len_hint.to_bytes(4, "little")
        )

    def test_zero_length_data_chunk_is_read_to_end(self):
        rate = 32000
        silence = b"\x00\x00" * int(rate * 0.5)
        tone = struct.pack("<h", 9000) * int(rate * 0.05)
        data = self.header_only(rate) + silence + tone
        parsed_rate, channels, width, pcm = sp.split_wav(data)
        self.assertEqual((parsed_rate, channels, width), (rate, 1, 2))
        self.assertEqual(pcm, silence + tone)
        result = sp.trim_wav(data)
        self.assertGreater(result.lead_ms, 400)
        self.assertLess(result.audio_seconds, 0.2)

    def test_regular_wav_still_works(self):
        result = sp.trim_wav(wav_bytes([0] * 1000 + [8000] * 400))
        self.assertGreater(result.audio_seconds, 0)


if __name__ == "__main__":
    unittest.main()
