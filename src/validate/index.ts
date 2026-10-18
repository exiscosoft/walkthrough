import { existsSync } from "node:fs";
import { MIN_CROP_FRACTION } from "../annotate/suggest.js";
import {
  approvalValid,
  clipState,
  narrationHash,
  storyboardHash,
  unconfirmedRedactions,
  visualsHash,
} from "../project/invalidate.js";
import type { Manifest, VoiceProfile } from "../project/schema.js";
import { artifactPath } from "../project/store.js";
import { checkGrounding } from "../script/grounding.js";
import type { Cue } from "../render/captions.js";
import { probe } from "../render/ffmpeg.js";
import { OUT_H, OUT_W, type Timeline } from "../render/timeline.js";
import { contains, intersects } from "../util.js";

export interface Issue {
  code: string;
  severity: "error" | "warning";
  step?: string;
  message: string;
}

/** Codes that only an approved, final export must clear. Previews may render despite them. */
const FINAL_ONLY = new Set([
  "APPROVAL_MISSING",
  "CLIP_MISSING",
  "CLIP_STALE",
  "NARRATION_MISSING",
  "REDACTION_UNCONFIRMED",
  "GROUNDING",
  "OUTCOME_UNPROVEN",
]);

export function blocksPreview(issue: Issue): boolean {
  return issue.severity === "error" && !FINAL_ONLY.has(issue.code);
}

export function validateProject(projectDir: string, m: Manifest, profile?: VoiceProfile): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string, step?: string) => issues.push({ code, severity: "error", message, step });
  const warn = (code: string, message: string, step?: string) => issues.push({ code, severity: "warning", message, step });

  if (!m.flow) {
    err("FLOW_MISSING", "No flow has been planned.");
    return issues;
  }
  for (const [i, st] of m.steps.entries()) {
    const fs = m.flow.steps[i]!;
    if (st.status !== "captured" || !st.capture) {
      err("STEP_NOT_CAPTURED", `Step is ${st.status}; capture it before rendering.`, st.id);
      continue;
    }
    if (!existsSync(artifactPath(projectDir, st.capture.shot.artifact))) err("SCREENSHOT_MISSING", "Screenshot artifact is missing.", st.id);
    if (!st.narration?.text) err("NARRATION_MISSING", "Step has no narration.", st.id);
    const cs = clipState(st, m.project, profile);
    if (st.narration?.text && cs !== "current") err(cs === "missing" ? "CLIP_MISSING" : "CLIP_STALE", `Narration audio is ${cs}.`, st.id);
    if (st.clip) {
      const bad = st.clip.segments.find((s) => s.startMs < 0 || s.endMs > st.clip!.durationMs + 50 || s.endMs <= s.startMs);
      if (bad) err("CAPTION_OUT_OF_RANGE", `Caption "${bad.text}" falls outside its audio.`, st.id);
    }

    const target = st.capture.target?.rect;
    if (target) {
      for (const a of st.annotations) {
        if (a.kind === "callout" && intersects(a.rect, target)) err("OVERLAY_COVERS_TARGET", `Callout ${a.id} covers the highlighted control.`, st.id);
        if ((a.kind === "outline" || a.kind === "spotlight") && !contains(a.rect, target)) {
          warn("HIGHLIGHT_MISALIGNED", `${a.kind} ${a.id} does not fully surround the control.`, st.id);
        }
      }
      if (st.crop && !contains(st.crop, target)) err("CROP_HIDES_TARGET", "The zoom crop cuts off the highlighted control.", st.id);
    }
    if (st.crop) {
      const W = st.capture.shot.width;
      const H = st.capture.shot.height;
      const c = st.crop;
      if (c.x < 0 || c.y < 0 || c.x + c.width > W || c.y + c.height > H) err("CROP_OUT_OF_FRAME", "The zoom crop extends outside the screenshot.", st.id);
      if (Math.abs(c.width / c.height - W / H) > 0.02) err("CROP_ASPECT", "The zoom crop is not 16:9; use `annotate --crop` to reset it.", st.id);
    }
    if (st.crop && st.crop.width < st.capture.shot.width * MIN_CROP_FRACTION - 1) {
      warn("CROP_TOO_TIGHT", "Zoom is tighter than the legibility limit; text will be upscaled.", st.id);
    }
    if (fs.outcome && !st.capture.expectPassed) err("OUTCOME_UNPROVEN", "Outcome step did not pass its expectations.", st.id);
  }
  if (!m.flow.steps.some((fs, i) => fs.outcome && m.steps[i]?.capture?.expectPassed)) {
    err("OUTCOME_UNPROVEN", "No captured step proves the stated outcome (mark one step outcome: true).");
  }
  for (const r of unconfirmedRedactions(m)) {
    err("REDACTION_UNCONFIRMED", `Low-confidence redaction ${r.id} (${r.detail}) needs review.`, r.step);
  }
  for (const g of checkGrounding(m.flow.steps, m.steps)) {
    (g.severity === "error" ? err : warn)(g.severity === "error" ? "GROUNDING" : "LABEL_NOT_OBSERVED", g.message, g.step);
  }
  if (!approvalValid(m.approvals.storyboard, storyboardHash(m))) err("APPROVAL_MISSING", "Storyboard is not approved at its current state.");
  if (!approvalValid(m.approvals.script, narrationHash(m))) err("APPROVAL_MISSING", "Script is not approved at its current state.");
  if (!approvalValid(m.approvals.visuals, visualsHash(m))) {
    err("APPROVAL_MISSING", "Visuals have not been confirmed as suitable to share (`walkthrough approve visuals`).");
  }
  return issues;
}

/** Post-render checks on the encoded file and caption track. */
export async function validateOutput(file: string, timeline: Timeline, cues: Cue[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const info = await probe(file);
  const v = info.streams.find((s: any) => s.codec_type === "video");
  const a = info.streams.find((s: any) => s.codec_type === "audio");
  if (!v || v.codec_name !== "h264" || v.width !== OUT_W || v.height !== OUT_H) {
    issues.push({ code: "OUTPUT_VIDEO_FORMAT", severity: "error", message: `Expected ${OUT_W}x${OUT_H} h264, got ${v?.codec_name} ${v?.width}x${v?.height}` });
  }
  if (!a || a.codec_name !== "aac") issues.push({ code: "OUTPUT_AUDIO_FORMAT", severity: "error", message: `Expected AAC audio, got ${a?.codec_name}` });
  const dur = Number(info.format.duration) * 1000;
  if (Math.abs(dur - timeline.totalMs) > 100) {
    issues.push({ code: "OUTPUT_DURATION", severity: "error", message: `Duration ${dur.toFixed(0)} ms differs from timeline ${timeline.totalMs.toFixed(0)} ms` });
  }
  cues.forEach((c, i) => {
    const prev = cues[i - 1];
    if (c.endMs > timeline.totalMs || (prev && c.startMs < prev.endMs - 1)) {
      issues.push({ code: "CAPTION_TIMING", severity: "error", message: `Caption ${i + 1} overlaps or runs past the end` });
    }
  });
  return issues;
}
