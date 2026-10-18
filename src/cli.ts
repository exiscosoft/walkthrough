#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import YAML from "yaml";
import { DEFAULT_ENGINES, benchSpeech, parseEngineSpec } from "./bench/speech.js";
import { capture } from "./capture/index.js";
import { init, plan, planRequest } from "./project/plan.js";
import { annotate, approve, confirmRedactions, exportPackage, listRedactions, status, storyboard, type AnnotateOps } from "./project/review.js";
import { loadManifest, saveManifest } from "./project/store.js";
import { render } from "./render/index.js";
import { draftScript, exportScript, importScript, scriptView, setNarration } from "./script/draft.js";
import { narrate } from "./speech/narrate.js";
import { approveVoice, deleteVoice, enrollVoice, loadVoice, testVoice } from "./speech/voice.js";
import { WalkError, type Rect } from "./util.js";
import { validateProject } from "./validate/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const log = (msg: string) => process.stderr.write(`${msg}\n`);

const program = new Command("walkthrough")
  .description("Create instructional website walkthrough videos from a feature brief.")
  .version(pkg.version)
  .option("--json", "machine-readable output: {ok,status,command,data,warnings,errors}");

/**
 * Every command returns machine-readable status. Paused errors (the engine needs a
 * person) exit 2; failures exit 1.
 */
function run<A extends unknown[]>(name: string, fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    const cmd = args.at(-1) as Command;
    const json = Boolean(cmd.optsWithGlobals().json);
    try {
      const data = (await fn(...args)) as Record<string, unknown> | undefined;
      const warnings = (data && Array.isArray(data.warnings) ? data.warnings : []) as unknown[];
      if (json) process.stdout.write(JSON.stringify({ ok: true, status: "ok", command: name, data, warnings, errors: [] }) + "\n");
      else if (data !== undefined) process.stdout.write(YAML.stringify(data));
    } catch (err) {
      const e = err instanceof WalkError ? err : new WalkError("INTERNAL", (err as Error).stack ?? String(err));
      const status = e.paused ? "paused" : "error";
      if (json) {
        process.stdout.write(JSON.stringify({ ok: false, status, command: name, data: null, warnings: [], errors: [{ code: e.code, message: e.message, hint: e.hint }] }) + "\n");
      } else {
        log(`${status === "paused" ? "PAUSED" : "ERROR"} [${e.code}] ${e.message}${e.hint ? `\n  → ${e.hint}` : ""}`);
      }
      process.exitCode = e.paused ? 2 : 1;
    }
  };
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const rect = (v: string): Rect => {
  const [x, y, width, height] = v.split(",").map(Number);
  if ([x, y, width, height].some((n) => n === undefined || Number.isNaN(n))) throw new WalkError("BAD_RECT", `Expected x,y,width,height, got ${v}`);
  return { x: x!, y: y!, width: width!, height: height! };
};

program
  .command("init <dir>")
  .description("create a project from a feature brief")
  .requiredOption("--name <name>", "tutorial title")
  .requiredOption("--objective <text>", "what the viewer will learn to do")
  .requiredOption("--audience <text>", "who the tutorial is for")
  .requiredOption("--outcome <text>", "the observable result that proves success")
  .requiredOption("--url <url>", "starting URL in the demo environment")
  .option("--environment <name>", "environment label", "local")
  .option("--notes <text>", "feature notes or acceptance criteria (context only)")
  .option("--prerequisite <text...>", "prerequisites such as seeded data or a demo account")
  .option("--redact <selectors>", "comma-separated CSS selectors that are always masked", list)
  .option("--reset-command <cmd>", "shell command that resets the demo data")
  .option("--brand <json>", "brand preset JSON, e.g. '{\"name\":\"Acme\",\"primary\":\"#123456\"}'")
  .option("--profile <name>", "browser profile name (stored outside the project)", "default")
  .action(
    run("init", (dir: string, o: any) =>
      init(dir, {
        name: o.name,
        objective: o.objective,
        audience: o.audience,
        outcome: o.outcome,
        startUrl: o.url,
        environment: o.environment,
        notes: o.notes,
        prerequisites: o.prerequisite ?? [],
        resetCommand: o.resetCommand,
        browserProfile: o.profile,
        redaction: { selectors: o.redact ?? [], allow: [], heuristics: true },
        ...(o.brand ? { brand: JSON.parse(o.brand) } : {}),
      }),
    ),
  );

program
  .command("plan <dir>")
  .description("validate flow.yaml and import it; --request writes a planning bundle for an agent")
  .option("--request", "open the start page and write evidence/_plan/bundle.json")
  .option("--headed", "show the browser")
  .action(run("plan", (dir: string, o: any) => (o.request ? planRequest(dir, { headed: o.headed }) : plan(dir))));

