/**
 * End-to-end acceptance scenarios against the fixture app: capture, failure pauses,
 * redaction, narration, render, partial regeneration and recovery.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { execa } from "execa";
import { chromium } from "playwright";
import sharp from "sharp";
import { profileDir } from "../src/capture/browser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capture } from "../src/capture/index.js";
import { init, plan } from "../src/project/plan.js";
import { annotate, approve, confirmRedactions, exportPackage } from "../src/project/review.js";
import type { Manifest } from "../src/project/schema.js";
import { loadManifest, paths } from "../src/project/store.js";
import { render } from "../src/render/index.js";
import { draftScript, setNarration } from "../src/script/draft.js";
import { narrate } from "../src/speech/narrate.js";
import { approveVoice, enrollVoice, testVoice } from "../src/speech/voice.js";
import { WalkError } from "../src/util.js";
import { startFixture } from "./fixture-app/server.js";

const ROOT = resolve("test/.tmp/vitest");
const PASSWORD = "Correct-Horse-42!";
const ACCOUNT = "DLR-48213-77";
let server: Server;
let base: string;

async function newProject(name: string, mode = "none", edit?: (flow: string) => string): Promise<string> {
  const dir = join(ROOT, `${name}.walkthrough`);
  await rm(dir, { recursive: true, force: true });
  await init(dir, {
    name: "Set up your dealer account",
    objective: "Accept a dealer invitation and set your password",
    audience: "new Northwind dealers",
    outcome: "Your dealer account is ready",
    startUrl: `${base}/invite`,
    resetCommand: "true",
    browserProfile: name,
    redaction: { selectors: ["[data-sensitive]"], allow: [], heuristics: true },
  });
  let flow = readFileSync("test/fixture-app/flow.yaml", "utf8").replaceAll("{{BASE}}", base).replaceAll("{{MODE}}", mode);
  if (edit) flow = edit(flow);
  await writeFile(join(dir, "flow.yaml"), flow);
  await plan(dir);
  return dir;
}

async function captureError(dir: string): Promise<WalkError> {
  try {
    await capture(dir, { timeoutMs: 2500 });
  } catch (e) {
    return e as WalkError;
  }
  throw new Error("capture unexpectedly succeeded");
}

const statuses = (m: Manifest) => m.steps.map((s) => s.status);

/** Pixels inside a masked box are the two hatch colours; anything bright means text leaked. */
async function maskedFraction(png: Buffer | string, r: { x: number; y: number; width: number; height: number }) {
  const inset = 6;
  const { data, info } = await sharp(png)
    .extract({ left: Math.round(r.x + inset), top: Math.round(r.y + inset), width: Math.round(r.width - 2 * inset), height: Math.round(r.height - 2 * inset) })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 150 || data[i + 1]! > 150 || data[i + 2]! > 150) bright++;
  return 1 - bright / (data.length / info.channels);
}

/** A project whose flow.yaml is given verbatim ({{BASE}} is replaced). */
async function customProject(name: string, flowYaml: string, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = join(ROOT, `${name}.walkthrough`);
  await rm(dir, { recursive: true, force: true });
  await init(dir, {
    name: "Custom",
    objective: "Exercise one behaviour",
    audience: "tests",
    outcome: "It works",
    startUrl: `${base}/invite`,
    browserProfile: name,
    redaction: { selectors: ["[data-sensitive]"], allow: [], heuristics: true },
    ...extra,
  });
  await writeFile(join(dir, "flow.yaml"), flowYaml.replaceAll("{{BASE}}", base));
  await plan(dir);
  return dir;
}

/** Pixels in the fixture's "secret" magenta; any left in a saved frame is leaked secret text. */
async function magentaPixels(png: string | Buffer): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 200 && data[i + 1]! < 90 && data[i + 2]! > 200) n++;
  return n;
}

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  process.env.WALKTHROUGH_HOME = join(ROOT, "home");
  // Stub sidecar: narration without loading a model; no aligner, so imports use proportional timing.
  const speech = join(ROOT, "speech");
  await mkdir(join(speech, ".venvs", "chatterbox", "bin"), { recursive: true });
  await symlink(resolve("test/stub-speech/python"), join(speech, ".venvs", "chatterbox", "bin", "python"));
  process.env.WALKTHROUGH_SPEECH_DIR = speech;
  ({ server, url: base } = await startFixture());
});

