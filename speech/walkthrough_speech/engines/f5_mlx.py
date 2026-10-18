"""F5-TTS via the f5-tts-mlx port. Needs a 24 kHz mono reference and its transcript.

Code is MIT; the published F5-TTS weights are CC-BY-NC-4.0, so this engine must
not be the default for commercial output until licensing is resolved.
"""

from __future__ import annotations

import numpy as np


def _patch_mlx_normal() -> None:
    """f5-tts-mlx 0.2.6 passes 0-d arrays inside `shape`; current MLX only accepts ints."""
    import mlx.core as mx

    if getattr(mx.random.normal, "_walkthrough_compat", False):
        return
    original = mx.random.normal

    def normal(shape=(), *args, **kwargs):
        shape = tuple(int(s.item()) if hasattr(s, "item") else int(s) for s in shape)
        return original(shape, *args, **kwargs)

    normal._walkthrough_compat = True
    mx.random.normal = normal


class F5MlxEngine:
    SAMPLE_RATE = 24_000
    HOP_LENGTH = 256
    TARGET_RMS = 0.1

    def __init__(self, settings: dict) -> None:
        from f5_tts_mlx.cfm import F5TTS

        _patch_mlx_normal()
        self.model_name = settings.get("model", "lucasnewman/f5-tts-mlx")
        self.steps = int(settings.get("steps", 8))
        self.method = settings.get("method", "rk4")
        self.cfg_strength = float(settings.get("cfg_strength", 2.0))
        self.speed = float(settings.get("speed", 1.0))
        self.seed = settings.get("seed")
        self.quantization_bits = settings.get("quantization_bits")
        self.model = F5TTS.from_pretrained(self.model_name, quantization_bits=self.quantization_bits)
        self._ref_path = None
        self._ref = None

    def info(self) -> dict:
        return {
            "engine": "f5-mlx",
            "model": self.model_name,
            "steps": self.steps,
            "quantizationBits": self.quantization_bits,
            "sampleRate": self.SAMPLE_RATE,
            "license": "code MIT; weights CC-BY-NC-4.0 (non-commercial)",
        }

    def _load_ref(self, path: str):
        import mlx.core as mx
        import soundfile as sf

        from ..audio import resample

        wav, sr = sf.read(path, dtype="float32", always_2d=True)
        wav = resample(wav.mean(axis=1), sr, self.SAMPLE_RATE)
        audio = mx.array(wav)
        rms = mx.sqrt(mx.mean(mx.square(audio)))
        if rms < self.TARGET_RMS:
            audio = audio * self.TARGET_RMS / rms
        return audio

    def synthesize(self, text: str, ref_audio: str | None, ref_text: str | None):
        import mlx.core as mx
        from f5_tts_mlx.utils import convert_char_to_pinyin

        if not ref_audio or not ref_text:
            raise ValueError("f5-mlx needs ref_audio and ref_text (the transcript of the reference clip)")
        if ref_audio != self._ref_path:
            self._ref = self._load_ref(ref_audio)
            self._ref_path = ref_audio
        prompt = convert_char_to_pinyin([ref_text.strip() + " " + text])
        # The bundled duration predictor can return no more than the reference length for
        # real recordings, leaving nothing to generate; upstream F5-TTS scales by speaking rate.
        ref_frames = self._ref.shape[0] // self.HOP_LENGTH
        duration = int(ref_frames + ref_frames / len(ref_text.strip().encode()) * len(text.encode()) / self.speed)
        wave, _ = self.model.sample(
            mx.expand_dims(self._ref, axis=0),
            text=prompt,
            duration=duration,
            steps=self.steps,
            method=self.method,
            speed=self.speed,
            cfg_strength=self.cfg_strength,
            seed=self.seed,
        )
        wave = wave[self._ref.shape[0] :]
        mx.eval(wave)
        return np.array(wave), self.SAMPLE_RATE
