import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { openSession } from "../capture/browser.js";
import { hostAllowed } from "../capture/guards.js";
import { redactedScreenshot, scrubText } from "../capture/redact.js";
import { waitForStable } from "../capture/stability.js";
import { applyFlow, deriveStatus } from "./invalidate.js";
import { FlowSchema, ProjectConfigSchema, type Flow, type ProjectConfig } from "./schema.js";
import { ensureDirs, loadManifest, newManifest, paths, putArtifact, saveManifest } from "./store.js";
import { WalkError, writeFileAtomic } from "../util.js";
import { profileFor } from "../speech/voice.js";

export async function init(dir: string, input: Partial<ProjectConfig> & Record<string, unknown>) {
  const p = paths(dir);
  if (existsSync(p.manifest)) throw new WalkError("PROJECT_EXISTS", `${p.manifest} already exists`);
  const parsed = ProjectConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new WalkError("PROJECT_INCOMPLETE", `Project setup is incomplete: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  }
  await ensureDirs(dir);
  const m = await saveManifest(dir, newManifest(parsed.data), "init");
  if (!existsSync(p.flow)) await writeFile(p.flow, flowTemplate(parsed.data));
  return { project: p.root, revision: m.revision, flowTemplate: p.flow };
}

function flowTemplate(project: ProjectConfig): string {
  const host = new URL(project.startUrl).host;
  return `# Flow for: ${project.objective}
# Each step: id, title, action, expect. Mark data-changing steps sideEffect: mutating
# and set allow: true only when the change is safe on demo data.
prerequisites: []
permittedDomains: ["${host}"]
testData: {}
#  password: { env: DEMO_PASSWORD, sensitive: true }
signedOutWhen: []
#  - url: "/login"
steps:
  - id: open
    title: Open the start page
    action: { type: goto, url: "${project.startUrl}" }
    expect: []
`;
}

export async function readFlowFile(dir: string): Promise<Flow> {
  const file = paths(dir).flow;
  if (!existsSync(file)) throw new WalkError("FLOW_MISSING", `No flow.yaml in ${paths(dir).root}`);
  const parsed = FlowSchema.safeParse(YAML.parse(await readFile(file, "utf8")));
  if (!parsed.success) {
    throw new WalkError(
      "FLOW_INVALID",
      `flow.yaml is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const ids = parsed.data.steps.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new WalkError("FLOW_INVALID", `Duplicate step id "${dup}"`);
  return parsed.data;
}

/** Import flow.yaml into the manifest. Planned steps are unobserved until captured. */
export async function plan(dir: string) {
  const m = await loadManifest(dir);
  const flow = await readFlowFile(dir);
  const warnings: string[] = [];
  if (!hostAllowed(m.project.startUrl, flow.permittedDomains)) {
    warnings.push(`startUrl ${m.project.startUrl} is not in permittedDomains`);
  }
  const { steps, invalidated, narrationUpdated } = applyFlow(m, flow);
  m.flow = flow;
  m.steps = steps;
  m.status = deriveStatus(m, await profileFor(m));
  const saved = await saveManifest(dir, m, "plan");
  return {
    revision: saved.revision,
    steps: steps.map((s) => ({ id: s.id, status: s.status })),
    needsValidation: invalidated,
    narrationUpdated,
    warnings,
  };
}

/** Planning bundle for an agent or human: the brief plus redacted evidence of the start page. */
export async function planRequest(dir: string, opts: { headed?: boolean }) {
  const m = await loadManifest(dir);
  const p = paths(dir);
  const flow: Flow = m.flow ?? FlowSchema.parse({ permittedDomains: [new URL(m.project.startUrl).host], steps: [{ id: "start", title: "start", action: { type: "observe" } }] });
  const session = await openSession(m.project, flow, opts);
  try {
    await session.page.goto(m.project.startUrl, { waitUntil: "domcontentloaded" });
    await waitForStable(session.page);
    const shot = await redactedScreenshot(session.page, m.project, []);
    const snapshot = scrubText(await session.page.locator("body").ariaSnapshot(), shot.scrub);
    const ref = await putArtifact(dir, shot.png, "png");
    const bundle = {
      brief: {
        objective: m.project.objective,
        audience: m.project.audience,
        outcome: m.project.outcome,
        startUrl: m.project.startUrl,
        prerequisites: m.project.prerequisites,
        notes: m.project.notes ?? null,
      },
      startPage: { url: session.page.url(), screenshot: join(p.artifacts, ref), ariaSnapshot: snapshot },
      instructions:
        "Propose flow.yaml: 5-15 steps, semantic locators (role+name or label), an expect list per step, " +
        "sideEffect: mutating on data-changing steps, and outcome: true on the step whose after-state proves the outcome. " +
        "Notes are context only; nothing counts as demonstrated until capture observes it.",
    };
    const out = join(p.evidence, "_plan", "bundle.json");
    await writeFileAtomic(out, JSON.stringify(bundle, null, 2) + "\n");
    return { bundle: out, screenshot: bundle.startPage.screenshot };
  } finally {
    await session.close();
  }
}

