import { artifactPath } from "../project/store.js";
import { ffmpeg } from "./ffmpeg.js";
import { ENCODER } from "./scene.js";
import type { Timeline } from "./timeline.js";

const s = (ms: number) => (ms / 1000).toFixed(4);

/** Place every narration clip at its absolute time on a silent bed of the full length. */
export async function buildAudioTrack(projectDir: string, timeline: Timeline, out: string): Promise<void> {
  const placed = timeline.scenes.flatMap((sc) => (sc.kind === "step" && sc.audio ? [{ file: artifactPath(projectDir, sc.audio), at: sc.startMs + sc.leadInMs }] : []));
  const total = s(timeline.totalMs);
  if (placed.length === 0) {
    await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", total, "-c:a", "pcm_s16le", out]);
    return;
  }
  const inputs = placed.flatMap((p) => ["-i", p.file]);
  const chains = placed.map((p, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=delays=${Math.round(p.at)}:all=1[a${i}]`);
  const mix = `${placed.map((_, i) => `[a${i}]`).join("")}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total}[out]`;
  await ffmpeg([...inputs, "-filter_complex", [...chains, mix].join(";"), "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out]);
}

/** Cross-fade the cached scene segments and mux the narration into the final MP4. */
export async function assemble(segments: string[], timeline: Timeline, audio: string, out: string): Promise<void> {
  const T = s(timeline.transitionMs);
  const inputs = [...segments.flatMap((f) => ["-i", f]), "-i", audio];
  const chain: string[] = [];
  let last = "0:v";
  for (let i = 1; i < segments.length; i++) {
    const label = `v${i}`;
    chain.push(`[${last}][${i}:v]xfade=transition=fade:duration=${T}:offset=${s(timeline.scenes[i]!.startMs)}[${label}]`);
    last = label;
  }
  const filter = chain.length ? chain.join(";") : `[0:v]null[v0]`;
  if (!chain.length) last = "v0";
  await ffmpeg([
    ...inputs,
    "-filter_complex", filter,
    "-map", `[${last}]`, "-map", `${segments.length}:a`,
    "-c:v", ENCODER.codec, "-preset", ENCODER.preset, "-crf", String(ENCODER.crf), "-pix_fmt", ENCODER.pixFmt, "-r", String(ENCODER.fps),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", s(timeline.totalMs),
    "-movflags", "+faststart",
    out,
  ]);
}
