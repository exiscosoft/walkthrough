import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execa } from "execa";
import sharp from "sharp";
import YAML from "yaml";
import { overlaySvg } from "../annotate/draw.js";
import { normalizeCrop, suggestAnnotations, suggestCrop, unionRect } from "../annotate/suggest.js";
import { buildTimeline } from "../render/timeline.js";
import { checkGrounding } from "../script/grounding.js";
import { profileFor } from "../speech/voice.js";
import { escapeXml as esc, nowIso, WalkError, type Rect } from "../util.js";
import { validateProject } from "../validate/index.js";
import {
  approvalValid,
  clipState,
  deriveStatus,
  narrationHash,
  storyboardHash,
  unconfirmedRedactions,
  visualsHash,
} from "./invalidate.js";
import type { Annotation, Manifest } from "./schema.js";
import { artifactPath, loadManifest, loadRevision, paths, saveManifest } from "./store.js";

export type ApprovalKind = "storyboard" | "script" | "visuals";

/** Approvals bind to a content hash, so any later edit to that content voids them. */
export async function approve(dir: string, kind: ApprovalKind) {
  const m = await loadManifest(dir);
  const notCaptured = m.steps.filter((s) => s.status !== "captured").map((s) => s.id);
  if (kind === "storyboard" && notCaptured.length) {
    throw new WalkError("APPROVAL_PREMATURE", `Steps not captured: ${notCaptured.join(", ")}`, "Capture or revalidate them first.");
  }
  if (kind === "script") {
    const missing = m.steps.filter((s) => !s.narration?.text).map((s) => s.id);
    const errors = m.flow ? checkGrounding(m.flow.steps, m.steps).filter((g) => g.severity === "error") : [];
    if (missing.length || errors.length) {
      throw new WalkError(
        "APPROVAL_PREMATURE",
        [missing.length ? `No narration for: ${missing.join(", ")}` : "", ...errors.map((e) => `${e.step}: ${e.message}`)].filter(Boolean).join("\n"),
      );
    }
  }
  if (kind === "visuals") {
    const pending = unconfirmedRedactions(m);
    if (pending.length) {
      throw new WalkError("APPROVAL_PREMATURE", `${pending.length} redaction(s) still need review`, "Run `walkthrough redactions <dir>` and confirm them.");
    }
  }
  const hash = kind === "storyboard" ? storyboardHash(m) : kind === "script" ? narrationHash(m) : visualsHash(m);
  m.approvals = { ...m.approvals, [kind]: { revision: m.revision, hash, at: nowIso() } };
  m.status = deriveStatus(m, await profileFor(m));
  const saved = await saveManifest(dir, m, `approved ${kind}`);
  return { approved: kind, revision: saved.revision, status: saved.status };
}

export interface AnnotateOps {
  move?: { id: string; dx: number; dy: number };
  remove?: string;
  add?: Annotation;
  crop?: Rect | "none" | "auto";
  reset?: boolean;
}

/** Annotation edits only invalidate the render of this one scene. */
export async function annotate(dir: string, stepId: string, ops: AnnotateOps) {
  const m = await loadManifest(dir);
  const st = m.steps.find((s) => s.id === stepId);
  if (!st?.capture) throw new WalkError("STEP_NOT_CAPTURED", `Step "${stepId}" has no capture to annotate`);
  const frame = { width: st.capture.shot.width, height: st.capture.shot.height };
  const k = m.project.viewport.deviceScaleFactor;
  let anns = [...st.annotations];
  if (ops.reset) {
    anns = st.capture.target ? suggestAnnotations(st.capture.target.rect, frame, m.steps.indexOf(st) + 1, k) : [];
    st.crop = anns.length ? suggestCrop(unionRect(anns.map((a) => a.rect)), frame) : null;
  }
  if (ops.move) {
    const a = anns.find((x) => x.id === ops.move!.id);
    if (!a) throw new WalkError("ANNOTATION_NOT_FOUND", `No annotation "${ops.move.id}" on ${stepId}`);
    a.rect = { ...a.rect, x: a.rect.x + ops.move.dx, y: a.rect.y + ops.move.dy };
  }
  if (ops.remove) {
    if (!anns.some((a) => a.id === ops.remove)) throw new WalkError("ANNOTATION_NOT_FOUND", `No annotation "${ops.remove}" on ${stepId}`);
    anns = anns.filter((a) => a.id !== ops.remove);
  }
  if (ops.add) anns.push(ops.add);
  if (ops.crop === "none") st.crop = null;
  else if (ops.crop === "auto") st.crop = anns.length ? suggestCrop(unionRect(anns.map((a) => a.rect)), frame) : null;
  else if (ops.crop) st.crop = normalizeCrop(ops.crop, frame);
  st.annotations = anns;
  m.status = deriveStatus(m, await profileFor(m));
  const saved = await saveManifest(dir, m, `annotations edited: ${stepId}`);
  const issues = validateProject(dir, saved).filter((i) => i.step === stepId && /OVERLAY|CROP|HIGHLIGHT/.test(i.code));
  return { step: stepId, annotations: anns, crop: st.crop ?? null, issues };
}

