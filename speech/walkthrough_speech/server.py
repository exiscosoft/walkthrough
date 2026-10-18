"""JSON-lines speech sidecar.

One request per stdin line, one response per stdout line. Library chatter is
redirected to stderr so it can't corrupt the protocol. The process holds at most
one model; `unload` or exiting releases it.

Requests:
  {"cmd":"load","engine":"chatterbox"|"f5-mlx"|"mlx-audio"|"align","settings":{...}}
  {"cmd":"synthesize","text":"...","ref_audio":"/path.wav","ref_text":"...","out":"/path.wav"}
  {"cmd":"align","wav":"/path.wav","language":"en"}
  {"cmd":"mem"} | {"cmd":"unload"} | {"cmd":"exit"}
"""

from __future__ import annotations

import gc
import json
import os
import sys
import time
import traceback

# Keep a private handle on the real stdout, then point fd 1 at stderr.
_proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

from . import audio, memory  # noqa: E402


def _engine_class(name: str):
    if name == "chatterbox":
        from .engines.chatterbox import ChatterboxEngine

        return ChatterboxEngine
    if name == "f5-mlx":
        from .engines.f5_mlx import F5MlxEngine

        return F5MlxEngine
    if name == "mlx-audio":
        from .engines.mlx_audio import MlxAudioEngine

        return MlxAudioEngine
    if name == "align":
        from .align import Aligner

        return Aligner
    raise ValueError(f"unknown engine: {name}")


class Server:
    def __init__(self) -> None:
        self.engine = None
        self.engine_name: str | None = None

    def handle(self, req: dict) -> dict:
        cmd = req.get("cmd")
        if cmd == "load":
            self.unload()
            started = time.perf_counter()
            cls = _engine_class(req["engine"])
            self.engine = cls(req.get("settings") or {})
            self.engine_name = req["engine"]
            return {
                "ok": True,
                "loadMs": round((time.perf_counter() - started) * 1000),
                "info": self.engine.info(),
            }
        if cmd == "synthesize":
            self._require("synthesize")
            started = time.perf_counter()
            segments = audio.synthesize_sentences(
                self.engine, req["text"], req.get("ref_audio"), req.get("ref_text"), req["out"]
            )
            wall = (time.perf_counter() - started) * 1000
            duration = segments[-1]["endMs"] if segments else 0
            return {
                "ok": True,
                "durationMs": duration,
                "wallMs": round(wall),
                "segments": segments,
                "sampleRate": audio.OUT_SR,
            }
        if cmd == "align":
            self._require("align")
            started = time.perf_counter()
            result = self.engine.align(req["wav"], req.get("language", "en"))
            result["wallMs"] = round((time.perf_counter() - started) * 1000)
            return {"ok": True, **result}
        if cmd == "mem":
            return {"ok": True, **memory.snapshot(self.engine_name)}
        if cmd == "unload":
            self.unload()
            return {"ok": True}
        raise ValueError(f"unknown cmd: {cmd}")

    def _require(self, capability: str) -> None:
        if self.engine is None or not hasattr(self.engine, capability):
            raise RuntimeError(f"no loaded engine supports {capability}; send load first")

    def unload(self) -> None:
        if self.engine is None:
            return
        name = self.engine_name
        self.engine = None
        self.engine_name = None
        gc.collect()
        memory.release(name)


def main() -> None:
    server = Server()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            if req.get("cmd") == "exit":
                break
            resp = server.handle(req)
        except Exception as exc:  # report every failure to the caller, never crash silently
            traceback.print_exc()
            resp = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        resp["id"] = req_id
        _proto.write(json.dumps(resp) + "\n")
    server.unload()


if __name__ == "__main__":
    main()