afterAll(() => {
  server?.close();
});

describe("capture", () => {
  let dir: string;
  let m: Manifest;
  beforeAll(async () => {
    dir = await newProject("happy");
    await capture(dir, { timeoutMs: 5000 });
    m = await loadManifest(dir);
  });

  it("captures one matching, redacted screenshot per step of the 8-step flow", async () => {
    expect(statuses(m)).toEqual(Array(8).fill("captured"));
    const names = ["Accept invitation", "Full name", "Dealer region", "Password", "Confirm password", "Create account", "Your account is ready"];
    expect(m.steps.slice(1).map((s) => s.capture?.target?.name)).toEqual(names);
    for (const s of m.steps) {
      const meta = await sharp(join(paths(dir).artifacts, s.capture!.shot.artifact)).metadata();
      expect([meta.width, meta.height]).toEqual([2560, 1440]);
    }
    expect(m.steps.at(-1)!.capture!.url).toMatch(/\/welcome$/);
  });

  it("drafts narration from labels that were actually observed", async () => {
    await draftScript(dir);
    const after = await loadManifest(dir);
    for (const s of after.steps) {
      for (const q of s.narration!.text.matchAll(/"([^"]+)"/g)) expect(s.capture!.labels).toContain(q[1]);
    }
    expect(after.steps[1]!.narration!.text).toBe('Click "Accept invitation".');
  });

  it("masks passwords and configured customer data in every saved frame, and keeps them out of evidence", async () => {
    for (const s of m.steps) {
      const png = join(paths(dir).artifacts, s.capture!.shot.artifact);
      for (const r of s.capture!.redactions.filter((x) => x.reason !== "heuristic")) {
        expect(await maskedFraction(png, r.rect)).toBeGreaterThan(0.99);
      }
    }
    expect(m.steps[0]!.capture!.redactions.map((r) => r.detail)).toContain("span#acct");
    expect(m.steps[5]!.capture!.redactions.filter((r) => r.reason === "password")).toHaveLength(2);
    const evidence = readdirSync(paths(dir).evidence).map((d) => readFileSync(join(paths(dir).evidence, d, "evidence.json"), "utf8")).join("\n");
    const aria = readdirSync(paths(dir).artifacts).filter((f) => f.endsWith(".txt")).map((f) => readFileSync(join(paths(dir).artifacts, f), "utf8")).join("\n");
    for (const secret of [PASSWORD, ACCOUNT]) {
      expect(evidence).not.toContain(secret);
      expect(aria).not.toContain(secret);
    }
  });

  it("keeps --json output parseable when the reset command prints", async () => {
    const copy = join(ROOT, "reset-json.walkthrough");
    await cp(dir, copy, { recursive: true });
    const pj = JSON.parse(await readFile(join(copy, "project.json"), "utf8"));
    pj.project.resetCommand = "echo RESET-NOISE-LINE && echo more noise";
    await writeFile(join(copy, "project.json"), JSON.stringify(pj));
    // Async: the fixture server lives in this process, so a sync spawn would starve it.
    const r = await execa("npx", ["tsx", "src/cli.ts", "capture", copy, "--step", "welcome", "--reset", "--json"], { env: process.env, reject: false });
    expect(r.stderr).toContain("RESET-NOISE-LINE");
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, status: "ok", command: "capture", data: { captured: ["welcome"] } });
  });

  it("refuses to replay a data-changing step without a reset", async () => {
    const err = await capture(dir, { stepId: "welcome" }).catch((e) => e as WalkError);
    expect(err).toBeInstanceOf(WalkError);
    expect((err as WalkError).code).toBe("REPLAY_REQUIRES_RESET");
    const r = await capture(dir, { stepId: "welcome", reset: true, timeoutMs: 5000 });
    expect(r).toMatchObject({ captured: ["welcome"], replayed: ["open-invite", "accept", "name", "region", "password", "confirm", "create"] });
  });
});