export async function listRedactions(dir: string) {
  const m = await loadManifest(dir);
  return m.steps.flatMap((s) => (s.capture?.redactions ?? []).map((r) => ({ step: s.id, ...r, screenshot: artifactPath(dir, s.capture!.shot.artifact) })));
}

/** Confirm low-confidence masks after looking at them. Unmasking requires a recapture with redaction.allow. */
export async function confirmRedactions(dir: string, ids: string[] | "all") {
  const m = await loadManifest(dir);
  const confirmed: string[] = [];
  for (const s of m.steps) {
    for (const r of s.capture?.redactions ?? []) {
      if (!r.confirmed && (ids === "all" || ids.includes(r.id))) {
        r.confirmed = true;
        confirmed.push(r.id);
      }
    }
  }
  m.status = deriveStatus(m, await profileFor(m));
  await saveManifest(dir, m, `redactions confirmed: ${confirmed.join(", ")}`);
  return { confirmed, pending: unconfirmedRedactions(m).map((r) => r.id) };
}

export async function status(dir: string) {
  const m = await loadManifest(dir);
  const profile = await profileFor(m);
  const issues = validateProject(dir, m, profile);
  const latest = existsSync(join(paths(dir).exports, "latest.json")) ? JSON.parse(await readFile(join(paths(dir).exports, "latest.json"), "utf8")) : null;
  const errors = issues.filter((i) => i.severity === "error");
  return {
    project: m.project.name,
    revision: m.revision,
    status: m.status,
    checkpoint: m.checkpoint ?? null,
    steps: m.steps.map((s) => ({
      id: s.id,
      status: s.status,
      narration: s.narration ? `${s.narration.source}: ${s.narration.text}` : null,
      audio: clipState(s, m.project, profile),
      pendingRedactions: (s.capture?.redactions ?? []).filter((r) => !r.confirmed).length,
    })),
    approvals: {
      storyboard: approvalValid(m.approvals.storyboard, storyboardHash(m)),
      script: approvalValid(m.approvals.script, narrationHash(m)),
      visuals: approvalValid(m.approvals.visuals, visualsHash(m)),
    },
    blockingIssues: errors,
    warnings: issues.filter((i) => i.severity === "warning"),
    latestExport: latest,
    next: nextAction(m, errors.map((e) => e.code)),
  };
}

function nextAction(m: Manifest, codes: string[]): string {
  if (m.checkpoint?.error) return `Resolve ${m.checkpoint.error.code}${m.checkpoint.error.hint ? `: ${m.checkpoint.error.hint}` : ""}`;
  if (codes.includes("FLOW_MISSING")) return "Write flow.yaml, then `walkthrough plan`.";
  if (codes.includes("STEP_NOT_CAPTURED")) return "`walkthrough capture`";
  if (codes.includes("NARRATION_MISSING")) return "`walkthrough script draft` or `walkthrough script set`";
  if (codes.includes("REDACTION_UNCONFIRMED")) return "`walkthrough redactions` to review masks";
  if (codes.includes("GROUNDING")) return "Fix narration flagged by grounding checks";
  if (codes.includes("CLIP_MISSING") || codes.includes("CLIP_STALE")) return "`walkthrough narrate`";
  if (codes.includes("APPROVAL_MISSING")) return "`walkthrough storyboard`, review, then `walkthrough approve storyboard|script|visuals`";
  return m.status === "complete" ? "Done. `walkthrough export` builds the package." : "`walkthrough render`";
}

