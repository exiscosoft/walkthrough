import type { Approval, Flow, FlowStep, JobState, Manifest, ProjectConfig, StepState, VoiceProfile } from "./schema.js";
import { hashOf, nowIso } from "../util.js";

/** Identity of what a step does. A change here invalidates this and every later capture. */
export function actionHash(step: FlowStep): string {
  return hashOf({ action: step.action, expect: step.expect, sideEffect: step.sideEffect, dialog: step.dialogExpected });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apply the pronunciation dictionary. Affects TTS input only, never the visible transcript. */
export function spokenText(text: string, pronunciation: Record<string, string>): string {
  let out = text;
  // Longest keys first so "SSO login" wins over "SSO".
  for (const key of Object.keys(pronunciation).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w])${escapeRegExp(key)}(?![\\w])`, "g"), pronunciation[key]!);
  }
  return out;
}

export function scriptHash(text: string, project: ProjectConfig, profile?: Pick<VoiceProfile, "id" | "version" | "reference">): string {
  return hashOf({
    spoken: spokenText(text, project.pronunciation),
    engine: project.voice.engine,
    settings: project.voice.settings,
    // The reference audio's own hash: clips go stale if the recording changes, whatever the version says.
    profile: profile ? { id: profile.id, version: profile.version, reference: profile.reference.sha256 } : null,
  });
}

export type ClipState = "missing" | "stale" | "current";

export function clipState(step: StepState, project: ProjectConfig, profile?: VoiceProfile): ClipState {
  if (!step.clip) return "missing";
  if (!step.narration) return "stale";
  // Imported recordings are tied to their script text, not to an engine or voice profile.
  const expected =
    step.clip.engine === "import"
      ? importScriptHash(step.narration.text)
      : scriptHash(step.narration.text, project, profile);
  return step.clip.scriptHash === expected ? "current" : "stale";
}

export function importScriptHash(text: string): string {
  return hashOf({ importedFor: text.trim() });
}

/**
 * Merge a (re)planned flow into step state. Steps keep their evidence unless the
 * path to them changed: a changed action, or a step inserted, removed or reordered
 * at or before them. Those steps, and every later captured step, need validation.
 */
export function applyFlow(m: Manifest, flow: Flow): { steps: StepState[]; invalidated: string[]; narrationUpdated: string[] } {
  const prior = new Map(m.steps.map((s) => [s.id, s]));
  const priorOrder = m.steps.map((s) => s.id);
  const priorFlowNarration = new Map((m.flow?.steps ?? []).map((s) => [s.id, s.narration]));
  const invalidated: string[] = [];
  const narrationUpdated: string[] = [];
  let cascade = false;
  const steps = flow.steps.map((fs, i): StepState => {
    const existing = prior.get(fs.id);
    // Narration written in flow.yaml fills in when nothing better exists, and wins whenever the flow's text itself changed.
    let narration = existing?.narration;
    if (fs.narration && narration?.text !== fs.narration) {
      const replaceable = !narration || narration.source === "template" || narration.source === "flow";
      if (replaceable || priorFlowNarration.get(fs.id) !== fs.narration) {
        narration = { text: fs.narration, source: "flow", updatedAt: nowIso() };
        narrationUpdated.push(fs.id);
      }
    }
    if (priorOrder[i] !== fs.id) cascade = true;
    if (!existing) return { id: fs.id, status: "planned", annotations: [], narration };
    if (existing.capture && existing.capture.actionHash !== actionHash(fs)) cascade = true;
    if (cascade && existing.capture) {
      invalidated.push(fs.id);
      return { ...existing, narration, status: "needs_validation" };
    }
    return { ...existing, narration };
  });
  return { steps, invalidated, narrationUpdated };
}

export function storyboardHash(m: Manifest): string {
  return hashOf(
    m.steps.map((s) => ({ id: s.id, shot: s.capture?.shot.artifact, annotations: s.annotations, crop: s.crop ?? null })),
  );
}

export function narrationHash(m: Manifest): string {
  return hashOf(m.steps.map((s) => ({ id: s.id, text: s.narration?.text ?? "" })));
}

export function visualsHash(m: Manifest): string {
  return hashOf({
    storyboard: storyboardHash(m),
    redactions: m.steps.map((s) => s.capture?.redactions.map((r) => [r.id, r.confirmed]) ?? []),
    brand: m.project.brand,
  });
}

/** Everything a final render depends on; a completed render with this hash is still current. */
export function renderInputsHash(m: Manifest): string {
  return hashOf({
    storyboard: storyboardHash(m),
    clips: m.steps.map((s) => [s.clip?.artifact ?? null, s.leadInMs ?? null, s.pauseMs ?? null]),
    narration: narrationHash(m),
    brand: m.project.brand,
    timing: m.project.timing,
  });
}

export function approvalValid(approval: Approval | undefined, currentHash: string): boolean {
  return approval !== undefined && approval.hash === currentHash;
}

export function unconfirmedRedactions(m: Manifest) {
  return m.steps.flatMap((s) =>
    (s.capture?.redactions ?? []).filter((r) => r.confidence === "low" && !r.confirmed).map((r) => ({ step: s.id, ...r })),
  );
}

/** Resting status implied by the manifest contents (active stages set their own status). */
export function deriveStatus(m: Manifest, profile?: VoiceProfile): JobState {
  if (!m.flow) return "draft";
  if (m.steps.some((s) => s.status === "planned" || s.status === "failed")) return "planned";
  if (
    m.steps.some((s) => s.status === "needs_validation") ||
    unconfirmedRedactions(m).length > 0 ||
    !approvalValid(m.approvals.storyboard, storyboardHash(m)) ||
    !approvalValid(m.approvals.script, narrationHash(m))
  ) {
    return "review_required";
  }
  if (m.steps.some((s) => clipState(s, m.project, profile) !== "current")) return "generating_audio";
  const last = m.renders.at(-1);
  if (last && !last.preview && last.status === "complete" && last.inputsHash === renderInputsHash(m)) return "complete";
  return "ready_to_render";
}