describe("capture pauses instead of fabricating", () => {
  it.each([
    ["renameButton", "LOCATOR_NOT_FOUND", /Join now/],
    ["expire", "AUTH_EXPIRED", /signed out/],
    ["modal", "UNEXPECTED_DIALOG", /Update available/],
  ])("%s → %s", async (mode, code, detail) => {
    const dir = await newProject(`fail-${mode}`, mode);
    const err = await captureError(dir);
    expect(err.code).toBe(code);
    expect(`${err.message} ${err.hint}`).toMatch(detail);
    expect(err.paused).toBe(true);
    const m = await loadManifest(dir);
    expect(statuses(m)).toEqual(["captured", "failed", ...Array(6).fill("planned")]);
    expect(m.checkpoint?.error?.code).toBe(code);
    expect(m.status).toBe("review_required");
  });

  it("stops at navigation outside the permitted domains", async () => {
    const dir = await newProject("fail-offsite", "none", (f) =>
      f.replace('{ type: click, target: { role: button, name: "Accept invitation" } }', '{ type: click, target: { role: link, name: "Read the dealer terms" } }'),
    );
    expect((await captureError(dir)).code).toBe("OFF_ALLOWLIST_NAVIGATION");
  });

  it.each([
    ["a direct goto", "https://example.com/terms"],
    ["a redirect", "/offsite"],
  ])("pauses (not fails) when %s leaves the permitted domains", async (_label, url) => {
    const dir = await customProject(`offsite-${url.length}`, `permittedDomains: ["127.0.0.1"]
steps:
  - id: start
    title: Start
    action: { type: goto, url: "/invite?fixture=none" }
  - id: leave
    title: Leave
    action: { type: goto, url: "${url}" }
`);
    const err = await captureError(dir);
    expect(err.code).toBe("OFF_ALLOWLIST_NAVIGATION");
    expect(err.paused).toBe(true);
    expect(err.message).toContain("example.com");
  });

  it("pauses before a data-changing action that is not allowed", async () => {
    const dir = await newProject("fail-mutating", "none", (f) => f.replace("allow: true", "allow: false"));
    expect((await captureError(dir)).code).toBe("MUTATING_ACTION_NOT_ALLOWED");
    const m = await loadManifest(dir);
    expect(m.steps.find((s) => s.id === "create")!.actionExecutedAt).toBeUndefined();
    expect(m.steps.find((s) => s.id === "welcome")!.status).toBe("planned");
  });
});

describe("sign-in flows", () => {
  const authFlow = `permittedDomains: ["127.0.0.1"]
signedOutWhen:
  - url: "/login"
steps:
  - id: open-app
    title: Open the app
    action: { type: goto, url: "/app" }
  - id: sign-in
    title: Sign in
    action: { type: manual, instructions: "Click Sign in" }
    expect: [{ visible: { role: heading, name: "Dashboard" } }]
  - id: dashboard
    title: See the dashboard
    action: { type: observe, target: { role: heading, name: "Dashboard" } }
  - id: sign-out
    title: Sign out
    action: { type: click, target: { role: link, name: "Sign out" } }
    expect: [{ url: "/app" }]
`;

  it("reaches the sign-in step instead of reporting an expired session, then resumes once signed in", async () => {
    const dir = await customProject("auth", authFlow);
    // Landing on /login before the manual step is expected; headless, the person can't act yet.
    const first = await captureError(dir);
    expect(first.code).toBe("MANUAL_TAKEOVER_REQUIRED");
    expect((await loadManifest(dir)).steps[0]!.status).toBe("captured");

    // The person signs in once; the saved profile keeps the session.
    const ctx = await chromium.launchPersistentContext(profileDir("auth"), { channel: "chrome", headless: true });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Dashboard" }).waitFor();
    await ctx.close();

    // Now the manual step is already satisfied, and after it the signed-out check is live again.
    const second = await captureError(dir);
    expect(second.code).toBe("AUTH_EXPIRED");
    const m = await loadManifest(dir);
    expect(m.steps.map((s) => s.status)).toEqual(["captured", "captured", "captured", "failed"]);
  });
});

