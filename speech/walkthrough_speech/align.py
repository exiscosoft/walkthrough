"""Word timestamps via mlx-whisper, for imported recordings and benchmark WER."""

from __future__ import annotations


class Aligner:
    def __init__(self, settings: dict) -> None:
        import mlx_whisper  # noqa: F401  (import cost is part of load time)

        self.model = settings.get("model", "mlx-community/whisper-small.en-mlx")

    def info(self) -> dict:
        return {"engine": "align", "model": self.model, "license": "MIT (OpenAI Whisper)"}

    def align(self, wav: str, language: str = "en") -> dict:
        import mlx_whisper

        result = mlx_whisper.transcribe(
            wav,
            path_or_hf_repo=self.model,
            word_timestamps=True,
            language=language,
            condition_on_previous_text=False,
            verbose=None,
        )
        words = [
            {"word": w["word"].strip(), "startMs": round(w["start"] * 1000), "endMs": round(w["end"] * 1000)}
            for seg in result.get("segments", [])
            for w in seg.get("words", [])
            if w.get("word", "").strip()
        ]
        return {"text": result.get("text", "").strip(), "words": words}
