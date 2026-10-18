import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { deriveStatus, renderInputsHash } from "../project/invalidate.js";
import type { Manifest } from "../project/schema.js";
import { loadManifest, loadRevision, paths, saveManifest } from "../project/store.js";
import { profileFor } from "../speech/voice.js";
import { nowIso, WalkError, writeFileAtomic } from "../util.js";
import { blocksPreview, validateOutput, validateProject, type Issue } from "../validate/index.js";
import { assemble, buildAudioTrack } from "./assemble.js";
import { cuesFor, toSrt, toVtt, type Cue } from "./captions.js";
import { ffmpegVersion } from "./ffmpeg.js";
import { ENCODER, renderScene } from "./scene.js";
import { buildTimeline } from "./timeline.js";

export interface RenderOptions {
  revision?: number;
  preview?: boolean;
  log?: (msg: string) => void;
}

export async function render(dir: string, opts: RenderOptions = {}) {
  const log = opts.log ?? (() => {});
  const preview = Boolean(opts.preview);
  const source = opts.revision !== undefined ? await loadRevision(dir, opts.revision) : await loadManifest(dir);
  const issues = validateProject(dir, source, await profileFor(source));
  const blocking = issues.filter((i) => (preview ? blocksPreview(i) : i.severity === "error"));
  if (blocking.length) {
    throw new WalkError(
      "RENDER_BLOCKED",
      `${preview ? "Preview" : "Final render"} blocked by ${blocking.length} issue(s):\n` + blocking.map((i) => `  - [${i.code}]${i.step ? ` ${i.step}:` : ""} ${i.message}`).join("\n"),
      preview ? "Fix the listed issues." : "Resolve these, or render with --preview for a watermarked draft.",
      true,
    );
  }

  const p = paths(dir);
  const id = `${source.revision}-${nowIso().replace(/[:.]/g, "-")}${preview ? "-preview" : ""}`;
  const outDir = join(p.renders, id);
  await mkdir(outDir, { recursive: true });
  let m = await loadManifest(dir);
  m.renders.push({ id, revision: source.revision, preview, status: "rendering", dir: relative(p.root, outDir), inputsHash: renderInputsHash(source), startedAt: nowIso() });
  m.status = "rendering";
  m = await saveManifest(dir, m, `render ${id} started`);

  const work = await mkdtemp(join(p.cache, "render-"));
  try {
    const timeline = buildTimeline(source);
    const scale = source.project.viewport.deviceScaleFactor;
    const segments: string[] = [];
    const sceneLog: { id: string; hash: string; startMs: number; durationMs: number; cached: boolean }[] = [];
    for (const scene of timeline.scenes) {
      const r = await renderScene(dir, scene, source.project.brand, scale, preview, join(p.cache, "segments"), timeline.transitionMs);
      log(`scene ${scene.id.padEnd(14)} ${r.cached ? "cached " : "rendered"} ${(scene.durationMs / 1000).toFixed(2)}s`);
      segments.push(r.file);
      sceneLog.push({ id: scene.id, hash: r.hash, startMs: scene.startMs, durationMs: scene.durationMs, cached: r.cached });
    }
    const audio = join(work, "narration.wav");
    await buildAudioTrack(dir, timeline, audio);
    const video = join(outDir, "walkthrough.mp4");
    log("assembling");
    await assemble(segments, timeline, audio, video);

    const cues: Cue[] = timeline.scenes.flatMap((sc) => (sc.kind === "step" ? sc.segments.flatMap((seg) => cuesFor(seg, sc.startMs + sc.leadInMs)) : []));
    await writeFile(join(outDir, "captions.srt"), toSrt(cues));
    await writeFile(join(outDir, "captions.vtt"), toVtt(cues));
    await writeFile(join(outDir, "transcript.md"), transcript(source));

    const outputIssues = await validateOutput(video, timeline, cues);
    // In a preview, issues that only block final export are reported as warnings.
    const warnings: Issue[] = [
      ...issues.filter((i) => i.severity === "warning" || preview).map((i) => ({ ...i, severity: "warning" as const })),
      ...outputIssues,
    ];
    for (const sc of timeline.scenes) {
      if (sc.kind === "step" && sc.estimated) warnings.push({ code: "AUDIO_ESTIMATED", severity: "warning", step: sc.id, message: "No narration audio; scene length is estimated." });
    }
    const job = {
      id,
      revision: source.revision,
      preview,
      inputsHash: renderInputsHash(source),
      encoder: { ...ENCODER, audio: "aac 192k 48kHz", ffmpeg: await ffmpegVersion() },
      totalMs: timeline.totalMs,
      transitionMs: timeline.transitionMs,
      scenes: sceneLog,
      captions: cues.length,
      outputs: { video: "walkthrough.mp4", srt: "captions.srt", vtt: "captions.vtt", transcript: "transcript.md" },
      warnings,
      finishedAt: nowIso(),
    };
    await writeFileAtomic(join(outDir, "render-job.json"), JSON.stringify(job, null, 2) + "\n");
    const failed = outputIssues.filter((i) => i.severity === "error");
    if (failed.length) throw new WalkError("OUTPUT_INVALID", failed.map((i) => i.message).join("; "));

    m = await loadManifest(dir);
    m.renders = m.renders.map((r) => (r.id === id ? { ...r, status: "complete" as const, finishedAt: nowIso() } : r));
    if (!preview) await pointLatest(dir, outDir, id);
    m.status = deriveStatus(m, await profileFor(m));
    m.checkpoint = { stage: "render", at: nowIso() };
    await saveManifest(dir, m, `render ${id} complete`);
    return { id, dir: outDir, video, preview, totalMs: Math.round(timeline.totalMs), cachedScenes: sceneLog.filter((s) => s.cached).length, scenes: sceneLog.length, warnings };
  } catch (err) {
    // Earlier exports stay untouched: only this render's record is marked failed.
    m = await loadManifest(dir);
    m.renders = m.renders.map((r) => (r.id === id ? { ...r, status: "failed" as const, error: (err as Error).message, finishedAt: nowIso() } : r));
    m.status = "failed";
    m.checkpoint = { stage: "render", error: { code: (err as WalkError).code ?? "RENDER_FAILED", message: (err as Error).message }, at: nowIso() };
    await saveManifest(dir, m, `render ${id} failed`);
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** exports/latest points at the newest validated final render. */
async function pointLatest(dir: string, outDir: string, id: string) {
  const p = paths(dir);
  await mkdir(p.exports, { recursive: true });
  await writeFileAtomic(join(p.exports, "latest.json"), JSON.stringify({ id, dir: relative(p.root, outDir), at: nowIso() }, null, 2) + "\n");
  const link = join(p.exports, "latest");
  await unlink(link).catch(() => {});
  await symlink(relative(p.exports, outDir), link);
}

export function transcript(m: Manifest): string {
  const lines = [`# ${m.project.name}`, "", `_${m.project.objective}_`, ""];
  m.steps.forEach((s, i) => {
    if (!s.narration) return;
    lines.push(`${i + 1}. **${m.flow?.steps[i]?.title ?? s.id}** — ${s.narration.text}`);
  });
  return lines.join("\n") + "\n";
}