describe("masking edge cases", () => {
  const secretsFlow = `permittedDomains: ["127.0.0.1"]
steps:
  - id: open
    title: Open developer settings
    action: { type: goto, url: "/secrets" }
    expect: [{ text: "Developer settings" }]
`;

  it("masks shadow-DOM fields, every token in a text node, a cross-origin iframe and an animated toast", async () => {
    const dir = await customProject("secrets", secretsFlow);
    await capture(dir, { timeoutMs: 5000 });
    const cap = (await loadManifest(dir)).steps[0]!.capture!;
    expect(await magentaPixels(join(paths(dir).artifacts, cap.shot.artifact))).toBe(0);
    expect(cap.redactions.filter((r) => r.detail === "token-like text")).toHaveLength(3);
    expect(cap.redactions.map((r) => r.reason)).toEqual(expect.arrayContaining(["password", "selector"]));
    const evidence = readFileSync(join(paths(dir).evidence, "open", "evidence.json"), "utf8");
    for (const secret of ["sk_live_4f9a8b7c6d5e4f3a", "sk_test_9z8y7x6w5v4u3t2s", "hunter2hunter2", "CUST-77120"]) expect(evidence).not.toContain(secret);
  });

  it("control: without heuristics the same page leaks, so the check above is meaningful", async () => {
    const dir = await customProject("secrets-control", secretsFlow, { redaction: { selectors: [], allow: [], heuristics: false } });
    await capture(dir, { timeoutMs: 5000 });
    const cap = (await loadManifest(dir)).steps[0]!.capture!;
    expect(await magentaPixels(join(paths(dir).artifacts, cap.shot.artifact))).toBeGreaterThan(500);
  });
});

