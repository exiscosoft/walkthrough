import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCrop, placeBadge, suggestAnnotations, suggestCrop, MIN_CROP_FRACTION } from "../src/annotate/suggest.js";
import { hostAllowed, isMutating } from "../src/capture/guards.js";
import { resolveUrl, snapshotNames } from "../src/capture/actions.js";
import { replayBlockers } from "../src/capture/index.js";
import { scrubText } from "../src/capture/redact.js";
import { actionHash, applyFlow, clipState, scriptHash, spokenText } from "../src/project/invalidate.js";
import { FlowSchema, ManifestSchema, ProjectConfigSchema, type Manifest } from "../src/project/schema.js";
import { alignScript, cuesFor, proportionalSegments, sentencesFromWords, toSrt, wordErrorRate, words } from "../src/render/captions.js";
import { buildTimeline, FPS } from "../src/render/timeline.js";
import { checkGrounding } from "../src/script/grounding.js";
import { contains, intersects, splitSentences, WalkError } from "../src/util.js";
import { validateProject } from "../src/validate/index.js";

const project = ProjectConfigSchema.parse({
  name: "Demo",
  objective: "Do the thing",
  audience: "dealers",
  outcome: "The account is ready",
  startUrl: "http://127.0.0.1:4310/invite",
});

const flow = FlowSchema.parse({
  permittedDomains: ["127.0.0.1"],
  steps: [
    { id: "open", title: "Open", action: { type: "goto", url: "/invite" } },
    { id: "accept", title: "Accept", action: { type: "click", target: { role: "button", name: "Accept invitation" } } },
    { id: "done", title: "Done", action: { type: "observe" }, outcome: true, expect: [{ text: "ready" }] },
  ],
});

function captured(m: Manifest): Manifest {
  m.steps = m.steps.map((s, i) => ({
    ...s,
    status: "captured",
    capture: {
      capturedAt: "t",
      actionHash: actionHash(flow.steps[i]!),
      url: "u",
      shot: { artifact: `${s.id}.png`, width: 2560, height: 1440 },
      labels: ["Accept invitation", "Your account is ready"],
      ariaSnapshot: "a.txt",
      expectPassed: true,
      redactions: [],
      externalHosts: [],
    },
  }));
  return m;
}

function manifest(): Manifest {
  const m = ManifestSchema.parse({ schemaVersion: 1, revision: 3, status: "planned", project, flow });
  m.steps = applyFlow(m, flow).steps;
  return captured(m);
}

describe("invalidation", () => {
  it("narration edits stale only that step's clip", () => {
    const m = manifest();
    m.steps = m.steps.map((s) => ({
      ...s,
      narration: { text: `Say ${s.id}.`, source: "human", updatedAt: "t" },
      clip: { stepId: s.id, scriptHash: scriptHash(`Say ${s.id}.`, project), engine: "chatterbox", engineInfo: {}, artifact: "x.wav", durationMs: 1000, segments: [], timing: "synthesis", approved: false, createdAt: "t" },
    }));
    expect(m.steps.map((s) => clipState(s, project))).toEqual(["current", "current", "current"]);
    m.steps[1]!.narration!.text = "Click it.";
    expect(m.steps.map((s) => clipState(s, project))).toEqual(["current", "stale", "current"]);
  });

  it("pronunciation changes speech but invalidates audio, never the visible text", () => {
    const p2 = { ...project, pronunciation: { SSO: "S S O" } };
    expect(spokenText("Turn on SSO, not SSOs.", p2.pronunciation)).toBe("Turn on S S O, not SSOs.");
    expect(scriptHash("Turn on SSO.", project)).not.toBe(scriptHash("Turn on SSO.", p2));
  });

  it("an action change marks that step and every later captured step for validation", () => {
    const m = manifest();
    const changed = FlowSchema.parse({ ...flow, steps: flow.steps.map((s) => (s.id === "accept" ? { ...s, action: { type: "click", target: { role: "button", name: "Join now" } } } : s)) });
    const { steps, invalidated } = applyFlow(m, changed);
    expect(invalidated).toEqual(["accept", "done"]);
    expect(steps.map((s) => s.status)).toEqual(["captured", "needs_validation", "needs_validation"]);
  });

  it("an unchanged replan keeps every capture", () => {
    expect(applyFlow(manifest(), flow).invalidated).toEqual([]);
  });
});