program
  .command("capture <dir>")
  .description("drive Chrome through the flow, capturing redacted evidence for each step")
  .option("--step <id>", "recapture one step (earlier steps are replayed, not captured)")
  .option("--all", "recapture every step")
  .option("--headed", "show the browser; required for manual steps such as sign-in")
  .option("--reset", "run project.resetCommand first so data-changing steps can be replayed")
  .option("--timeout <ms>", "per-step wait for controls and expectations", (v) => Number(v), 10_000)
  .action(run("capture", (dir: string, o: any) => capture(dir, { stepId: o.step, all: o.all, headed: o.headed, reset: o.reset, timeoutMs: o.timeout, log })));

const script = program.command("script").description("draft and edit narration");
script
  .command("draft <dir>")
  .description("template narration from observed labels for steps without narration")
  .option("--force", "also replace earlier template drafts")
  .action(run("script draft", (dir: string, o: any) => draftScript(dir, { force: o.force })));
script
  .command("show <dir>")
  .action(run("script show", async (dir: string) => ({ script: scriptView(await loadManifest(dir)) })));
script
  .command("set <dir>")
  .description("set one step's narration")
  .requiredOption("--step <id>")
  .requiredOption("--text <text>")
  .addOption(new Option("--source <who>").choices(["agent", "human"]).default("human"))
  .action(run("script set", (dir: string, o: any) => setNarration(dir, { [o.step]: o.text }, o.source)));
script.command("export <dir>").description("write script.yaml for editing").action(run("script export", (dir: string) => exportScript(dir)));
script
  .command("import <dir>")
  .description("read script.yaml back into the project")
  .addOption(new Option("--source <who>").choices(["agent", "human"]).default("human"))
  .action(run("script import", (dir: string, o: any) => importScript(dir, o.source)));

program
  .command("pronounce <dir> [term] [spoken]")
  .description("add a pronunciation override (affects speech only, never captions)")
  .option("--remove <term>")
  .action(
    run("pronounce", async (dir: string, term: string | undefined, spoken: string | undefined, o: any) => {
      const m = await loadManifest(dir);
      if (o.remove) delete m.project.pronunciation[o.remove];
      else if (term && spoken) m.project.pronunciation[term] = spoken;
      await saveManifest(dir, m, "pronunciation edited");
      return { pronunciation: m.project.pronunciation };
    }),
  );

program
  .command("annotate <dir>")
  .description("edit a step's highlights or zoom")
  .requiredOption("--step <id>")
  .option("--move <id:dx,dy>", "move an annotation by screenshot pixels, e.g. callout:-40,0")
  .option("--remove <id>", "remove an annotation")
  .option("--add <kind:x,y,w,h>", "add outline|spotlight|callout, e.g. outline:100,200,300,80")
  .option("--label <text>", "label for an added callout")
  .option("--crop <x,y,w,h|none|auto>", "set the zoom window")
  .option("--reset", "recompute suggested annotations and crop from the capture")
  .action(
    run("annotate", (dir: string, o: any) => {
      const ops: AnnotateOps = { reset: o.reset, remove: o.remove };
      if (o.move) {
        const [id, d] = String(o.move).split(":");
        const [dx, dy] = (d ?? "").split(",").map(Number);
        ops.move = { id: id!, dx: dx ?? 0, dy: dy ?? 0 };
      }
      if (o.add) {
        const [kind, r] = String(o.add).split(":");
        if (!["outline", "spotlight", "callout"].includes(kind!)) throw new WalkError("BAD_ANNOTATION", `Unknown kind ${kind}`);
        ops.add = { id: `${kind}-${Date.now().toString(36)}`, kind: kind as "outline", rect: rect(r ?? ""), label: o.label };
      }
      if (o.crop) ops.crop = o.crop === "none" || o.crop === "auto" ? o.crop : rect(o.crop);
      return annotate(dir, o.step, ops);
    }),
  );

program
  .command("redactions <dir>")
  .description("list masks; --confirm accepts low-confidence ones after review")
  .option("--confirm <ids>", "comma-separated redaction ids, or all")
  .action(run("redactions", (dir: string, o: any) => (o.confirm ? confirmRedactions(dir, o.confirm === "all" ? "all" : list(o.confirm)) : listRedactions(dir).then((r) => ({ redactions: r })))));

const voice = program.command("voice").description("manage the creator's own voice (stored outside projects)");
voice
  .command("enroll")
  .requiredOption("--voice <id>", "profile id, e.g. jordan")
  .requiredOption("--name <name>", "display name")
  .requiredOption("--file <audio>", "clean reference recording, 8–15 s")
  .option("--transcript <text>", "what the reference says (otherwise transcribed locally)")
  .option("--confirm-own-voice", "confirm the recording is your own voice")
  .action(run("voice enroll", (o: any) => enrollVoice({ id: o.voice, name: o.name, file: o.file, transcript: o.transcript, confirmOwnVoice: Boolean(o.confirmOwnVoice) })));
voice
  .command("test")
  .requiredOption("--voice <id>")
  .addOption(new Option("--engine <engine>").choices(["chatterbox", "f5-mlx", "mlx-audio"]).makeOptionMandatory())
  .option("--model <repo>", "model repo for mlx-audio")
  .action(run("voice test", (o: any) => testVoice(o.voice, o.engine, o.model ? { model: o.model } : {})));