describe("narration, render and partial regeneration", () => {
  let dir: string;
  let recordings: string;
  let firstRender: Awaited<ReturnType<typeof render>>;

  async function approveAll() {
    await approve(dir, "storyboard");
    await approve(dir, "script");
    await approve(dir, "visuals");
  }

  beforeAll(async () => {
    dir = join(ROOT, "render.walkthrough");
    await cp(join(ROOT, "happy.walkthrough"), dir, { recursive: true });
    await setNarration(dir, { "open-invite": "Your invitation opens this page. It shows who invited you." }, "agent");
    recordings = join(ROOT, "recordings");
    await mkdir(recordings, { recursive: true });
    const m = await loadManifest(dir);
    for (const s of m.steps) execFileSync("say", ["-v", "Samantha", "-o", join(recordings, `${s.id}.aiff`), s.narration!.text]);
  });

  it("imports personal recordings and renders a validated 1080p H.264/AAC export", async () => {
    const n = await narrate(dir, { dir: recordings });
    expect(n.generated).toHaveLength(8);
    await confirmRedactions(dir, "all");
    await approveAll();
    firstRender = await render(dir);
    expect(firstRender.preview).toBe(false);
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", firstRender.video]).toString());
    const v = info.streams.find((s: any) => s.codec_type === "video");
    const a = info.streams.find((s: any) => s.codec_type === "audio");
    expect([v.codec_name, v.width, v.height, a.codec_name]).toEqual(["h264", 1920, 1080, "aac"]);
    expect(Math.abs(Number(info.format.duration) * 1000 - firstRender.totalMs)).toBeLessThan(100);
    const vtt = readFileSync(join(firstRender.dir, "captions.vtt"), "utf8");
    expect(vtt).toContain('Click "Accept invitation".');
    const latest = JSON.parse(readFileSync(join(paths(dir).exports, "latest.json"), "utf8"));
    expect(latest.id).toBe(firstRender.id);
    expect((await loadManifest(dir)).status).toBe("complete");
  });

  it("keeps passwords unreadable in rendered frames", async () => {
    const m = await loadManifest(dir);
    const job = JSON.parse(readFileSync(join(firstRender.dir, "render-job.json"), "utf8"));
    const step = m.steps.find((s) => s.id === "confirm")!;
    const scene = job.scenes.find((s: any) => s.id === "confirm");
    const t = (scene.startMs + scene.durationMs - 400) / 1000;
    const frame = execFileSync("ffmpeg", ["-loglevel", "error", "-ss", String(t), "-i", firstRender.video, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
    const crop = step.crop ?? { x: 0, y: 0, width: 2560, height: 1440 };
    const k = 1920 / crop.width;
    for (const r of step.capture!.redactions.filter((x) => x.reason === "password")) {
      const mapped = { x: (r.rect.x - crop.x) * k, y: (r.rect.y - crop.y) * k, width: r.rect.width * k, height: r.rect.height * k };
      expect(await maskedFraction(frame, mapped)).toBeGreaterThan(0.97);
    }
  });

  it("a moved highlight and one edited line regenerate only that scene and that clip", async () => {
    const before = await loadManifest(dir);
    await annotate(dir, "accept", { move: { id: "callout", dx: -30, dy: 0 } });
    await setNarration(dir, { name: "Type your full name, for example Avery Dealer." }, "human");
    let m = await loadManifest(dir);
    expect(m.steps.find((s) => s.id === "name")!.clip!.scriptHash).toBe(before.steps.find((s) => s.id === "name")!.clip!.scriptHash);
    execFileSync("say", ["-v", "Samantha", "-o", join(recordings, "name.aiff"), "Type your full name, for example Avery Dealer."]);
    const n = await narrate(dir, { dir: recordings });
    expect(n.generated).toEqual(["name"]);
    m = await loadManifest(dir);
    for (const s of m.steps) {
      const prev = before.steps.find((x) => x.id === s.id)!;
      if (s.id === "name") expect(s.clip!.artifact).not.toBe(prev.clip!.artifact);
      else expect(s.clip!.artifact).toBe(prev.clip!.artifact);
      expect(s.capture!.shot.artifact).toBe(prev.capture!.shot.artifact);
    }
    await expect(render(dir)).rejects.toMatchObject({ code: "RENDER_BLOCKED" });
    await approveAll();
    const second = await render(dir);
    const job = JSON.parse(readFileSync(join(second.dir, "render-job.json"), "utf8"));
    const rerendered = job.scenes.filter((s: any) => !s.cached).map((s: any) => s.id);
    expect(rerendered.sort()).toEqual(["accept", "name"]);
  });

  it("a failed encoder leaves the previous export intact, and the retry reuses cached scenes", async () => {
    const latestBefore = readFileSync(join(paths(dir).exports, "latest.json"), "utf8");
    await annotate(dir, "region", { crop: "none" });
    await approve(dir, "storyboard");
    await approve(dir, "visuals");
    const failing = join(ROOT, "ffmpeg-fails-on-assembly");
    await writeFile(failing, `#!/bin/sh\ncase "$*" in *xfade*) echo "simulated encoder crash" >&2; exit 1;; esac\nexec ffmpeg "$@"\n`);
    await chmod(failing, 0o755);
    process.env.WALKTHROUGH_FFMPEG = failing;
    try {
      await expect(render(dir)).rejects.toMatchObject({ code: "FFMPEG_FAILED" });
    } finally {
      delete process.env.WALKTHROUGH_FFMPEG;
    }
    expect(readFileSync(join(paths(dir).exports, "latest.json"), "utf8")).toBe(latestBefore);
    expect(existsSync(join(paths(dir).root, JSON.parse(latestBefore).dir, "walkthrough.mp4"))).toBe(true);
    const m = await loadManifest(dir);
    expect(m.status).toBe("failed");
    const retry = await render(dir);
    expect(retry.cachedScenes).toBe(retry.scenes);
    expect(JSON.parse(readFileSync(join(paths(dir).exports, "latest.json"), "utf8")).id).toBe(retry.id);
  });

  it("normalises custom crops and rejects ones outside the frame", async () => {
    await expect(annotate(dir, "region", { crop: { x: 2000, y: 0, width: 1000, height: 600 } })).rejects.toMatchObject({ code: "CROP_OUT_OF_FRAME" });
    const r = await annotate(dir, "region", { crop: { x: 400, y: 400, width: 1400, height: 300 } });
    expect(r.crop!.width / r.crop!.height).toBeCloseTo(16 / 9, 2);
    // Tighter than the legibility floor is allowed with a warning; nothing may block the render.
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("exports a package without browser state, voice data or secrets", async () => {
    // Edits after the last validated render must not leak into the package.
    const renderedRevision = JSON.parse(readFileSync(join(paths(dir).root, JSON.parse(readFileSync(join(paths(dir).exports, "latest.json"), "utf8")).dir, "render-job.json"), "utf8")).revision;
    await setNarration(dir, { welcome: "Unreviewed edit made after the render." }, "human");
    const { package: pkg, revision } = await exportPackage(dir);
    expect(revision).toBe(renderedRevision);
    const listing = execFileSync("tar", ["-tzf", pkg]).toString();
    expect(listing).toMatch(/render\/walkthrough\.mp4/);
    expect(listing).not.toMatch(/revisions|evidence|profiles|voices|cache/);
    const manifest = execFileSync("tar", ["-xzOf", pkg, listing.split("\n").find((l) => l.endsWith("/project.json"))!]).toString();
    expect(manifest).not.toContain(PASSWORD);
    expect(manifest).not.toContain("Unreviewed edit");
    const parsed = JSON.parse(manifest);
    expect(parsed.revision).toBe(renderedRevision);
    expect(parsed.checkpoint).toBeUndefined();
    expect(parsed.steps.every((s: any) => !s.capture.url.includes("?"))).toBe(true);
  });
});

describe("synthesized narration (stub engine)", () => {
  it("resumes after the speech process dies mid-run, keeping finished clips", async () => {
    const dir = join(ROOT, "synth.walkthrough");
    await cp(join(ROOT, "happy.walkthrough"), dir, { recursive: true });
    const ref = join(ROOT, "ref.aiff");
    execFileSync("say", ["-v", "Samantha", "-o", ref, "This is a reference recording of my own voice, spoken clearly for about ten seconds or so."]);
    await enrollVoice({ id: "creator", name: "Creator", file: ref, confirmOwnVoice: true, transcript: "reference" });
    await testVoice("creator", "chatterbox", {});
    await approveVoice("creator", "chatterbox");
    const m = await loadManifest(dir);
    m.project.voice = { engine: "chatterbox", profileId: "creator", settings: {} };
    await writeFile(join(dir, "project.json"), JSON.stringify(m, null, 2));

    process.env.STUB_CRASH_ON = "4";
    try {
      await expect(narrate(dir)).rejects.toMatchObject({ code: "SPEECH_PROCESS_EXITED" });
    } finally {
      delete process.env.STUB_CRASH_ON;
    }
    const partial = await loadManifest(dir);
    expect(partial.steps.filter((s) => s.clip).map((s) => s.id)).toEqual(["open-invite", "accept", "name"]);
    const resumed = await narrate(dir);
    expect(resumed.generated).toEqual(["region", "password", "confirm", "create", "welcome"]);
    const done = await loadManifest(dir);
    expect(done.steps.every((s) => s.clip?.timing === "synthesis" && s.clip.voiceProfile?.id === "creator")).toBe(true);
  });

  it("a rejected re-enrolment leaves the approved reference untouched", async () => {
    const { loadVoice } = await import("../src/speech/voice.js");
    const before = await loadVoice("creator");
    const bytes = readFileSync(before.reference.file);
    const short = join(ROOT, "short.aiff");
    execFileSync("say", ["-v", "Samantha", "-o", short, "Too short."]);
    await expect(enrollVoice({ id: "creator", name: "Creator", file: short, confirmOwnVoice: true, transcript: "x" })).rejects.toMatchObject({ code: "REFERENCE_TOO_SHORT" });
    const after = await loadVoice("creator");
    expect(after).toEqual(before);
    expect(readFileSync(after.reference.file).equals(bytes)).toBe(true);
    expect(readdirSync(join(ROOT, "home", "voices", "creator")).filter((f) => f.includes("pending"))).toEqual([]);
  });

  it("refuses enrolment without ownership confirmation", async () => {
    await expect(enrollVoice({ id: "someone", name: "x", file: "/dev/null", confirmOwnVoice: false })).rejects.toMatchObject({ code: "OWNERSHIP_NOT_CONFIRMED" });
  });
});

