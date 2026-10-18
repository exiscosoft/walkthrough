import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { clipState, deriveStatus, importScriptHash, scriptHash, spokenText } from "../project/invalidate.js";
import type { AudioClip, CaptionSegment, Manifest, VoiceProfile } from "../project/schema.js";
import { loadManifest, putArtifactFile, saveManifest } from "../project/store.js";
import { alignScript, proportionalSegments, sentencesFromWords } from "../render/captions.js";
import { durationMs, normalizeRecording } from "../render/ffmpeg.js";
import { nowIso, splitSentences, WalkError } from "../util.js";
import { engineInstalled, SpeechProcess, type AlignResult, type SynthResult } from "./sidecar.js";
import { loadVoice } from "./voice.js";

export interface NarrateOptions {
  stepId?: string;
  /** Imported recording for --step, or a directory of <stepId>.<ext> recordings. */
  file?: string;
  dir?: string;
  force?: boolean;
  log?: (msg: string) => void;
}

export async function narrate(projectDir: string, opts: NarrateOptions = {}) {
  const log = opts.log ?? (() => {});
  let m = await loadManifest(projectDir);
  const engine = m.project.voice.engine;
  const profile = engine === "import" ? undefined : await requireApprovedVoice(m);

  const todo = m.steps.filter(
    (s) => s.narration && (opts.stepId ? s.id === opts.stepId : opts.force || clipState(s, m.project, profile) !== "current"),
  );
  if (opts.stepId && todo.length === 0) throw new WalkError("STEP_NOT_FOUND", `Step "${opts.stepId}" has no narration to voice`);
  if (todo.length === 0) return { generated: [], engine, warnings: [] as string[] };

  const warnings: string[] = [];
  const generated: string[] = [];
  m.status = "generating_audio";
  m = await saveManifest(projectDir, m, "narration started");

  try {
    if (engine === "import") {
      const recordings = await findRecordings(todo.map((s) => s.id), opts);
      const pending = todo.filter((s) => recordings.has(s.id));
      for (const s of todo) if (!recordings.has(s.id)) warnings.push(`${s.id}: no recording supplied`);
      const clips = await importRecordings(projectDir, pending.map((s) => ({ id: s.id, text: s.narration!.text, file: recordings.get(s.id)! })), log);
      for (const clip of clips) {
        if (clip.timing === "proportional") warnings.push(`${clip.stepId}: caption timing is proportional (aligner not installed)`);
        m = await storeClip(projectDir, m, clip);
        generated.push(clip.stepId);
      }
    } else {
      // One process for the whole batch; it exits afterwards, releasing model memory.
      const proc = SpeechProcess.spawn(engine, { onLog: (l) => log(`  [${engine}] ${l}`) });
      const tmp = await mkdtemp(join(tmpdir(), "wt-narrate-"));
      try {
        const load = await proc.request({ cmd: "load", engine, settings: m.project.voice.settings });
        log(`${engine} loaded in ${load.loadMs} ms`);
        for (const s of todo) {
          const text = s.narration!.text;
          const out = join(tmp, `${s.id}.wav`);
          log(`synthesizing ${s.id}`);
          const r = await proc.request<SynthResult>({
            cmd: "synthesize",
            text: spokenText(text, m.project.pronunciation),
            ref_audio: profile!.reference.file,
            ref_text: profile!.reference.transcript,
            out,
          });
          const clip: AudioClip = {
            stepId: s.id,
            scriptHash: scriptHash(text, m.project, profile),
            engine,
            engineInfo: { ...load.info, settings: m.project.voice.settings, referenceSha256: profile!.reference.sha256 },
            voiceProfile: { id: profile!.id, version: profile!.version },
            artifact: await putArtifactFile(projectDir, out),
            durationMs: r.durationMs,
            segments: visibleSegments(text, r.segments),
            timing: "synthesis",
            approved: false,
            createdAt: nowIso(),
            wallMs: r.wallMs,
          };
          // Persist after every clip so an interrupted run resumes where it stopped.
          m = await storeClip(projectDir, m, clip);
          generated.push(s.id);
        }
      } finally {
        await proc.close();
        await rm(tmp, { recursive: true, force: true });
      }
    }
  } catch (err) {
    m.status = "failed";
    m.checkpoint = { stage: "narrate", error: { code: (err as WalkError).code ?? "NARRATE_FAILED", message: (err as Error).message }, at: nowIso() };
    await saveManifest(projectDir, m, "narration failed");
    throw err;
  }
  m.status = deriveStatus(m, profile);
  m.checkpoint = { stage: "narrate", at: nowIso() };
  await saveManifest(projectDir, m, "narration finished");
  return { generated, engine, warnings };
}

