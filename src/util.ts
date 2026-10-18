import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Error carrying a stable machine-readable code and a hint the user can act on. */
export class WalkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    /** Paused errors need user action but are not engine failures (exit code 2). */
    readonly paused = false,
  ) {
    super(message);
  }
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable JSON: object keys sorted so hashes don't depend on insertion order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function hashOf(value: unknown): string {
  return sha256(stableStringify(value)).slice(0, 16);
}

export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function scaleRect(r: Rect, k: number): Rect {
  return { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k };
}

export function padRect(r: Rect, p: number): Rect {
  return { x: r.x - p, y: r.y - p, width: r.width + 2 * p, height: r.height + 2 * p };
}

// Only abbreviations that rarely end a sentence: "etc." or "No." often do ("Click No.").
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "vs.", "mr.", "mrs.", "ms.", "dr.", "approx."]);

/**
 * Split narration into sentences, keeping terminal punctuation. A sentence ends only
 * at a word ending in . ! or ? (optionally followed by closing quotes or brackets),
 * so "acme.com", "$9.99" and "v2.4.1" stay whole, as do common abbreviations.
 * speech/walkthrough_speech/audio.py implements the same rule; keep them in step.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    current.push(word);
    if (/[.!?]["'”’)\]]*$/.test(word) && !ABBREVIATIONS.has(word.toLowerCase().replace(/["'”’)\]]+$/, ""))) {
      out.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) out.push(current.join(" "));
  return out;
}
