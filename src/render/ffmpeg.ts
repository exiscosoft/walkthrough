import { execa } from "execa";
import { WalkError } from "../util.js";

// Read per call so a different binary (or a failing stub in tests) can be swapped in.
const ffmpegBin = () => process.env.WALKTHROUGH_FFMPEG ?? "ffmpeg";
const ffprobeBin = () => process.env.WALKTHROUGH_FFPROBE ?? "ffprobe";

export async function ffmpeg(args: string[], opts: { signal?: AbortSignal } = {}): Promise<void> {
  const r = await execa(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { reject: false, cancelSignal: opts.signal });
  if (r.exitCode !== 0) {
    throw new WalkError("FFMPEG_FAILED", `ffmpeg failed (exit ${r.exitCode ?? r.signal}): ${String(r.stderr).slice(-600)}`);
  }
}

export async function ffmpegVersion(): Promise<string> {
  const r = await execa(ffmpegBin(), ["-version"], { reject: false });
  if (r.exitCode !== 0) throw new WalkError("FFMPEG_MISSING", "ffmpeg is not installed", "Install it with `brew install ffmpeg`.");
  return String(r.stdout).split("\n")[0]!;
}

export async function probe(file: string): Promise<any> {
  const r = await execa(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  return JSON.parse(String(r.stdout));
}

export async function durationMs(file: string): Promise<number> {
  const info = await probe(file);
  return Math.round(Number(info.format.duration) * 1000);
}

/** Normalise any recording to 48 kHz mono 16-bit WAV, trimming leading/trailing silence. */
export async function normalizeRecording(input: string, output: string): Promise<void> {
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
  await ffmpeg([
    "-i", input,
    "-af", `${trim},areverse,${trim},areverse,loudnorm=I=-18:TP=-1.5:LRA=11`,
    "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", output,
  ]);
}