async function requireApprovedVoice(m: Manifest): Promise<VoiceProfile> {
  const id = m.project.voice.profileId;
  if (!id) throw new WalkError("VOICE_NOT_SET", "project.voice.profileId is not set", "Run `walkthrough voice use <dir> --voice <id> --engine <engine>`.");
  const profile = await loadVoice(id);
  if (!profile.approvedSample || profile.approvedSample.engine !== m.project.voice.engine) {
    throw new WalkError(
      "VOICE_NOT_APPROVED",
      `Voice "${id}" v${profile.version} has no approved ${m.project.voice.engine} sample`,
      `Run \`walkthrough voice test --voice ${id} --engine ${m.project.voice.engine}\`, listen, then \`walkthrough voice approve\`.`,
    );
  }
  return profile;
}

/** Synthesis segments carry spoken text (after pronunciation); captions show the visible text. */
function visibleSegments(text: string, spoken: CaptionSegment[]): CaptionSegment[] {
  const visible = splitSentences(text);
  if (visible.length === spoken.length) return spoken.map((seg, i) => ({ ...seg, text: visible[i]! }));
  const end = spoken.at(-1)?.endMs ?? 0;
  return [{ text: visible.join(" "), startMs: spoken[0]?.startMs ?? 0, endMs: end }];
}

async function storeClip(projectDir: string, m: Manifest, clip: AudioClip): Promise<Manifest> {
  m.steps = m.steps.map((s) => (s.id === clip.stepId ? { ...s, clip } : s));
  m.checkpoint = { stage: "narrate", stepId: clip.stepId, at: nowIso() };
  return saveManifest(projectDir, m, `audio ${clip.stepId}`);
}

const AUDIO_EXT = new Set([".wav", ".m4a", ".mp3", ".aiff", ".aif", ".flac", ".caf"]);

async function findRecordings(ids: string[], opts: NarrateOptions): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (opts.file) {
    if (!opts.stepId) throw new WalkError("STEP_REQUIRED", "--file needs --step");
    if (!existsSync(opts.file)) throw new WalkError("RECORDING_NOT_FOUND", `${opts.file} does not exist`);
    found.set(opts.stepId, opts.file);
  }
  if (opts.dir) {
    for (const f of await readdir(opts.dir)) {
      const id = f.slice(0, -extname(f).length);
      if (AUDIO_EXT.has(extname(f).toLowerCase()) && ids.includes(id)) found.set(id, join(opts.dir, f));
    }
  }
  if (found.size === 0) {
    throw new WalkError("RECORDINGS_REQUIRED", "The import engine needs recordings", "Pass --step <id> --file <audio>, or --dir with files named <stepId>.wav.");
  }
  return found;
}

/** Normalise personal recordings and time their sentences with the aligner when it is installed. */
async function importRecordings(projectDir: string, items: { id: string; text: string; file: string }[], log: (m: string) => void): Promise<AudioClip[]> {
  const tmp = await mkdtemp(join(tmpdir(), "wt-import-"));
  const aligner = items.length && engineInstalled("align") ? SpeechProcess.spawn("align") : undefined;
  try {
    if (aligner) await aligner.request({ cmd: "load", engine: "align" });
    const clips: AudioClip[] = [];
    for (const it of items) {
      const out = join(tmp, `${it.id}.wav`);
      await normalizeRecording(it.file, out);
      const ms = await durationMs(out);
      let segments: CaptionSegment[];
      let timing: AudioClip["timing"] = "proportional";
      if (aligner) {
        const a = await aligner.request<AlignResult>({ cmd: "align", wav: out });
        segments = sentencesFromWords(it.text, alignScript(it.text, a.words, ms));
        timing = "aligned";
      } else {
        segments = proportionalSegments(it.text, ms);
      }
      log(`imported ${it.id} (${(ms / 1000).toFixed(1)}s, ${timing})`);
      clips.push({
        stepId: it.id,
        scriptHash: importScriptHash(it.text),
        engine: "import",
        engineInfo: { source: it.file },
        artifact: await putArtifactFile(projectDir, out),
        durationMs: ms,
        segments,
        timing,
        approved: false,
        createdAt: nowIso(),
      });
    }
    return clips;
  } finally {
    await aligner?.close();
    await rm(tmp, { recursive: true, force: true });
  }
}
