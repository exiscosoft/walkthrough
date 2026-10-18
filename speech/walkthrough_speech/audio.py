"""Sentence-chunked synthesis with silence trimming.

Each sentence is generated separately (TTS models drift on long inputs), trimmed,
and joined with a fixed gap. The returned segment times are exact, so captions
for synthesized narration need no forced alignment.
"""

from __future__ import annotations

import re

import numpy as np
import soundfile as sf

OUT_SR = 48_000
GAP_MS = 180
TRIM_DB = -45.0
TRIM_MARGIN_MS = 40

_END = re.compile(r"[.!?][\"'”’)\]]*$")
_CLOSERS = re.compile(r"[\"'”’)\]]+$")
_ABBREVIATIONS = {"e.g.", "i.e.", "vs.", "mr.", "mrs.", "ms.", "dr.", "approx."}


def split_sentences(text: str) -> list[str]:
    """Same rule as splitSentences in src/util.ts: end only at a word ending in . ! or ?,
    so domains, prices and version numbers stay whole. Keep the two in step."""
    out: list[str] = []
    current: list[str] = []
    for word in text.split():
        current.append(word)
        if _END.search(word) and _CLOSERS.sub("", word.lower()) not in _ABBREVIATIONS:
            out.append(" ".join(current))
            current = []
    if current:
        out.append(" ".join(current))
    return out


def resample(wav: np.ndarray, sr: int, target: int = OUT_SR) -> np.ndarray:
    if sr == target:
        return wav.astype(np.float32)
    n = int(round(len(wav) * target / sr))
    x_old = np.linspace(0.0, 1.0, num=len(wav), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, wav).astype(np.float32)


def trim_silence(wav: np.ndarray, sr: int) -> np.ndarray:
    if wav.size == 0:
        return wav
    frame = max(1, sr // 100)  # 10 ms
    pad = len(wav) % frame
    frames = np.pad(wav, (0, (frame - pad) % frame)).reshape(-1, frame)
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)
    loud = np.nonzero(20 * np.log10(rms) > TRIM_DB)[0]
    if loud.size == 0:
        return wav[:0]
    margin = int(sr * TRIM_MARGIN_MS / 1000)
    start = max(0, loud[0] * frame - margin)
    end = min(len(wav), (loud[-1] + 1) * frame + margin)
    return wav[start:end]


def synthesize_sentences(engine, text: str, ref_audio, ref_text, out_path: str) -> list[dict]:
    sentences = split_sentences(text)
    if not sentences:
        raise ValueError("empty narration text")
    gap = np.zeros(int(OUT_SR * GAP_MS / 1000), dtype=np.float32)
    parts: list[np.ndarray] = []
    segments: list[dict] = []
    cursor = 0
    for i, sentence in enumerate(sentences):
        wav, sr = engine.synthesize(sentence, ref_audio, ref_text)
        wav = trim_silence(resample(np.asarray(wav, dtype=np.float32).reshape(-1), sr), OUT_SR)
        if wav.size == 0:
            raise RuntimeError(f"engine produced silence for sentence {i + 1}: {sentence!r}")
        if i > 0:
            parts.append(gap)
            cursor += len(gap)
        start = cursor
        parts.append(wav)
        cursor += len(wav)
        segments.append(
            {"text": sentence, "startMs": round(start * 1000 / OUT_SR), "endMs": round(cursor * 1000 / OUT_SR)}
        )
    joined = np.concatenate(parts)
    peak = float(np.max(np.abs(joined))) or 1.0
    if peak > 0.99:
        joined = joined * (0.99 / peak)
    sf.write(out_path, joined, OUT_SR, subtype="PCM_16")
    return segments
