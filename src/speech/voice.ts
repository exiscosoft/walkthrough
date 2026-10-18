import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { walkthroughHome, loadManifest, saveManifest, paths } from "../project/store.js";
import { VoiceProfileSchema, type Manifest, type VoiceProfile } from "../project/schema.js";
import { durationMs, ffmpeg } from "../render/ffmpeg.js";
import { nowIso, sha256, WalkError, writeFileAtomic } from "../util.js";
import { engineInstalled, SpeechProcess, type EngineName } from "./sidecar.js";

export const OWNERSHIP_STATEMENT =
  "I confirm this reference recording is my own voice, and I consent to it being used to synthesize narration for my walkthrough videos.";

export const VOICE_TEST_SCRIPT =
  "Welcome to the Northwind dealer portal. Click Accept invitation, then enter a password with at least 12 characters. Your SSO settings are under Admin, then API keys.";

export function voiceDir(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new WalkError("VOICE_ID_INVALID", "Voice ids are lowercase slugs");
  return join(walkthroughHome(), "voices", id);
}

export async function loadVoice(id: string): Promise<VoiceProfile> {
  const file = join(voiceDir(id), "profile.json");
  if (!existsSync(file)) throw new WalkError("VOICE_NOT_FOUND", `No voice profile "${id}"`, "Enroll one with `walkthrough voice enroll`.");
  return VoiceProfileSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** The voice profile a project narrates with, if it uses a synthesis engine and the profile exists. */
export async function profileFor(m: Manifest): Promise<VoiceProfile | undefined> {
  const id = m.project.voice.profileId;
  return m.project.voice.engine !== "import" && id ? loadVoice(id).catch(() => undefined) : undefined;
}

/** Enrol the creator's own voice. Re-enrolling bumps the version, which invalidates clips made with it. */
export async function enrollVoice(opts: { id: string; name: string; file: string; confirmOwnVoice: boolean; transcript?: string }) {
  if (!opts.confirmOwnVoice) {
    throw new WalkError("OWNERSHIP_NOT_CONFIRMED", "Voice enrolment needs explicit confirmation that the recording is your own voice", `Re-run with --confirm-own-voice. Statement: "${OWNERSHIP_STATEMENT}"`);
  }
  const dir = voiceDir(opts.id);
  await mkdir(dir, { recursive: true });
  const prior = existsSync(join(dir, "profile.json")) ? await loadVoice(opts.id) : undefined;
  // Convert and check the new recording beside the old one; the approved reference is only
  // replaced once the new one has passed every check.
  const ref = join(dir, "reference.wav");
  const pending = join(dir, `reference.pending-${process.pid}.wav`);
  let ms: number;
  let transcript = opts.transcript;
  const warnings: string[] = [];
  try {
    await ffmpeg(["-i", opts.file, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", pending]);
    ms = await durationMs(pending);
    if (ms < 5000) throw new WalkError("REFERENCE_TOO_SHORT", `Reference is ${(ms / 1000).toFixed(1)}s`, "Record 8-15 seconds of clean speech.");
    if (ms > 20_000) warnings.push("Reference is over 20s; most engines only use the first 10-15s.");
    if (!transcript && engineInstalled("align")) {
      const proc = SpeechProcess.spawn("align");
      try {
        await proc.request({ cmd: "load", engine: "align" });
        transcript = (await proc.request<{ text: string }>({ cmd: "align", wav: pending })).text;
      } finally {
        await proc.close();
      }
    }
    await rename(pending, ref);
  } finally {
    await rm(pending, { force: true });
  }
  if (!transcript) warnings.push("No transcript: the f5-mlx engine needs one (pass --transcript).");

  const profile: VoiceProfile = {
    id: opts.id,
    version: (prior?.version ?? 0) + 1,
    displayName: opts.name,
    ownershipConfirmed: { by: userInfo().username, at: nowIso(), statement: OWNERSHIP_STATEMENT },
    reference: { file: ref, sha256: sha256(await readFile(ref)), durationMs: ms, transcript },
    createdAt: nowIso(),
  };
  await writeFileAtomic(join(dir, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
  return { profile, warnings, next: `walkthrough voice test --voice ${opts.id} --engine <engine>` };
}

/** Generate the short test script so the creator can hear the clone before approving it. */
export async function testVoice(id: string, engine: Exclude<EngineName, "align">, settings: Record<string, unknown>) {
  const profile = await loadVoice(id);
  const out = join(voiceDir(id), "samples", `${engine}-v${profile.version}.wav`);
  await mkdir(join(voiceDir(id), "samples"), { recursive: true });
  const proc = SpeechProcess.spawn(engine);
  try {
    const load = await proc.request({ cmd: "load", engine, settings });
    const r = await proc.request({ cmd: "synthesize", text: VOICE_TEST_SCRIPT, ref_audio: profile.reference.file, ref_text: profile.reference.transcript, out });
    return { sample: out, durationMs: r.durationMs, wallMs: r.wallMs, loadMs: load.loadMs, info: load.info, next: `listen, then: walkthrough voice approve --voice ${id} --engine ${engine}` };
  } finally {
    await proc.close();
  }
}

export async function approveVoice(id: string, engine: string) {
  const profile = await loadVoice(id);
  const sample = join(voiceDir(id), "samples", `${engine}-v${profile.version}.wav`);
  if (!existsSync(sample)) throw new WalkError("VOICE_SAMPLE_MISSING", `No ${engine} sample for voice ${id} v${profile.version}`, "Run `walkthrough voice test` first and listen to it.");
  profile.approvedSample = { file: sample, engine, at: nowIso() };
  await writeFileAtomic(join(voiceDir(id), "profile.json"), JSON.stringify(profile, null, 2) + "\n");
  return { voice: id, version: profile.version, approvedSample: sample };
}

/** Delete the reference, samples and profile; optionally strip clips made with it from a project. */
export async function deleteVoice(id: string, projectDir?: string) {
  const removedClips: string[] = [];
  if (projectDir) {
    const m = await loadManifest(projectDir);
    for (const s of m.steps) {
      if (s.clip?.voiceProfile?.id !== id) continue;
      removedClips.push(s.id);
      await rm(join(paths(projectDir).artifacts, s.clip.artifact), { force: true });
      s.clip = undefined;
    }
    if (m.project.voice.profileId === id) m.project.voice.profileId = undefined;
    await saveManifest(projectDir, m, `voice ${id} deleted`);
  }
  await rm(voiceDir(id), { recursive: true, force: true });
  return { deleted: id, removedClips };
}
