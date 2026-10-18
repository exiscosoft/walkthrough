import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import type { FlowStep, Manifest, StepState } from "../project/schema.js";
import { loadManifest, paths, saveManifest } from "../project/store.js";
import { deriveStatus } from "../project/invalidate.js";
import { nowIso, WalkError } from "../util.js";
import { profileFor } from "../speech/voice.js";

function targetName(fs: FlowStep, st: StepState): string | undefined {
  const t = "target" in fs.action ? fs.action.target : undefined;
  return st.capture?.target?.name ?? (t && ("name" in t ? t.name : "label" in t ? t.label : "text" in t ? t.text : undefined));
}

/**
 * Template narration built only from observed labels. Agents and people replace it;
 * it exists so a manual workflow always has a starting point.
 */
export function templateNarration(m: Manifest, fs: FlowStep, st: StepState): string | undefined {
  if (!st.capture) return undefined;
  const name = targetName(fs, st);
  const a = fs.action;
  switch (a.type) {
    case "goto":
    case "manual":
      return `${fs.title}.`;
    case "click":
      return name ? `Click "${name}".` : `${fs.title}.`;
    case "fill": {
      const sensitive = /\$\{testData\./.test(a.value) || /password/i.test(name ?? "");
      if (!name) return `${fs.title}.`;
      return sensitive ? `Fill in "${name}".` : `In "${name}", enter ${a.value}.`;
    }
    case "select":
      return `Choose ${a.option} from "${name}".`;
    case "check":
      return `${a.checked ? "Select" : "Clear"} the "${name}" checkbox.`;
    case "scroll":
      return name ? `Scroll down to "${name}".` : "Scroll down the page.";
    case "observe":
      return fs.outcome && st.capture.expectPassed ? `${m.project.outcome.replace(/\.?$/, ".")}` : `${fs.title}.`;
  }
}

export async function draftScript(dir: string, opts: { force?: boolean } = {}) {
  const m = await loadManifest(dir);
  if (!m.flow) throw new WalkError("FLOW_MISSING", "Plan a flow first");
  const drafted: string[] = [];
  m.steps = m.steps.map((st, i) => {
    if (st.narration && !(opts.force && st.narration.source === "template")) return st;
    const text = templateNarration(m, m.flow!.steps[i]!, st);
    if (!text) return st;
    drafted.push(st.id);
    return { ...st, narration: { text, source: "template", updatedAt: nowIso() } };
  });
  m.status = deriveStatus(m, await profileFor(m));
  const saved = await saveManifest(dir, m, `script draft (${drafted.length})`);
  return { revision: saved.revision, drafted, script: scriptView(saved) };
}

export function scriptView(m: Manifest) {
  return m.steps.map((s) => ({ id: s.id, text: s.narration?.text ?? null, source: s.narration?.source ?? null }));
}

export async function setNarration(dir: string, updates: Record<string, string>, source: "agent" | "human") {
  const m = await loadManifest(dir);
  const ids = new Set(m.steps.map((s) => s.id));
  const unknown = Object.keys(updates).filter((id) => !ids.has(id));
  if (unknown.length) throw new WalkError("STEP_NOT_FOUND", `Unknown step(s): ${unknown.join(", ")}`);
  const changed: string[] = [];
  m.steps = m.steps.map((st) => {
    const text = updates[st.id]?.trim();
    if (text === undefined || text === st.narration?.text) return st;
    changed.push(st.id);
    return { ...st, narration: { text, source, updatedAt: nowIso() } };
  });
  m.status = deriveStatus(m, await profileFor(m));
  const saved = await saveManifest(dir, m, `narration edited: ${changed.join(", ") || "no changes"}`);
  return { revision: saved.revision, changed };
}

/** script.yaml is the editable form: `steps: { <id>: <text> }`. */
export async function exportScript(dir: string) {
  const m = await loadManifest(dir);
  const doc = { steps: Object.fromEntries(m.steps.map((s) => [s.id, s.narration?.text ?? ""])) };
  await writeFile(paths(dir).script, "# Edit narration per step, then run `walkthrough script import`.\n" + YAML.stringify(doc));
  return { file: paths(dir).script };
}

export async function importScript(dir: string, source: "agent" | "human") {
  const file = paths(dir).script;
  if (!existsSync(file)) throw new WalkError("SCRIPT_MISSING", `No ${file}`, "Run `walkthrough script export` first.");
  const doc = YAML.parse(await readFile(file, "utf8")) as { steps?: Record<string, string> };
  if (!doc?.steps) throw new WalkError("SCRIPT_INVALID", "script.yaml needs a top-level `steps` map");
  const updates = Object.fromEntries(Object.entries(doc.steps).filter(([, v]) => typeof v === "string" && v.trim()));
  return setNarration(dir, updates, source);
}
