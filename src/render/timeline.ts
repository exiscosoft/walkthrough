import type { Annotation, CaptionSegment, Manifest } from "../project/schema.js";
import type { Rect } from "../util.js";

export const FPS = 30;
export const OUT_W = 1920;
export const OUT_H = 1080;
export const CARD_MS = 2600;
/** Narration pace used only to size scenes that have no audio yet (previews). */
const ESTIMATE_MS_PER_CHAR = 62;

export type Scene =
  | { kind: "card"; id: string; eyebrow: string; title: string; subtitle?: string; durationMs: number }
  | {
      kind: "step";
      id: string;
      ordinal: number;
      shot: string;
      frame: { width: number; height: number };
      annotations: Annotation[];
      crop: Rect | null;
      audio?: string;
      audioMs: number;
      segments: CaptionSegment[];
      leadInMs: number;
      durationMs: number;
      estimated: boolean;
    };

export interface Timeline {
  scenes: (Scene & { startMs: number })[];
  transitionMs: number;
  totalMs: number;
}

/**
 * Scene length = lead-in + measured narration + pause. Lead-in and pause are
 * at least one transition long so narration never overlaps a cross-fade.
 */
export function buildTimeline(m: Manifest): Timeline {
  const t = m.project.timing;
  const T = quantize(t.transitionMs);
  const scenes: Scene[] = [
    { kind: "card", id: "intro", eyebrow: m.project.audience ? `For ${m.project.audience}` : "Walkthrough", title: m.project.name, subtitle: m.project.objective, durationMs: quantize(CARD_MS) },
  ];
  m.steps.forEach((s, i) => {
    if (!s.capture) return;
    const leadInMs = Math.max(s.leadInMs ?? t.leadInMs, T + 150);
    const pauseMs = Math.max(s.pauseMs ?? t.pauseMs, T + 150);
    const estimated = !s.clip;
    const audioMs = s.clip?.durationMs ?? Math.max(1500, (s.narration?.text.length ?? 20) * ESTIMATE_MS_PER_CHAR);
    scenes.push({
      kind: "step",
      id: s.id,
      ordinal: i + 1,
      shot: s.capture.shot.artifact,
      frame: { width: s.capture.shot.width, height: s.capture.shot.height },
      annotations: s.annotations,
      crop: s.crop ?? null,
      audio: s.clip?.artifact,
      audioMs,
      segments: s.clip?.segments ?? [],
      leadInMs,
      durationMs: quantize(leadInMs + audioMs + pauseMs, Math.ceil),
      estimated,
    });
  });
  scenes.push({ kind: "card", id: "outro", eyebrow: "You're done", title: m.project.outcome, durationMs: quantize(CARD_MS) });

  let cursor = 0;
  const placed = scenes.map((s, i) => {
    const startMs = cursor;
    cursor += s.durationMs - (i < scenes.length - 1 ? T : 0);
    return { ...s, startMs };
  });
  return { scenes: placed, transitionMs: T, totalMs: cursor };
}

/** Snap a duration to the frame grid so segment lengths, xfade offsets and captions agree exactly. */
export function quantize(ms: number, round: (n: number) => number = Math.round): number {
  return (round((ms * FPS) / 1000) * 1000) / FPS;
}

export function frames(ms: number): number {
  return Math.round((ms * FPS) / 1000);
}
