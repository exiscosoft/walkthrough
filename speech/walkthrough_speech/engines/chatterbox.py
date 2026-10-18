"""Chatterbox (Resemble AI) on PyTorch MPS. Zero-shot cloning from a reference clip.

Model code and weights are MIT per the model card. Outputs carry Resemble's
Perth imperceptible watermark, which is recorded in clip metadata.
"""

from __future__ import annotations


class ChatterboxEngine:
    def __init__(self, settings: dict) -> None:
        import torch
        from chatterbox.tts import ChatterboxTTS

        device = settings.get("device") or ("mps" if torch.backends.mps.is_available() else "cpu")
        self.device = device
        self.exaggeration = float(settings.get("exaggeration", 0.5))
        self.cfg_weight = float(settings.get("cfg_weight", 0.5))
        self.temperature = float(settings.get("temperature", 0.8))
        self.model = ChatterboxTTS.from_pretrained(device=device)
        self._ref = None

    def info(self) -> dict:
        return {
            "engine": "chatterbox",
            "model": "ResembleAI/chatterbox",
            "device": self.device,
            "sampleRate": self.model.sr,
            "license": "MIT (verify model card before commercial use)",
            "watermark": "perth",
        }

    def synthesize(self, text: str, ref_audio: str | None, ref_text: str | None):
        import torch

        # Conditioning on the reference is the expensive part; do it once per reference.
        if ref_audio and ref_audio != self._ref:
            self.model.prepare_conditionals(ref_audio, exaggeration=self.exaggeration)
            self._ref = ref_audio
        with torch.inference_mode():
            wav = self.model.generate(
                text,
                exaggeration=self.exaggeration,
                cfg_weight=self.cfg_weight,
                temperature=self.temperature,
            )
        return wav.squeeze(0).cpu().numpy(), self.model.sr
