# Local speech benchmark

**Status: preliminary. The hardware gate is not yet decided.** No full `walkthrough bench speech` run has completed on this machine. This page records what was observed on 18 Oct 2026 while the Phase 1 engine was being built. Re-run the benchmark (instructions below) to replace it. Generated reports keep anything written below the findings marker.

**Machine:** Apple M3, 8 GB unified memory, macOS (Darwin 25.3).
**Conditions:** the machine was already under heavy memory pressure from other apps (iTerm2 at about 3.7 GB, Cursor, Chrome, MySQL, plus other node and ruby processes). Swap in use was 10–17 GB and free memory was 21–31%. **Every number below is a worst case under that load, not the engines' capability.**
**Reference voice:** synthetic (macOS `say`, 7.7 s). Good enough to measure speed and memory, but not cloning quality.

## Observations

| Engine | Test | Result | Peak footprint | Notes |
|---|---|---|---|---|
| Chatterbox (PyTorch MPS) | 1 sentence (smoke) | Did not finish: about 15 s per token, process fully paged out | ≈ 5.2 GB (load only) | `torch.mps` driver allocation 3.7 GB right after load. |
| Chatterbox (PyTorch MPS) | 30 s script (bench) | **Failed**: exceeded the 600 s synthesis budget | n/a | |
| F5-TTS (f5-tts-mlx) | 1 sentence, 2.3 s of audio (smoke) | **OK**, but 320 s wall time (RTF ≈ 140); load 2 s warm, 30 s cold | 3.3 GB (MLX peak 2.6 GB) | Whisper transcribed the output verbatim ("Click Accept Invitation to open the setup form."). |
| F5-TTS (f5-tts-mlx) | 30 s script (bench) | Interrupted | n/a | Claude Code's low-memory safeguard stopped the whole benchmark mid-run. |
| Chatterbox fp16 (mlx-audio) | 2 sentences (smoke) | Did not finish in 23 min: process paged out, 7% CPU | n/a | Load (including download) 65 s. |
| Qwen3-TTS 0.6B Base (mlx-audio) | n/a | Not reached | n/a | |
| whisper-small.en (mlx-whisper, alignment) | Transcribe 2–5 s clips | OK, about 1.5 s load | well under 1 GB | Used for caption alignment of imported recordings. Works under the same load. |

## What this means so far

- **Neither cloning model can run alongside the current app load on this 8 GB machine.** Both need 3–5 GB resident. Once the OS has to page their weights, generation slows by two orders of magnitude, which is unusable.
- **The engine already does what the PRD asks for memory:** stages run one after another, each speech stage runs in its own process that exits afterwards, and no LLM stays resident. The remaining question is only how much headroom the rest of the machine leaves.
- **Recorded-audio import works end to end**, with whisper word timings for captions, and is the safe default until a re-run shows a synthesis engine fits. It is the only path verified in this session.
- **Licences:**
  - F5-TTS weights are CC-BY-NC-4.0 (non-commercial). Don't use F5 as the commercial default without a licence decision.
  - Chatterbox is MIT, and its outputs carry Resemble's Perth watermark.
  - Qwen3-TTS: check the model card.

## Engine fixes needed to run on the current stack

- **chatterbox-tts 0.1.3:** `resemble-perth` imports `pkg_resources`, so it needs `setuptools<81`. This is now part of the `chatterbox` extra.
- **f5-tts-mlx 0.2.6:** it passes 0-d arrays in `mx.random.normal` shapes, which MLX 0.32 rejects. `engines/f5_mlx.py` applies a small shim.

## Re-running

Close memory-heavy apps first: terminal windows with huge scrollback, IDEs, browsers, local databases. Then run:

```sh
memory_pressure | tail -1        # aim for > 60% free, swap near 0
walkthrough bench speech --scripts 30s              # all four candidates
walkthrough bench speech --engines f5-mlx,mlx-audio:mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16 --scripts 30s,3min
walkthrough bench speech --voice <id>               # after enrolling your real voice, for quality judgements
```

Each run records free memory and swap at its start, so results taken under different load can be told apart. Results are saved after every run.

<!-- findings: hand-written below this line is kept on regeneration -->

## Findings

_Pending a clean run. Add listening notes, quality ratings (1–5) and the engine decision here._