describe("annotations and crop", () => {
  const frame = { width: 2560, height: 1440 };
  it("crop always contains the target and respects the legibility floor", () => {
    for (const target of [
      { x: 10, y: 10, width: 200, height: 60 },
      { x: 2300, y: 1350, width: 240, height: 80 },
      { x: 900, y: 600, width: 400, height: 90 },
      { x: 700, y: 400, width: 1100, height: 120 },
    ]) {
      const crop = suggestCrop(target, frame);
      if (!crop) continue;
      expect(contains(crop, target)).toBe(true);
      expect(crop.width).toBeGreaterThanOrEqual(frame.width * MIN_CROP_FRACTION - 1);
      expect(crop.x + crop.width).toBeLessThanOrEqual(frame.width);
      expect(Math.abs(crop.width / crop.height - frame.width / frame.height)).toBeLessThan(0.01);
    }
  });

  it("badges never cover the target, even in corners", () => {
    for (const target of [{ x: 0, y: 0, width: 300, height: 60 }, { x: 2400, y: 1380, width: 160, height: 60 }, { x: 1000, y: 700, width: 500, height: 80 }]) {
      const anns = suggestAnnotations(target, frame, 1, 2);
      const badge = anns.find((a) => a.kind === "callout")!;
      expect(intersects(badge.rect, target)).toBe(false);
      expect(contains(anns.find((a) => a.kind === "outline")!.rect, target)).toBe(true);
    }
    expect(placeBadge({ x: 100, y: 100, width: 50, height: 50 }, { x: 84, y: 84, width: 82, height: 82 }, frame, 60)).toBeDefined();
  });
});