/** Static contact sheet: one card per step with the annotated frame, crop, action, narration and timing. */
export async function storyboard(dir: string) {
  const m = await loadManifest(dir);
  const p = paths(dir);
  const outDir = join(p.cache, "storyboard");
  await mkdir(outDir, { recursive: true });
  const timeline = buildTimeline(m);
  const profile = await profileFor(m);
  const issues = validateProject(dir, m, profile);
  const cards: string[] = [];
  for (const [i, s] of m.steps.entries()) {
    const fs = m.flow?.steps[i];
    let img = "";
    if (s.capture) {
      const frame = { width: s.capture.shot.width, height: s.capture.shot.height };
      const layers = [{ input: Buffer.from(overlaySvg(s.annotations, frame, m.project.brand, m.project.viewport.deviceScaleFactor)) }];
      if (s.crop) {
        const c = s.crop;
        layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}"><rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-dasharray="24 14"/></svg>`) });
      }
      const file = join(outDir, `${s.id}.jpg`);
      // sharp resizes before compositing within one pipeline, so composite at full size first.
      const annotated = await sharp(artifactPath(dir, s.capture.shot.artifact)).composite(layers).png().toBuffer();
      await sharp(annotated).resize(1280).jpeg({ quality: 82 }).toFile(file);
      img = `<img src="${esc(relative(p.root, file))}" alt="${esc(s.id)} screenshot">`;
    }
    const scene = timeline.scenes.find((x) => x.id === s.id);
    const stepIssues = issues.filter((x) => x.step === s.id);
    cards.push(`<article class="card ${s.status}">
  <header><span class="n">${i + 1}</span><h2>${esc(fs?.title ?? s.id)}</h2><span class="badge">${esc(s.status)}</span></header>
  ${img || '<div class="empty">Not captured</div>'}
  <dl>
    <dt>Action</dt><dd><code>${esc(fs ? JSON.stringify(fs.action) : "")}</code></dd>
    <dt>Narration</dt><dd>${s.narration ? `${esc(s.narration.text)} <small>(${s.narration.source})</small>` : "<em>none</em>"}</dd>
    <dt>Audio</dt><dd>${clipState(s, m.project, profile)}${s.clip ? `, ${(s.clip.durationMs / 1000).toFixed(1)}s, ${s.clip.engine}` : ""}</dd>
    <dt>Scene</dt><dd>${scene ? `${(scene.durationMs / 1000).toFixed(1)}s` : "-"}${s.crop ? ", zoomed" : ", full frame"}; annotations: ${s.annotations.map((a) => esc(a.id)).join(", ") || "none"}</dd>
  </dl>
  ${stepIssues.length ? `<ul class="issues">${stepIssues.map((x) => `<li class="${x.severity}">${esc(x.code)}: ${esc(x.message)}</li>`).join("")}</ul>` : ""}
</article>`);
  }
  const global = issues.filter((x) => !x.step);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.project.name)} storyboard</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f8; --card:#fff; --fg:#1b2030; --muted:#5b6475; --line:#d9dde6; --err:#b3261e; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151c; --card:#1b2029; --fg:#e8ebf1; --muted:#9aa3b5; --line:#2c3341; --err:#ff8a80; --warn:#ffcc66; } }
  body { margin:0; padding:24px 16px 64px; font:15px/1.5 -apple-system, Helvetica, Arial, sans-serif; background:var(--bg); color:var(--fg); }
  h1 { margin:0 0 4px; font-size:24px; } .meta { color:var(--muted); margin:0 0 20px; }
  .grid { display:grid; gap:20px; grid-template-columns:repeat(auto-fill, minmax(min(100%, 520px), 1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .card header { display:flex; align-items:center; gap:10px; padding:12px 16px; }
  .card h2 { font-size:16px; margin:0; flex:1; } .n { font-weight:700; color:var(--muted); }
  .badge { font-size:12px; padding:2px 8px; border-radius:99px; border:1px solid var(--line); }
  .needs_validation .badge, .failed .badge { color:var(--err); border-color:var(--err); }
  img { display:block; width:100%; height:auto; border-block:1px solid var(--line); }
  .empty { padding:60px 16px; text-align:center; color:var(--muted); }
  dl { display:grid; grid-template-columns:90px 1fr; gap:6px 12px; padding:12px 16px; margin:0; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; } code { font-size:12px; }
  .issues { margin:0; padding:0 16px 14px 32px; } .error { color:var(--err); } .warning { color:var(--warn); }
</style></head><body>
<h1>${esc(m.project.name)}</h1>
<p class="meta">Revision ${m.revision} · ${esc(m.status)} · ${(timeline.totalMs / 1000).toFixed(1)}s total · ${esc(m.project.objective)}</p>
${global.length ? `<ul class="issues">${global.map((x) => `<li class="${x.severity}">${esc(x.code)}: ${esc(x.message)}</li>`).join("")}</ul>` : ""}
<div class="grid">${cards.join("\n")}</div>
</body></html>`;
  await writeFile(p.storyboard, html);
  return { file: p.storyboard, steps: m.steps.length, issues: issues.length };
}

/**
 * Shareable package: sanitised manifest and flow, the artifacts they reference, and the
 * latest validated render. Browser profiles, voice data, revisions and evidence stay behind.
 */
export async function exportPackage(dir: string) {
  const p = paths(dir);
  const latestFile = join(p.exports, "latest.json");
  if (!existsSync(latestFile)) throw new WalkError("NO_EXPORT", "No validated final render yet", "Run `walkthrough render` without --preview.");
  const latest = JSON.parse(await readFile(latestFile, "utf8")) as { id: string; dir: string };
  // Package the exact revision the validated render was built from, not whatever changed since.
  const job = JSON.parse(await readFile(join(p.root, latest.dir, "render-job.json"), "utf8")) as { revision: number };
  const m = await loadRevision(dir, job.revision);
  const sanitized = sanitize(m);
  const stage = await mkdtemp(join(p.cache, "package-"));
  const name = `${latest.id}-package`;
  const root = join(stage, name);
  try {
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "project.json"), JSON.stringify(sanitized, null, 2) + "\n");
    if (sanitized.flow) await writeFile(join(root, "flow.yaml"), YAML.stringify(sanitized.flow));
    const refs = new Set<string>();
    for (const s of m.steps) {
      if (s.capture) {
        refs.add(s.capture.shot.artifact);
        if (s.capture.after) refs.add(s.capture.after.artifact);
      }
      if (s.clip) refs.add(s.clip.artifact);
    }
    for (const ref of refs) await cp(artifactPath(dir, ref), join(root, "artifacts", ref));
    await cp(join(p.root, latest.dir), join(root, "render"), { recursive: true });
    const out = join(p.exports, `${name}.tar.gz`);
    await execa("tar", ["-czf", out, "-C", stage, name]);
    return { package: out, render: latest.id, revision: job.revision, artifacts: refs.size };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function sanitize(m: Manifest): Manifest {
  const copy: Manifest = JSON.parse(JSON.stringify(m));
  if (copy.flow) {
    for (const [k, v] of Object.entries(copy.flow.testData)) {
      if (typeof v !== "string" && v.sensitive) copy.flow.testData[k] = { sensitive: true, env: v.env, value: v.value === undefined ? undefined : "[redacted]" };
    }
  }
  copy.project.browserProfile = "[local]";
  // Errors and checkpoints can quote page URLs (invite tokens and the like); captured URLs lose their query strings.
  delete copy.checkpoint;
  copy.renders = copy.renders.filter((r) => r.status === "complete").map((r) => ({ ...r, error: undefined }));
  for (const s of copy.steps) if (s.capture) s.capture.url = s.capture.url.replace(/[?#].*$/, "");
  return copy;
}
