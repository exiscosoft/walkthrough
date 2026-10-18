import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { ManifestSchema, SCHEMA_VERSION, type Manifest, type ProjectConfig } from "./schema.js";
import { sha256, WalkError, writeFileAtomic } from "../util.js";

/** Machine-local state that never goes into a project export: browser profiles and voices. */
export function walkthroughHome(): string {
  return process.env.WALKTHROUGH_HOME ?? join(homedir(), ".walkthrough");
}

export function paths(dir: string) {
  const root = resolve(dir);
  return {
    root,
    manifest: join(root, "project.json"),
    flow: join(root, "flow.yaml"),
    revisions: join(root, "revisions"),
    artifacts: join(root, "artifacts"),
    evidence: join(root, "evidence"),
    renders: join(root, "renders"),
    exports: join(root, "exports"),
    cache: join(root, "cache"),
    storyboard: join(root, "storyboard.html"),
    script: join(root, "script.yaml"),
  };
}

export function newManifest(project: ProjectConfig): Manifest {
  return ManifestSchema.parse({ schemaVersion: SCHEMA_VERSION, revision: 0, status: "draft", project });
}

export async function loadManifest(dir: string): Promise<Manifest> {
  const p = paths(dir);
  if (!existsSync(p.manifest)) {
    throw new WalkError("PROJECT_NOT_FOUND", `No project.json in ${p.root}`, "Run `walkthrough init <dir>` first.");
  }
  const raw = JSON.parse(await readFile(p.manifest, "utf8"));
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WalkError("MANIFEST_INVALID", `project.json failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Persist the manifest as a new revision. Every save writes an immutable
 * revisions/<n>.json so renders can name the exact state they were built from.
 */
export async function saveManifest(dir: string, m: Manifest, reason: string): Promise<Manifest> {
  const p = paths(dir);
  const next = ManifestSchema.parse({ ...m, revision: m.revision + 1 });
  const body = JSON.stringify(next, null, 2) + "\n";
  await writeFileAtomic(join(p.revisions, `${next.revision}.json`), JSON.stringify({ reason, manifest: next }) + "\n");
  await writeFileAtomic(p.manifest, body);
  return next;
}

export async function loadRevision(dir: string, revision: number): Promise<Manifest> {
  const file = join(paths(dir).revisions, `${revision}.json`);
  if (!existsSync(file)) throw new WalkError("REVISION_NOT_FOUND", `Revision ${revision} does not exist`);
  const { manifest } = JSON.parse(await readFile(file, "utf8"));
  return ManifestSchema.parse(manifest);
}

/** Content-addressed store: the ref is `<sha256>.<ext>`, so identical content keeps its hash. */
export async function putArtifact(dir: string, data: Buffer | string, ext: string): Promise<string> {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  const ref = `${sha256(buf)}.${ext.replace(/^\./, "")}`;
  const file = join(paths(dir).artifacts, ref);
  if (!existsSync(file)) await writeFileAtomic(file, buf);
  return ref;
}

export async function putArtifactFile(dir: string, file: string): Promise<string> {
  return putArtifact(dir, await readFile(file), extname(file) || ".bin");
}

export function artifactPath(dir: string, ref: string): string {
  if (basename(ref) !== ref) throw new WalkError("ARTIFACT_REF_INVALID", `Bad artifact ref ${ref}`);
  return join(paths(dir).artifacts, ref);
}

export async function readArtifact(dir: string, ref: string): Promise<Buffer> {
  return readFile(artifactPath(dir, ref));
}

export async function ensureDirs(dir: string): Promise<void> {
  const p = paths(dir);
  for (const d of [p.root, p.revisions, p.artifacts, p.evidence, p.renders, p.exports, p.cache]) {
    await mkdir(d, { recursive: true });
  }
}
