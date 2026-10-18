import type { CaptionSegment } from "../project/schema.js";
import { splitSentences } from "../util.js";

export interface TimedWord {
  word: string;
  startMs: number;
  endMs: number;
}

export function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => normalize(w));
}

function normalize(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Levenshtein alignment over normalised tokens; returns, for each ref token, the matched hyp index or -1. */
function alignTokens(ref: string[], hyp: string[]): { map: number[]; edits: number } {
  const n = ref.length;
  const m = hyp.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      d[i]![j] = Math.min(sub, d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
    }
  }
  const map = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      map[i - 1] = j - 1;
      i--;
      j--;
    } else if (d[i]![j] === d[i - 1]![j]! + 1) i--;
    else j--;
  }
  return { map, edits: d[n]![m]! };
}

/** Word error rate of a transcription against the intended text. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = words(reference).map(normalize);
  const hyp = words(hypothesis).map(normalize);
  return ref.length ? alignTokens(ref, hyp).edits / ref.length : 0;
}

/** Give every word of the script a time, using ASR word timings and interpolating across gaps. */
export function alignScript(script: string, asr: TimedWord[], totalMs: number): TimedWord[] {
  const ref = words(script);
  const { map } = alignTokens(ref.map(normalize), asr.map((w) => normalize(w.word)));
  const out: (TimedWord | null)[] = ref.map((w, i) => (map[i]! >= 0 ? { word: w, startMs: asr[map[i]!]!.startMs, endMs: asr[map[i]!]!.endMs } : null));
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    let j = i;
    while (j < out.length && !out[j]) j++;
    const from = i > 0 ? out[i - 1]!.endMs : 0;
    const to = j < out.length ? out[j]!.startMs : totalMs;
    const span = Math.max(0, to - from) / (j - i);
    for (let k = i; k < j; k++) out[k] = { word: ref[k]!, startMs: Math.round(from + span * (k - i)), endMs: Math.round(from + span * (k - i + 1)) };
  }
  return out as TimedWord[];
}

/** Sentence segments from per-word times. */
export function sentencesFromWords(text: string, timed: TimedWord[]): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    const n = words(sentence).length;
    const slice = timed.slice(cursor, cursor + n);
    cursor += n;
    if (slice.length) out.push({ text: sentence, startMs: slice[0]!.startMs, endMs: slice.at(-1)!.endMs });
  }
  return out;
}

/** Fallback when no aligner is available: time sentences by character share. */
export function proportionalSegments(text: string, totalMs: number): CaptionSegment[] {
  const sentences = splitSentences(text);
  const total = sentences.reduce((a, s) => a + s.length, 0) || 1;
  let t = 0;
  return sentences.map((s) => {
    const start = t;
    t += (totalMs * s.length) / total;
    return { text: s, startMs: Math.round(start), endMs: Math.round(t) };
  });
}

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_CUE_CHARS = 84; // two lines of 42

/** Split long sentences into cues of at most two caption lines, timed by character share. */
export function cuesFor(segment: CaptionSegment, offsetMs: number): Cue[] {
  const chunks: string[] = [];
  let current = "";
  for (const w of segment.text.split(/\s+/)) {
    const next = current ? `${current} ${w}` : w;
    if (next.length > MAX_CUE_CHARS && current) {
      chunks.push(current);
      current = w;
    } else current = next;
  }
  if (current) chunks.push(current);
  const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
  const span = segment.endMs - segment.startMs;
  let t = segment.startMs;
  return chunks.map((c) => {
    const start = t;
    t += (span * c.length) / total;
    return { startMs: Math.round(offsetMs + start), endMs: Math.round(offsetMs + t), text: wrap(c) };
  });
}

function wrap(text: string): string {
  if (text.length <= 42) return text;
  const mid = text.lastIndexOf(" ", Math.ceil(text.length / 2) + 6);
  return mid > 0 ? `${text.slice(0, mid)}\n${text.slice(mid + 1)}` : text;
}

function stamp(ms: number, sep: "," | "."): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = Math.round(ms % 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, ",")} --> ${stamp(c.endMs, ",")}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  return "WEBVTT\n\n" + cues.map((c) => `${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${c.text}\n`).join("\n");
}