voice
  .command("approve")
  .requiredOption("--voice <id>")
  .requiredOption("--engine <engine>")
  .action(run("voice approve", (o: any) => approveVoice(o.voice, o.engine)));
voice
  .command("show")
  .requiredOption("--voice <id>")
  .action(run("voice show", (o: any) => loadVoice(o.voice)));
voice
  .command("delete")
  .requiredOption("--voice <id>")
  .option("--project <dir>", "also delete clips made with this voice in a project")
  .action(run("voice delete", (o: any) => deleteVoice(o.voice, o.project)));
voice
  .command("use <dir>")
  .description("choose the narration engine and voice for a project")
  .addOption(new Option("--engine <engine>").choices(["chatterbox", "f5-mlx", "mlx-audio", "import"]).makeOptionMandatory())
  .option("--voice <id>")
  .option("--model <repo>", "model repo for mlx-audio")
  .action(
    run("voice use", async (dir: string, o: any) => {
      const m = await loadManifest(dir);
      if (o.engine !== "import" && !o.voice) throw new WalkError("VOICE_REQUIRED", "--voice is required for synthesis engines");
      m.project.voice = { engine: o.engine, profileId: o.voice, settings: o.model ? { model: o.model } : {} };
      const saved = await saveManifest(dir, m, `voice set to ${o.engine}`);
      return { voice: saved.project.voice };
    }),
  );

program
  .command("narrate <dir>")
  .description("generate or import narration audio for steps whose audio is missing or stale")
  .option("--step <id>", "only this step")
  .option("--file <audio>", "import engine: recording for --step")
  .option("--from-dir <dir>", "import engine: directory of <stepId>.<ext> recordings")
  .option("--force", "regenerate even current clips")
  .action(run("narrate", (dir: string, o: any) => narrate(dir, { stepId: o.step, file: o.file, dir: o.fromDir, force: o.force, log })));

program
  .command("storyboard <dir>")
  .description("write storyboard.html, a reviewable contact sheet")
  .action(run("storyboard", (dir: string) => storyboard(dir)));

program
  .command("approve <dir> <what>")
  .description("approve storyboard | script | visuals (confirms frames are suitable to share)")
  .action(
    run("approve", (dir: string, what: string) => {
      if (!["storyboard", "script", "visuals"].includes(what)) throw new WalkError("BAD_APPROVAL", "Approve storyboard, script or visuals");
      return approve(dir, what as "storyboard");
    }),
  );

program
  .command("render <dir>")
  .description("render the MP4, captions and transcript")
  .option("--revision <n>", "render an earlier revision", (v) => Number(v))
  .option("--preview", "watermarked draft that skips approval gates")
  .action(run("render", (dir: string, o: any) => render(dir, { revision: o.revision, preview: o.preview, log })));

program
  .command("validate <dir>")
  .description("list everything blocking a final export")
  .action(
    run("validate", async (dir: string) => {
      const m = await loadManifest(dir);
      const profile = m.project.voice.profileId ? await loadVoice(m.project.voice.profileId).catch(() => undefined) : undefined;
      const issues = validateProject(dir, m, profile);
      const errors = issues.filter((i) => i.severity === "error");
      return { ready: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === "warning") };
    }),
  );

program.command("status <dir>").description("stage, stale items and the next action").action(run("status", (dir: string) => status(dir)));
program.command("export <dir>").description("package the latest final render with its redacted assets").action(run("export", (dir: string) => exportPackage(dir)));

const bench = program.command("bench").description("benchmarks");
bench
  .command("speech")
  .description("benchmark local voice cloning engines on this machine")
  .option("--engines <specs>", "comma-separated: chatterbox, f5-mlx, mlx-audio:<hf repo> (default: all candidates)", list)
  .option("--scripts <names>", "scripts in bench/scripts", list, ["30s", "3min"])
  .option("--voice <id>", "use an enrolled voice instead of the synthetic reference")
  .option("--timeout <seconds>", "synthesis budget per run (default scales with script length)", (v) => Number(v))
  .action(
    run("bench speech", async (o: any) => {
      let reference = join(repoRoot, "bench", "reference", "synthetic-ref.wav");
      let referenceText = readFileSync(join(repoRoot, "bench", "reference", "synthetic-ref.txt"), "utf8").trim();
      if (o.voice) {
        const v = await loadVoice(o.voice);
        reference = v.reference.file;
        referenceText = v.reference.transcript ?? "";
      }
      const r = await benchSpeech({
        engines: o.engines ? o.engines.map(parseEngineSpec) : DEFAULT_ENGINES,
        scripts: o.scripts.map((s: string) => join(repoRoot, "bench", "scripts", `${s}.txt`)),
        reference,
        referenceText,
        outDir: join(repoRoot, "bench", "results"),
        repoRoot,
        timeoutMs: o.timeout ? () => o.timeout * 1000 : undefined,
        log,
      });
      return { results: r.results, report: r.report, runs: r.runs.map(({ transcript, output, ...rest }) => rest) };
    }),
  );

await program.parseAsync();
