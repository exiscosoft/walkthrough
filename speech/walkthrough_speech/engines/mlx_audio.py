"""mlx-audio umbrella: any cloning-capable TTS model it can load by Hugging Face repo.

Licences differ per model, so `info()` reports what the caller configured and
the benchmark report carries it forward for review.
"""

from __future__ import annotations

import os
import tempfile

import numpy as np

KNOWN_LICENSES = {
    "mlx-community/Chatterbox-TTS-fp16": "MIT (Resemble AI; verify model card)",
    "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16": "Apache-2.0 (Qwen; verify model card)",
}


class MlxAudioEngine:
    def __init__(self, settings: dict) -> None:
        from mlx_audio.tts.utils import load

        self.repo = settings.get("model", "mlx-community/Chatterbox-TTS-fp16")
        self.extra = {k: v for k, v in settings.items() if k not in ("model", "license")}
        self.license = settings.get("license") or KNOWN_LICENSES.get(self.repo, "unknown: review model card")
        self.model = load(self.repo)
        self._tmp = tempfile.mkdtemp(prefix="wt-mlxaudio-")

    def info(self) -> dict:
        return {
            "engine": "mlx-audio",
            "model": self.repo,
            "sampleRate": getattr(self.model, "sample_rate", None),
            "license": self.license,
        }

    def synthesize(self, text: str, ref_audio: str | None, ref_text: str | None):
        import soundfile as sf
        from mlx_audio.tts.generate import generate_audio

        prefix = f"s{len(os.listdir(self._tmp))}"
        generate_audio(
            text=text,
            model=self.model,
            ref_audio=ref_audio,
            ref_text=ref_text,
            output_path=self._tmp,
            file_prefix=prefix,
            audio_format="wav",
            join_audio=True,
            verbose=False,
            **self.extra,
        )
        produced = sorted(f for f in os.listdir(self._tmp) if f.startswith(prefix) and f.endswith(".wav"))
        if not produced:
            raise RuntimeError(f"mlx-audio wrote no audio for {self.repo}")
        wav, sr = sf.read(os.path.join(self._tmp, produced[-1]), dtype="float32", always_2d=True)
        for f in produced:
            os.remove(os.path.join(self._tmp, f))
        return np.asarray(wav.mean(axis=1)), sr
