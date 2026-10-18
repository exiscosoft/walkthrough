import { join } from "node:path";
import { execa } from "execa";
import type { Page } from "playwright";
import { suggestAnnotations, suggestCrop, unionRect } from "../annotate/suggest.js";
import { actionHash, deriveStatus } from "../project/invalidate.js";
import type { Capture, FlowStep, Manifest, StepState } from "../project/schema.js";
import { loadManifest, paths, putArtifact, saveManifest } from "../project/store.js";
import { nowIso, scaleRect, WalkError, writeFileAtomic, type Rect } from "../util.js";
import { findTarget, performAction, resolveUrl, resolveValue, sensitiveValues, snapshotNames, type ResolvedTarget } from "./actions.js";
import { openSession, type BrowserSession } from "./browser.js";
import { assertMutationAllowed, checkInterruptions, hostAllowed, isMutating } from "./guards.js";
import { redactedScreenshot, scrubText } from "./redact.js";
import { waitForAssertions, waitForStable } from "./stability.js";
import { profileFor } from "../speech/voice.js";

export interface CaptureOptions {
  stepId?: string;
  all?: boolean;
  headed?: boolean;
  reset?: boolean;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface CaptureResult {
  captured: string[];
  replayed: string[];
  warnings: string[];
}

/** FR01: refuse to drive a browser until the brief and environment are complete. */
export function requireCaptureInputs(m: Manifest): asserts m is Manifest & { flow: NonNullable<Manifest["flow"]> } {
  const p = m.project;
  const missing = (["name", "objective", "audience", "outcome", "startUrl"] as const).filter((k) => !p[k]?.trim());
  if (missing.length) {
    throw new WalkError("PROJECT_INCOMPLETE", `Missing project fields: ${missing.join(", ")}`, "Fill them in with `walkthrough init` options or edit project.json.");
  }
  if (!m.flow) throw new WalkError("FLOW_MISSING", "No flow has been planned", "Write flow.yaml and run `walkthrough plan <dir>`.");
}

/** Actions whose instruction is best shown on the state before they happen; the rest show the result. */
const BEFORE_ACTION = new Set(["click", "check"]);

/**
 * Steps up to `last` whose data-changing action already ran and isn't safe to repeat.
 * Keyed on actionExecutedAt alone: it is only ever set for actions judged mutating at run time,
 * including clicks that are mutating only because of their resolved label.
 */
export function replayBlockers(flowSteps: FlowStep[], states: StepState[], last: number): FlowStep[] {
  return flowSteps.slice(0, last + 1).filter((fs, i) => states[i]?.actionExecutedAt && !fs.idempotent);
}

/** Which step indices this run must capture (others before the last one are replayed only). */
function selectTargets(m: Manifest, opts: CaptureOptions): number[] {
  if (opts.stepId) {
    const i = m.steps.findIndex((s) => s.id === opts.stepId);
    if (i < 0) throw new WalkError("STEP_NOT_FOUND", `No step "${opts.stepId}" in the flow`);
    return [i];
  }
  return m.steps.flatMap((s, i) => (opts.all || s.status !== "captured" ? [i] : []));
}

export async function capture(dir: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
  const log = opts.log ?? (() => {});
  let m = await loadManifest(dir);
  requireCaptureInputs(m);
  const flow = m.flow;
  const targets = new Set(selectTargets(m, opts));
  const result: CaptureResult = { captured: [], replayed: [], warnings: [] };
  if (targets.size === 0) return result;
  const last = Math.max(...targets);

  // Data-changing steps that already ran must not run again on dirty data.
  if (opts.reset) {
    if (!m.project.resetCommand) {
      throw new WalkError("RESET_UNAVAILABLE", "--reset needs project.resetCommand", "Set resetCommand in project.json, e.g. `pnpm db:seed:demo`.");
    }
    log(`resetting demo data: ${m.project.resetCommand}`);
    // Output goes to the log (stderr), never stdout, so `--json` output stays parseable.
    const r = await execa(m.project.resetCommand, { shell: true, all: true, reject: false });
    for (const line of String(r.all ?? "").split("\n").filter(Boolean)) log(`  ${line}`);
    if (r.exitCode !== 0) {
      throw new WalkError("RESET_FAILED", `resetCommand exited with ${r.exitCode ?? r.signal}`, "Fix the reset command or reset the demo data by hand.");
    }
    m.steps = m.steps.map((s) => ({ ...s, actionExecutedAt: undefined }));
  } else {
    const blocked = replayBlockers(flow.steps, m.steps, last);
    if (blocked.length) {
      throw new WalkError(
        "REPLAY_REQUIRES_RESET",
        `Reaching this state would repeat data-changing step(s): ${blocked.map((s) => s.id).join(", ")}`,
        m.project.resetCommand
          ? "Run again with --reset to restore the demo data first."
          : "Reset the demo data, then set project.resetCommand so `--reset` can do it, or mark the step idempotent.",
        true,
      );
    }
  }

  m.status = "capturing";
  m.checkpoint = { stage: "capture", at: nowIso() };
  m = await saveManifest(dir, m, "capture started");

  let session: BrowserSession | undefined;
  try {
    session = await openSession(m.project, flow, { headed: opts.headed });
    await session.page.goto("about:blank");
    for (let i = 0; i <= last; i++) {
      const fs = flow.steps[i]!;
      const doCapture = targets.has(i);
      log(`${doCapture ? "capture" : "replay "} ${i + 1}/${flow.steps.length} ${fs.id}`);
      try {
        const captureRecord = await runStep(dir, m, session, fs, i, doCapture, opts.timeoutMs ?? 10_000, log);
        if (captureRecord) {
          m.steps[i] = applyCapture(m.steps[i]!, captureRecord, m.project.viewport.deviceScaleFactor, i + 1);
          result.captured.push(fs.id);
          if (captureRecord.externalHosts.length) {
            result.warnings.push(`${fs.id}: loaded resources from ${captureRecord.externalHosts.join(", ")}`);
          }
        } else {
          result.replayed.push(fs.id);
        }
        m.checkpoint = { stage: "capture", stepId: fs.id, at: nowIso() };
        m = await saveManifest(dir, m, `captured ${fs.id}`);
      } catch (err) {
        const e = err instanceof WalkError ? err : new WalkError("CAPTURE_FAILED", (err as Error).message, undefined, false);
        const st = m.steps[i]!;
        if (doCapture) m.steps[i] = { ...st, status: st.capture ? "needs_validation" : "failed" };
        m.checkpoint = { stage: "capture", stepId: fs.id, error: { code: e.code, message: e.message, hint: e.hint }, at: nowIso() };
        m.status = e.paused ? "review_required" : "failed";
        await saveManifest(dir, m, `capture stopped at ${fs.id}: ${e.code}`);
        throw e;
      }
    }
  } finally {
    await session?.close().catch(() => {});
  }
  m.status = deriveStatus(m, await profileFor(m));
  m.checkpoint = { stage: "capture", at: nowIso() };
  await saveManifest(dir, m, "capture finished");
  return result;
}

async function runStep(
  dir: string,
  m: Manifest,
  session: BrowserSession,
  fs: FlowStep,
  index: number,
  doCapture: boolean,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<Omit<Capture, "capturedAt"> | undefined> {
  const { page, events } = session;
  const flow = m.flow!;
  const scrub = sensitiveValues(flow);
  // Being on the sign-in page is expected until the flow's last manual (sign-in) step is behind us.
  const authGate = !flow.steps.slice(index).some((s) => s.action.type === "manual");
  const interruptions = () => checkInterruptions(page, flow, fs, events, { authGate });
  await interruptions();

  // A manual step whose expectations already hold (e.g. the saved profile is still signed in) needs nobody.
  const alreadyDone = fs.action.type === "manual" && fs.expect.length > 0 && (await waitForAssertions(page, fs.expect, 1500)).passed;
  if (fs.action.type === "manual" && !alreadyDone) {
    if (session.headless) {
      throw new WalkError(
        "MANUAL_TAKEOVER_REQUIRED",
        `Step "${fs.id}" needs a person: ${fs.action.instructions}`,
        "Run `walkthrough capture --headed` and complete the step in the browser window.",
        true,
      );
    }
    log(`>>> ${fs.action.instructions}  (waiting up to ${Math.round(fs.action.timeoutMs / 1000)}s)`);
    const done = await waitForAssertions(page, fs.expect, fs.action.timeoutMs);
    if (!done.passed) {
      throw new WalkError("MANUAL_TIMEOUT", `Step "${fs.id}" was not completed in time`, "Run capture again and finish the manual step.", true);
    }
  }

  let target: ResolvedTarget | undefined;
  const loc = "target" in fs.action ? fs.action.target : undefined;
  if (loc) {
    target = await findTarget(page, loc, fs.id, timeoutMs);
    await target.locator.scrollIntoViewIfNeeded();
    await waitForStable(page);
  }
  assertMutationAllowed(fs, target?.name);

  let shot: Awaited<ReturnType<typeof takeShot>> | undefined;
  if (doCapture && BEFORE_ACTION.has(fs.action.type)) shot = await takeShot(dir, page, m, scrub, target);

  if (fs.action.type === "goto") {
    const url = resolveUrl(resolveValue(fs.action.url, flow).value, page.url(), m.project.startUrl);
    if (!hostAllowed(url, flow.permittedDomains)) events.violations.push(scrubText(url, scrub));
    await interruptions();
  }
  // Recorded before acting: a mutating action that fails halfway may still have changed data.
  if (isMutating(fs, target?.name)) m.steps[index]!.actionExecutedAt = nowIso();
  let typed: Awaited<ReturnType<typeof performAction>>;
  try {
    typed = await performAction(page, fs.action, flow, target?.locator, m.project.startUrl);
  } catch (err) {
    // A navigation blocked by the allowlist (e.g. a redirect off-site) surfaces as a net error.
    await interruptions();
    throw err;
  }
  if (typed?.sensitive) scrub.push(typed.value);

  await waitForStable(page, 2500);
  await interruptions();
  const expectation = await waitForAssertions(page, fs.expect, timeoutMs);
  if (!expectation.passed) {
    await interruptions();
    throw new WalkError(
      fs.outcome ? "OUTCOME_UNVERIFIED" : "EXPECTATION_FAILED",
      `Step "${fs.id}": expected state not reached: ${JSON.stringify(expectation.failed)}`,
      fs.outcome
        ? "The tutorial's outcome could not be observed, so it will not be narrated. Check the site and the step's expect list."
        : "Check the page, then fix the step's action or expect list in flow.yaml.",
      true,
    );
  }
  if (!doCapture) return undefined;

  await waitForStable(page);
  const after = await takeShot(dir, page, m, scrub, shot ? undefined : target);
  const shown = shot ?? after;
  const snapshot = shown.snapshot;
  const record: Omit<Capture, "capturedAt"> = {
    actionHash: actionHash(fs),
    url: scrubText(page.url(), scrub),
    shot: shown.shot,
    after: shot ? after.shot : undefined,
    target: shown.target ? { ...shown.target, role: target?.role, name: target?.name } : undefined,
    labels: snapshotNames(snapshot),
    ariaSnapshot: await putArtifact(dir, snapshot, "aria.txt"),
    expectPassed: true,
    redactions: shown.redactions.map((r, j) => ({ ...r, id: `${fs.id}-r${j + 1}`, confirmed: r.confidence === "high" })),
    externalHosts: [...events.externalHosts],
  };
  events.externalHosts.clear();
  await writeEvidence(dir, fs, record, snapshot, scrub);
  return record;
}

async function takeShot(dir: string, page: Page, m: Manifest, scrub: string[], target?: ResolvedTarget) {
  const k = m.project.viewport.deviceScaleFactor;
  let cssRect: Rect | undefined;
  if (target) {
    const box = await target.locator.boundingBox();
    if (box) cssRect = { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  const shot = await redactedScreenshot(page, m.project, scrub);
  const ref = await putArtifact(dir, shot.png, "png");
  const snapshot = scrubText(await page.locator("body").ariaSnapshot().catch(() => ""), [...scrub, ...shot.scrub]);
  return {
    snapshot,
    shot: { artifact: ref, width: m.project.viewport.width * k, height: m.project.viewport.height * k },
    target: cssRect ? { cssRect, rect: scaleRect(cssRect, k) } : undefined,
    redactions: shot.redactions,
    scrub: shot.scrub,
  };
}

/** Bounds change on every recapture, so annotations and crop are always recomputed from the new evidence. */
function applyCapture(st: StepState, record: Omit<Capture, "capturedAt">, k: number, ordinal: number): StepState {
  const frame = { width: record.shot.width, height: record.shot.height };
  const annotations = record.target ? suggestAnnotations(record.target.rect, frame, ordinal, k) : [];
  const crop = annotations.length ? suggestCrop(unionRect(annotations.map((a) => a.rect)), frame) : null;
  return {
    ...st,
    status: "captured",
    capture: { ...record, capturedAt: nowIso() },
    annotations,
    crop,
  };
}

async function writeEvidence(dir: string, fs: FlowStep, rec: Omit<Capture, "capturedAt">, snapshot: string, scrub: string[]) {
  const p = paths(dir);
  // The action as authored: testData references stay as references, literal secrets are scrubbed.
  const action = JSON.parse(scrubText(JSON.stringify(fs.action), scrub));
  const evidence = {
    stepId: fs.id,
    title: fs.title,
    action,
    outcomeStep: fs.outcome,
    url: rec.url,
    expectPassed: rec.expectPassed,
    target: rec.target ? { role: rec.target.role, name: rec.target.name } : null,
    labels: rec.labels,
    screenshot: join(p.artifacts, rec.shot.artifact),
    afterScreenshot: rec.after ? join(p.artifacts, rec.after.artifact) : null,
    redactions: rec.redactions.map((r) => ({ id: r.id, reason: r.reason, confidence: r.confidence })),
    ariaSnapshot: snapshot,
  };
  await writeFileAtomic(join(p.evidence, fs.id, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
}