describe("guards", () => {
  it("matches permitted hosts, ports and wildcards", () => {
    expect(hostAllowed("http://127.0.0.1:4310/x", ["127.0.0.1"])).toBe(true);
    expect(hostAllowed("http://127.0.0.1:4310/x", ["127.0.0.1:9999"])).toBe(false);
    expect(hostAllowed("https://app.demo.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("https://example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("https://evil-example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("https://example.com/terms", ["127.0.0.1"])).toBe(false);
    expect(hostAllowed("about:blank", [])).toBe(true);
  });

  it("treats destructive or outbound clicks as mutating even when undeclared", () => {
    const step = (name: string) => FlowSchema.parse({ permittedDomains: ["x"], steps: [{ id: "s", title: "s", action: { type: "click", target: { role: "button", name } } }] }).steps[0]!;
    expect(isMutating(step("Delete dealer"))).toBe(true);
    expect(isMutating(step("Send invitation"))).toBe(true);
    expect(isMutating(step("Accept invitation"))).toBe(false);
    expect(isMutating(step("Next"), "Purchase plan")).toBe(true);
  });

  it("scrubs sensitive values from evidence text, longest first", () => {
    expect(scrubText('textbox "Password": hunter2hunter2', ["hunter2hunter2", "hunter2"])).toBe('textbox "Password": [redacted]');
  });

  it("extracts names from aria snapshots", () => {
    const snap = '- heading "You\'re invited" [level=1]\n- button "Accept invitation"\n- textbox "Full name"\n- paragraph: Jordan invited you.';
    expect(snapshotNames(snap)).toEqual(expect.arrayContaining(["You're invited", "Accept invitation", "Full name", "Jordan invited you."]));
  });
});

describe("captions", () => {
  it("aligns script words to ASR timings and interpolates misses", () => {
    const asr = [
      { word: "Click", startMs: 0, endMs: 300 },
      { word: "accept", startMs: 320, endMs: 700 },
      { word: "invitation.", startMs: 720, endMs: 1300 },
      { word: "Then", startMs: 1700, endMs: 1900 },
      { word: "continue.", startMs: 1950, endMs: 2500 },
    ];
    const text = 'Click "Accept invitation". Then continue.';
    const segs = sentencesFromWords(text, alignScript(text, asr, 2600));
    expect(segs).toEqual([
      { text: 'Click "Accept invitation".', startMs: 0, endMs: 1300 },
      { text: "Then continue.", startMs: 1700, endMs: 2500 },
    ]);
  });

  it("computes WER over normalised words", () => {
    expect(wordErrorRate("Click Accept invitation.", "click accept invitation")).toBe(0);
    expect(wordErrorRate("Set up SSO now", "set up a so now")).toBeCloseTo(0.5);
  });

  it("splits long sentences into two-line cues inside the segment", () => {
    const seg = { text: "Paste the Entity ID into the Audience URI field, and the ACS URL into the Single sign-on URL field of your identity provider.", startMs: 1000, endMs: 7000 };
    const cues = cuesFor(seg, 500);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.startMs).toBe(1500);
    expect(cues.at(-1)!.endMs).toBe(7500);
    for (const c of cues) expect(c.text.split("\n").every((l) => l.length <= 50)).toBe(true);
    expect(toSrt(cues)).toMatch(/^1\n00:00:01,500 --> /);
  });

  it("proportional fallback covers the clip", () => {
    const s = proportionalSegments("One. Two three four.", 2000);
    expect(s[0]!.startMs).toBe(0);
    expect(s.at(-1)!.endMs).toBe(2000);
  });
});

describe("timeline", () => {
  it("scene length is lead-in + measured audio + pause, on the frame grid", () => {
    const m = manifest();
    m.steps[1]!.clip = { stepId: "accept", scriptHash: "h", engine: "import", engineInfo: {}, artifact: "a.wav", durationMs: 2345, segments: [], timing: "aligned", approved: false, createdAt: "t" };
    const tl = buildTimeline(m);
    const accept = tl.scenes.find((s) => s.id === "accept")!;
    expect(accept.durationMs).toBeGreaterThanOrEqual(project.timing.leadInMs + 2345 + project.timing.pauseMs);
    for (const s of tl.scenes) expect(Number.isInteger(Math.round((s.durationMs * FPS) / 1000 * 1000) / 1000)).toBe(true);
    const last = tl.scenes.at(-1)!;
    expect(tl.totalMs).toBeCloseTo(last.startMs + last.durationMs, 6);
  });
});

describe("grounding", () => {
  it("rejects narration of unobserved steps and premature outcome claims", () => {
    const m = manifest();
    m.steps[0]!.narration = { text: "Your account is ready.", source: "agent", updatedAt: "t" };
    m.steps[1]!.status = "planned";
    m.steps[1]!.narration = { text: 'Click "Accept invitation".', source: "agent", updatedAt: "t" };
    m.steps[2]!.narration = { text: 'You are done. Press "Finish".', source: "agent", updatedAt: "t" };
    const issues = checkGrounding(flow.steps, m.steps);
    expect(issues.find((i) => i.step === "open")?.severity).toBe("error");
    expect(issues.find((i) => i.step === "accept")?.message).toMatch(/not been observed/);
    expect(issues.find((i) => i.step === "done" && i.severity === "error")).toBeUndefined();
    expect(issues.find((i) => i.step === "done")?.message).toMatch(/"Finish" is not a label/);
  });
});

describe("sentence splitting", () => {
  it("keeps domains, prices, versions and abbreviations inside one sentence", () => {
    expect(splitSentences('Open acme.com in your browser. The plan costs $9.99 per month, e.g. for teams. Install v2.4.1, then click "Save".')).toEqual([
      "Open acme.com in your browser.",
      "The plan costs $9.99 per month, e.g. for teams.",
      'Install v2.4.1, then click "Save".',
    ]);
    expect(splitSentences('Click "No." Then wait! Done?')).toEqual(['Click "No."', "Then wait!", "Done?"]);
    expect(splitSentences("No terminal punctuation")).toEqual(["No terminal punctuation"]);
  });

  it("keeps caption timing aligned for text with dots inside words", () => {
    const text = "Open acme.com in your browser. The plan costs $9.99 per month. Then click Save.";
    const asr = words(text).map((w, i) => ({ word: w, startMs: i * 300, endMs: i * 300 + 250 }));
    const segs = sentencesFromWords(text, alignScript(text, asr, 5000));
    expect(segs.map((s) => s.text)).toEqual(splitSentences(text));
    expect(segs.at(-1)).toEqual({ text: "Then click Save.", startMs: 11 * 300, endMs: 13 * 300 + 250 });
  });

  const py = resolve("speech/.venvs/align/bin/python");
  it.skipIf(!existsSync(py))("matches the Python sidecar's splitter exactly", () => {
    const samples = [
      'Open acme.com in your browser. The plan costs $9.99 per month, e.g. for teams. Install v2.4.1, then click "Save".',
      'Click "No." Then wait! Done? Trailing words',
      "Mr. Smith opens app.example.io (v1.2). It works.",
    ];
    for (const text of samples) {
      const out = execFileSync(py, ["-c", "import sys,json; from walkthrough_speech.audio import split_sentences; print(json.dumps(split_sentences(sys.argv[1])))", text], { cwd: resolve("speech") });
      expect(JSON.parse(out.toString())).toEqual(splitSentences(text));
    }
  });
});

describe("flow validation and replanning", () => {
  it("rejects a manual step without an expect list", () => {
    const r = FlowSchema.safeParse({ permittedDomains: ["x"], steps: [{ id: "login", title: "Sign in", action: { type: "manual", instructions: "Sign in" } }] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["steps", 0, "expect"]);
  });

  it("invalidates later captures when a step is removed or steps are reordered", () => {
    const three = FlowSchema.parse({
      permittedDomains: ["x"],
      steps: ["a", "b", "c", "d"].map((id) => ({ id, title: id, action: { type: "observe" } })),
    });
    const base = (): Manifest => {
      const m = ManifestSchema.parse({ schemaVersion: 1, revision: 1, status: "planned", project, flow: three });
      m.steps = applyFlow(m, three).steps.map((s, i) => ({ ...s, status: "captured", capture: { ...captured(manifest()).steps[0]!.capture!, actionHash: actionHash(three.steps[i]!) } }));
      return m;
    };
    const removed = FlowSchema.parse({ ...three, steps: three.steps.filter((s) => s.id !== "b") });
    expect(applyFlow(base(), removed).invalidated).toEqual(["c", "d"]);
    const swapped = FlowSchema.parse({ ...three, steps: [three.steps[0], three.steps[2], three.steps[1], three.steps[3]] });
    expect(applyFlow(base(), swapped).invalidated).toEqual(["c", "b", "d"]);
    const lastRemoved = FlowSchema.parse({ ...three, steps: three.steps.slice(0, 3) });
    expect(applyFlow(base(), lastRemoved).invalidated).toEqual([]);
  });

  it("applies narration edited in flow.yaml, without clobbering later human edits", () => {
    const withText = (t: string) => FlowSchema.parse({ ...flow, steps: flow.steps.map((s) => (s.id === "accept" ? { ...s, narration: t } : s)) });
    const m = manifest();
    const v1 = withText("Click Accept.");
    let r = applyFlow(m, v1);
    expect(r.steps[1]!.narration).toMatchObject({ text: "Click Accept.", source: "flow" });
    m.steps = r.steps;
    m.flow = v1;
    // Re-planning the same flow keeps a human edit…
    m.steps[1]!.narration = { text: "Press the Accept button.", source: "human", updatedAt: "t" };
    r = applyFlow(m, v1);
    expect(r.steps[1]!.narration!.text).toBe("Press the Accept button.");
    expect(r.narrationUpdated).toEqual([]);
    // …but a change to the flow's own narration is the newer intent and wins.
    r = applyFlow(m, withText('Click "Accept invitation".'));
    expect(r.steps[1]!.narration).toMatchObject({ text: 'Click "Accept invitation".', source: "flow" });
    expect(r.narrationUpdated).toEqual(["accept"]);
  });

  it("blocks replay of any step whose action ran, including clicks that were mutating only by label", () => {
    const steps = FlowSchema.parse({
      permittedDomains: ["x"],
      steps: [
        { id: "remove", title: "Remove", action: { type: "click", target: { testId: "remove-dealer" } }, allow: true },
        { id: "again", title: "Again", action: { type: "click", target: { testId: "refresh" } }, idempotent: true },
        { id: "next", title: "Next", action: { type: "observe" } },
      ],
    }).steps;
    const states = steps.map((s) => ({ id: s.id, status: "captured" as const, annotations: [], actionExecutedAt: s.id === "next" ? undefined : "t" }));
    expect(replayBlockers(steps, states, 2).map((s) => s.id)).toEqual(["remove"]);
    expect(replayBlockers(steps, states, -1)).toEqual([]);
  });

  it("resolves a relative first goto against the start URL", () => {
    expect(resolveUrl("/invite?x=1", "about:blank", "http://127.0.0.1:4310/start")).toBe("http://127.0.0.1:4310/invite?x=1");
    expect(resolveUrl("next", "http://h/a/b", "http://other/")).toBe("http://h/a/next");
  });
});

describe("crops", () => {
  const frame = { width: 2560, height: 1440 };
  it("grows a requested crop to 16:9 without cutting any of it", () => {
    const want = { x: 200, y: 300, width: 1000, height: 300 };
    const c = normalizeCrop(want, frame)!;
    expect(contains(c, want)).toBe(true);
    expect(c.width / c.height).toBeCloseTo(16 / 9, 2);
    const tall = { x: 100, y: 100, width: 400, height: 900 };
    const t = normalizeCrop(tall, frame)!;
    expect(contains(t, tall)).toBe(true);
    expect(t.width / t.height).toBeCloseTo(16 / 9, 2);
  });

  it("treats a full-width band as the full frame and rejects crops outside the frame", () => {
    expect(normalizeCrop({ x: 0, y: 0, width: 2560, height: 600 }, frame)).toBeNull();
    expect(() => normalizeCrop({ x: 2000, y: 0, width: 1000, height: 600 }, frame)).toThrow(/outside/);
    expect(() => normalizeCrop({ x: -5, y: 0, width: 1000, height: 600 }, frame)).toThrow(WalkError);
  });

  it("validation reports crops that are off-frame or not 16:9", () => {
    const m = manifest();
    m.steps[1]!.crop = { x: 2000, y: 0, width: 1000, height: 600 };
    m.steps[2]!.crop = { x: 0, y: 0, width: 2560, height: 600 };
    const codes = validateProject("/nonexistent", m).filter((i) => i.step).map((i) => `${i.step}:${i.code}`);
    expect(codes).toContain("accept:CROP_OUT_OF_FRAME");
    expect(codes).toContain("done:CROP_ASPECT");
  });
});

describe("narration checks", () => {
  it("does not treat instructions as outcome claims", () => {
    const m = manifest();
    m.steps[0]!.narration = { text: "Complete the form, and you can now choose a region.", source: "agent", updatedAt: "t" };
    m.steps[1]!.narration = { text: "Your account has been created.", source: "agent", updatedAt: "t" };
    const issues = checkGrounding(flow.steps, m.steps).filter((i) => i.severity === "error");
    expect(issues.map((i) => i.step)).toEqual(["accept"]);
  });

  it("clip hashes change when the reference recording changes, even at the same version", () => {
    const profile = { id: "me", version: 1, reference: { file: "r.wav", sha256: "aaa", durationMs: 9000 } };
    expect(scriptHash("Hi.", project, profile)).not.toBe(scriptHash("Hi.", project, { ...profile, reference: { ...profile.reference, sha256: "bbb" } }));
  });
});
