import { z } from "zod";

export const SCHEMA_VERSION = 1;

const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

// ---- Flow definition (authored in flow.yaml) ---------------------------------

export const LocatorSchema = z.union([
  z.object({ role: z.string(), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ label: z.string(), exact: z.boolean().optional() }),
  z.object({ text: z.string(), exact: z.boolean().optional() }),
  z.object({ testId: z.string() }),
  z.object({ css: z.string() }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

export const AssertionSchema = z.union([
  z.object({ visible: LocatorSchema }),
  z.object({ hidden: LocatorSchema }),
  z.object({ url: z.string().describe("regular expression matched against the page URL") }),
  z.object({ text: z.string().describe("substring that must be visible on the page") }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

const target = { target: LocatorSchema };
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string() }),
  z.object({ type: z.literal("click"), ...target }),
  z.object({ type: z.literal("fill"), ...target, value: z.string() }),
  z.object({ type: z.literal("select"), ...target, option: z.string() }),
  z.object({ type: z.literal("check"), ...target, checked: z.boolean().default(true) }),
  z.object({ type: z.literal("scroll"), target: LocatorSchema.optional(), y: z.number().optional() }),
  z.object({ type: z.literal("observe"), target: LocatorSchema.optional() }),
  z.object({ type: z.literal("manual"), instructions: z.string(), timeoutMs: z.number().default(300_000) }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const FlowStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "step ids are lowercase slugs"),
  title: z.string(),
  action: ActionSchema,
  expect: z.array(AssertionSchema).default([]),
  sideEffect: z.enum(["none", "mutating"]).default("none"),
  /** Permit a mutating action on test data. Without it capture pauses before the action. */
  allow: z.boolean().default(false),
  /** Safe to replay on resume/recapture without resetting test data. */
  idempotent: z.boolean().default(false),
  /** This step's after-state proves the tutorial's stated outcome. */
  outcome: z.boolean().default(false),
  /** Expect a dialog/modal to be open at this step (otherwise one pauses capture). */
  dialogExpected: z.boolean().default(false),
  narration: z.string().optional(),
}).superRefine((step, ctx) => {
  // Without an expectation there is nothing to wait for, so a manual step would end instantly.
  if (step.action.type === "manual" && step.expect.length === 0) {
    ctx.addIssue({ code: "custom", path: ["expect"], message: "manual steps need an expect list that shows the person has finished" });
  }
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

const TestDataValueSchema = z.union([
  z.string(),
  z.object({ value: z.string().optional(), env: z.string().optional(), sensitive: z.boolean().default(false) }),
]);

export const FlowSchema = z.object({
  prerequisites: z.array(z.string()).default([]),
  permittedDomains: z.array(z.string()).min(1),
  testData: z.record(z.string(), TestDataValueSchema).default({}),
  /** If any of these hold at a step, the session expired: capture pauses with AUTH_EXPIRED. */
  signedOutWhen: z.array(AssertionSchema).default([]),
  steps: z.array(FlowStepSchema).min(1),
});
export type Flow = z.infer<typeof FlowSchema>;

// ---- Project configuration ---------------------------------------------------

export const BrandSchema = z.object({
  name: z.string().default("Walkthrough"),
  primary: z.string().default("#1F4FD8"),
  accent: z.string().default("#FFB020"),
  text: z.string().default("#FFFFFF"),
  background: z.string().default("#0E1525"),
  font: z.string().default("Helvetica Neue, Helvetica, Arial, sans-serif"),
  logo: z.string().optional(),
});

export const ProjectConfigSchema = z.object({
  name: z.string(),
  objective: z.string(),
  audience: z.string(),
  outcome: z.string(),
  startUrl: z.string().url(),
  environment: z.string().default("local"),
  language: z.string().default("en"),
  viewport: z
    .object({ width: z.number(), height: z.number(), deviceScaleFactor: z.number() })
    .default({ width: 1280, height: 720, deviceScaleFactor: 2 }),
  brand: BrandSchema.default(BrandSchema.parse({})),
  prerequisites: z.array(z.string()).default([]),
  notes: z.string().optional(),
  /** Shell command that resets demo data, enabling replay of non-idempotent steps. */
  resetCommand: z.string().optional(),
  browserProfile: z.string().default("default"),
  redaction: z
    .object({
      selectors: z.array(z.string()).default([]),
      /** Selectors explicitly cleared for display after review; overrides heuristics only. */
      allow: z.array(z.string()).default([]),
      heuristics: z.boolean().default(true),
    })
    .default({ selectors: [], allow: [], heuristics: true }),
  pronunciation: z.record(z.string(), z.string()).default({}),
  timing: z
    .object({ leadInMs: z.number().default(900), pauseMs: z.number().default(700), transitionMs: z.number().default(350) })
    .default({ leadInMs: 900, pauseMs: 700, transitionMs: 350 }),
  voice: z
    .object({
      profileId: z.string().optional(),
      engine: z.enum(["chatterbox", "f5-mlx", "mlx-audio", "import"]).default("import"),
      settings: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ engine: "import", settings: {} }),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ---- Observed evidence and derived artifacts ---------------------------------

export const ShotSchema = z.object({ artifact: z.string(), width: z.number(), height: z.number() });

export const RedactionSchema = z.object({
  id: z.string(),
  rect: RectSchema.describe("screenshot pixels"),
  reason: z.enum(["password", "selector", "heuristic"]),
  detail: z.string(),
  confidence: z.enum(["high", "low"]),
  confirmed: z.boolean().default(false),
});
export type Redaction = z.infer<typeof RedactionSchema>;

export const CaptureSchema = z.object({
  capturedAt: z.string(),
  actionHash: z.string(),
  url: z.string(),
  /** The frame shown in the video for this step. */
  shot: ShotSchema,
  /** The state after the action, which proves the expectation. */
  after: ShotSchema.optional(),
  target: z
    .object({ cssRect: RectSchema, rect: RectSchema, role: z.string().optional(), name: z.string().optional() })
    .optional(),
  labels: z.array(z.string()),
  ariaSnapshot: z.string().describe("artifact ref, scrubbed of sensitive values"),
  expectPassed: z.boolean(),
  redactions: z.array(RedactionSchema),
  externalHosts: z.array(z.string()).default([]),
});
export type Capture = z.infer<typeof CaptureSchema>;

export const AnnotationSchema = z.object({
  id: z.string(),
  kind: z.enum(["outline", "callout", "spotlight"]),
  rect: RectSchema.describe("screenshot pixels"),
  label: z.string().optional(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

export const CaptionSegmentSchema = z.object({ text: z.string(), startMs: z.number(), endMs: z.number() });
export type CaptionSegment = z.infer<typeof CaptionSegmentSchema>;

export const AudioClipSchema = z.object({
  stepId: z.string(),
  scriptHash: z.string(),
  engine: z.string(),
  engineInfo: z.record(z.string(), z.unknown()).default({}),
  voiceProfile: z.object({ id: z.string(), version: z.number() }).optional(),
  artifact: z.string(),
  durationMs: z.number(),
  segments: z.array(CaptionSegmentSchema),
  timing: z.enum(["synthesis", "aligned", "proportional"]),
  approved: z.boolean().default(false),
  createdAt: z.string(),
  wallMs: z.number().optional(),
});
export type AudioClip = z.infer<typeof AudioClipSchema>;

export const NarrationSchema = z.object({
  text: z.string(),
  /** "flow" = imported from flow.yaml; re-planning updates it when the flow's text changes. */
  source: z.enum(["template", "flow", "agent", "human"]),
  updatedAt: z.string(),
});

export const StepStateSchema = z.object({
  id: z.string(),
  status: z.enum(["planned", "captured", "needs_validation", "failed"]),
  capture: CaptureSchema.optional(),
  annotations: z.array(AnnotationSchema).default([]),
  /** Region the scene zooms to, in screenshot pixels. Absent means full frame. */
  crop: RectSchema.nullable().optional(),
  narration: NarrationSchema.optional(),
  clip: AudioClipSchema.optional(),
  leadInMs: z.number().optional(),
  pauseMs: z.number().optional(),
  /** Set once a mutating action ran, so it is not replayed without a data reset. */
  actionExecutedAt: z.string().optional(),
});
export type StepState = z.infer<typeof StepStateSchema>;

export const JobStateSchema = z.enum([
  "draft",
  "planned",
  "capturing",
  "review_required",
  "generating_audio",
  "ready_to_render",
  "rendering",
  "complete",
  "failed",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const ApprovalSchema = z.object({ revision: z.number(), hash: z.string(), at: z.string() });
export type Approval = z.infer<typeof ApprovalSchema>;

export const RenderRecordSchema = z.object({
  id: z.string(),
  revision: z.number(),
  preview: z.boolean(),
  status: z.enum(["rendering", "complete", "failed"]),
  dir: z.string(),
  inputsHash: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.number(),
  status: JobStateSchema,
  project: ProjectConfigSchema,
  flow: FlowSchema.optional(),
  steps: z.array(StepStateSchema).default([]),
  approvals: z
    .object({ storyboard: ApprovalSchema.optional(), script: ApprovalSchema.optional(), visuals: ApprovalSchema.optional() })
    .default({}),
  checkpoint: z
    .object({
      stage: z.string(),
      stepId: z.string().optional(),
      error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
      at: z.string(),
    })
    .optional(),
  renders: z.array(RenderRecordSchema).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const VoiceProfileSchema = z.object({
  id: z.string(),
  version: z.number(),
  displayName: z.string(),
  ownershipConfirmed: z.object({ by: z.string(), at: z.string(), statement: z.string() }),
  reference: z.object({ file: z.string(), sha256: z.string(), durationMs: z.number(), transcript: z.string().optional() }),
  approvedSample: z.object({ file: z.string(), engine: z.string(), at: z.string() }).optional(),
  createdAt: z.string(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;
