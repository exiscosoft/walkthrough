import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import { wordErrorRate } from "../render/captions.js";
import { SpeechProcess, type EngineName, type SynthResult, type AlignResult } from "../speech/sidecar.js";
import { nowIso } from "../util.js";

export interface EngineSpec {
  label: string;
  engine: Exclude<EngineName, "align">;
  settings: Record<string, unknown>;
}

export const DEFAULT_ENGINES: EngineSpec[] = [
  { label: "chatterbox (torch mps)", engine: "chatterbox", settings: {} },
  { label: "f5-tts (mlx)", engine: "f5-mlx", settings: {} },
  { label: "chatterbox (mlx-audio fp16)", engine: "mlx-audio", settings: { model: "mlx-community/Chatterbox-TTS-fp16" } },
  { label: "qwen3-tts 0.6B (mlx-audio)", engine: "mlx-audio", settings: { model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16" } },
];

/** `chatterbox`, `f5-mlx`, or `mlx-audio:<hf repo>`. */
export function parseEngineSpec(spec: string): EngineSpec {
  const [engine, model] = spec.split(":", 2) as [string, string | undefined];
  if (engine === "mlx-audio") {
    if (!model) throw new Error("mlx-audio needs a model: mlx-audio:<hf repo>");
    return { label: `${basename(model)} (mlx-audio)`, engine, settings: { model } };
  }
  if (engine !== "chatterbox" && engine !== "f5-mlx") throw new Error(`Unknown engine ${engine}`);
  return { label: engine, engine, settings: {} };
}

export interface BenchRun {
  engine: string;
  label: string;
  script: string;
  words: number;
  ok: boolean;
  error?: string;
  coldStartMs?: number;
  loadMs?: number;
  synthWallMs?: number;
  audioMs?: number;
  rtf?: number;
  peakFootprintBytes?: number;
  maxRssBytes?: number;
  frameworkPeakBytes?: number;
  swapDeltaBytes?: number;
  wer?: number;
  transcript?: string;
  license?: string;
  output?: string;
  /** System state when the run started: memory headroom matters on an 8 GB machine. */
  freeMemoryPctAtStart?: number;
  swapUsedAtStartBytes?: number;
}

async function freeMemoryPct(): Promise<number | undefined> {
  const r = await execa("memory_pressure", [], { reject: false });
  const m = /free percentage: (\d+)%/.exec(String(r.stdout));
  return m ? Number(m[1]) : undefined;
}

async function swapUsedBytes(): Promise<number | undefined> {
  const r = await execa("sysctl", ["-n", "vm.swapusage"], { reject: false });
  const m = /used = ([\d.]+)([MG])/.exec(String(r.stdout));
  return m ? Number(m[1]) * (m[2] === "G" ? 1024 ** 3 : 1024 ** 2) : undefined;
}

/**
 * Each engine × script runs in a fresh process under /usr/bin/time -l, so cold
 * start and peak memory are measured per run, then the process exits.
 */
export async function benchSpeech(opts: {
  engines: EngineSpec[];
  scripts: string[];
  reference: string;
  referenceText?: string;
  outDir: string;
  repoRoot: string;
  /** Per-run synthesis budget; runs exceeding it are killed and reported as failures. */
  timeoutMs?: (audioWords: number) => number;
  log: (msg: string) => void;
}) {
  const budget = opts.timeoutMs ?? ((wordsInScript: number) => Math.max(300_000, wordsInScript * 4000));
  await mkdir(join(opts.outDir, "audio"), { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const runs: BenchRun[] = [];
  const jsonOut = join(opts.outDir, `${stamp}.json`);
  const machine = await machineInfo();
  const reference = { file: opts.reference, synthetic: /synthetic/.test(opts.reference) };
  // Saved after every run so an interrupted benchmark (e.g. killed under memory pressure) keeps its results.
  const persist = () => writeFile(jsonOut, JSON.stringify({ at: nowIso(), machine, reference, runs }, null, 2) + "\n");
  for (const spec of opts.engines) {
    for (const scriptPath of opts.scripts) {
      const text = (await readFile(scriptPath, "utf8")).trim();
      const scriptName = basename(scriptPath, ".txt");
      const run: BenchRun = { engine: spec.engine, label: spec.label, script: scriptName, words: text.split(/\s+/).length, ok: false };
      const out = resolve(opts.outDir, "audio", `${stamp}-${spec.label.replace(/\W+/g, "_")}-${scriptName}.wav`);
      opts.log(`▶ ${spec.label} × ${scriptName}`);
      const swapBefore = await swapUsedBytes();
      run.swapUsedAtStartBytes = swapBefore;
      run.freeMemoryPctAtStart = await freeMemoryPct();
      const t0 = performance.now();
      let proc: SpeechProcess | undefined;
      try {
        proc = SpeechProcess.spawn(spec.engine, { timed: true });
        const load = await proc.request({ cmd: "load", engine: spec.engine, settings: spec.settings }, 900_000);
        run.coldStartMs = Math.round(performance.now() - t0);
        run.loadMs = load.loadMs;
        run.license = load.info?.license;
        const r = await proc.request<SynthResult>({ cmd: "synthesize", text, ref_audio: opts.reference, ref_text: opts.referenceText, out }, budget(run.words));
        run.synthWallMs = r.wallMs;
        run.audioMs = r.durationMs;
        run.rtf = r.wallMs / Math.max(1, r.durationMs);
        const mem = await proc.request({ cmd: "mem" });
        run.frameworkPeakBytes = mem.mlxPeakBytes ?? mem.mpsDriverBytes;
        run.peakFootprintBytes = mem.peakFootprintBytes;
        run.output = out;
        run.ok = true;
      } catch (err) {
        run.error = (err as Error).message.split("\n")[0];
        proc?.kill();
      }
      const closed = await proc?.close();
      if (closed) {
        run.maxRssBytes = closed.stats.maxRssBytes;
        run.peakFootprintBytes = Math.max(run.peakFootprintBytes ?? 0, closed.stats.peakFootprintBytes ?? 0) || undefined;
      }
      const swapAfter = await swapUsedBytes();
      if (swapBefore !== undefined && swapAfter !== undefined) run.swapDeltaBytes = swapAfter - swapBefore;
      opts.log(run.ok ? `  ok: ${(run.audioMs! / 1000).toFixed(1)}s audio in ${(run.synthWallMs! / 1000).toFixed(1)}s, cold start ${(run.coldStartMs! / 1000).toFixed(1)}s` : `  FAILED: ${run.error}`);
      runs.push(run);
      await persist();
    }
  }

  // Intelligibility: transcribe every output in one aligner process (run after TTS has exited).
  const done = runs.filter((r) => r.ok);
  if (done.length) {
    const asr = SpeechProcess.spawn("align");
    try {
      await asr.request({ cmd: "load", engine: "align" });
      for (const r of done) {
        const a = await asr.request<AlignResult>({ cmd: "align", wav: r.output });
        const text = (await readFile(opts.scripts.find((s) => basename(s, ".txt") === r.script)!, "utf8")).trim();
        r.transcript = a.text;
        r.wer = wordErrorRate(text, a.text);
      }
    } catch (err) {
      opts.log(`WER skipped: ${(err as Error).message}`);
    } finally {
      await asr.close();
    }
  }

  await persist();
  const result = { at: nowIso(), machine, reference, runs };
  const reportOut = join(opts.repoRoot, "docs", "speech-benchmark.md");
  await mkdir(join(opts.repoRoot, "docs"), { recursive: true });
  const prior = existsSync(reportOut) ? await readFile(reportOut, "utf8") : "";
  await writeFile(reportOut, report(result, jsonOut, opts.repoRoot, prior));
  return { results: jsonOut, report: reportOut, runs };
}

async function machineInfo() {
  const chip = await execa("sysctl", ["-n", "machdep.cpu.brand_string"], { reject: false });
  const os = await execa("sw_vers", ["-productVersion"], { reject: false });
  return { chip: String(chip.stdout).trim(), memoryBytes: totalmem(), cores: cpus().length, macos: String(os.stdout).trim() };
}

const gb = (b?: number) => (b === undefined ? "–" : (b / 1024 ** 3).toFixed(2));
const sec = (ms?: number) => (ms === undefined ? "–" : (ms / 1000).toFixed(1));

const NOTES_MARKER = "<!-- findings: hand-written below this line is kept on regeneration -->";

function report(result: { at: string; machine: Awaited<ReturnType<typeof machineInfo>>; reference: { synthetic: boolean }; runs: BenchRun[] }, jsonOut: string, root: string, prior: string): string {
  const rows = result.runs.map(
    (r) =>
      `| ${r.label} | ${r.script} | ${r.ok ? "ok" : `**failed**: ${r.error?.replace(/\|/g, "/")}`} | ${sec(r.audioMs)} | ${sec(r.coldStartMs)} | ${sec(r.synthWallMs)} | ${r.rtf?.toFixed(2) ?? "–"} | ${gb(r.peakFootprintBytes)} | ${gb(r.maxRssBytes)} | ${gb(r.frameworkPeakBytes)} | ${r.swapDeltaBytes === undefined ? "–" : (r.swapDeltaBytes / 1024 ** 2).toFixed(0)} | ${r.wer === undefined ? "–" : (r.wer * 100).toFixed(1) + "%"} | ${r.freeMemoryPctAtStart ?? "–"}% (swap ${gb(r.swapUsedAtStartBytes)} GB) |`,
  );
  const licenses = [...new Map(result.runs.filter((r) => r.license).map((r) => [r.label, r.license])).entries()].map(([l, lic]) => `- **${l}**: ${lic}`);
  const kept = prior.includes(NOTES_MARKER) ? prior.slice(prior.indexOf(NOTES_MARKER) + NOTES_MARKER.length) : "\n\n## Findings\n\n_Add listening notes, quality ratings (1–5) and the engine decision here._\n";
  return `# Local speech benchmark

Generated by \`walkthrough bench speech\` on ${result.at}. Raw results: \`${jsonOut.replace(root + "/", "")}\`.

**Machine:** ${result.machine.chip}, ${gb(result.machine.memoryBytes)} GB unified memory, ${result.machine.cores} cores, macOS ${result.machine.macos}.
**Reference voice:** ${result.reference.synthetic ? "synthetic (macOS `say`). Good enough to measure speed and memory, but not cloning quality. Re-run with `--voice <id>` after enrolling a real voice." : "enrolled voice profile."}

Each engine and script pair runs in a fresh process: load, synthesize sentence by sentence, report memory, exit. Then all outputs are transcribed with whisper-small.en to compute word error rate (WER) against the script.

| Engine | Script | Status | Audio s | Cold start s | Synth wall s | RTF | Peak footprint GB | Max RSS GB | Framework peak GB | Swap Δ MB | WER | Free mem at start |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

- **RTF** is synthesis wall time ÷ audio duration. Below 1 is faster than real time.
- **Peak footprint** is the kernel's lifetime maximum physical footprint for the process, which includes GPU allocations in unified memory. **Max RSS** misses most Metal buffers.
- **Framework peak** is \`mx.get_peak_memory()\` (MLX) or \`torch.mps.driver_allocated_memory()\` at the end of the run (PyTorch).
- **WER** is measured against the written script. It counts ASR mistakes as well as TTS mistakes, so use it to compare engines rather than as an absolute score.

## Licences

${licenses.join("\n") || "_none recorded_"}

${NOTES_MARKER}${kept}`;
}
