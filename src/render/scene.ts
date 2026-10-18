import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type Sharp } from "sharp";
import { cardSvg, overlaySvg, watermarkSvg } from "../annotate/draw.js";
import type { ProjectConfig } from "../project/schema.js";
import { artifactPath } from "../project/store.js";
import { hashOf, type Rect } from "../util.js";
import { ffmpeg } from "./ffmpeg.js";
import { FPS, frames, OUT_H, OUT_W, type Scene } from "./timeline.js";

/** Bump when frame generation changes, so cached segments are rebuilt. */
const RENDER_VERSION = 3;
export const ENCODER = { codec: "libx264", preset: "medium", crf: 18, pixFmt: "yuv420p", fps: FPS } as const;

const ZOOM_MS = 650;
const FADE_MS = 300;

export function sceneHash(scene: Scene, brand: ProjectConfig["brand"], scale: number, preview: boolean, transitionMs: number): string {
  const content: Record<string, unknown> = { ...scene };
  // Position, captions and the audio file don't change this scene's pixels.
  delete content.startMs;
  delete content.segments;
  delete content.audio;
  return hashOf({ v: RENDER_VERSION, content, brand, scale, preview, transitionMs, encoder: ENCODER });
}

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function lerpRect(a: Rect, b: Rect, p: number): Rect {
  const l = (x: number, y: number) => x + (y - x) * p;
  return { x: l(a.x, b.x), y: l(a.y, b.y), width: l(a.width, b.width), height: l(a.height, b.height) };
}

/**
 * Render one scene to a cached, video-only segment. Animated frames are drawn
 * explicitly (zoom, then highlight fade-in); the rest is one held frame.
 */
export async function renderScene(
  projectDir: string,
  scene: Scene,
  brand: ProjectConfig["brand"],
  scale: number,
  preview: boolean,
  cacheDir: string,
  transitionMs: number,
): Promise<{ file: string; cached: boolean; hash: string }> {
  const hash = sceneHash(scene, brand, scale, preview, transitionMs);
  const file = join(cacheDir, `${hash}.mp4`);
  if (existsSync(file)) return { file, cached: true, hash };

  await mkdir(cacheDir, { recursive: true });
  const work = await mkdtemp(join(cacheDir, `tmp-${hash}-`));
  try {
    const watermark = preview ? Buffer.from(watermarkSvg(OUT_W, OUT_H)) : undefined;
    const finish = (img: Sharp) =>
      (watermark ? img.composite([{ input: watermark }]) : img).png({ compressionLevel: 1 }).toBuffer();
    const list: string[] = ["ffconcat version 1.0"];
    let used = 0;
    const total = frames(scene.durationMs);
    const emit = async (buf: Buffer, n: number) => {
      const name = `f${String(list.length).padStart(5, "0")}.png`;
      await writeFile(join(work, name), buf);
      list.push(`file '${name}'`, `duration ${(n / FPS).toFixed(6)}`);
      used += n;
    };

    if (scene.kind === "card") {
      const card = await sharp(Buffer.from(cardSvg(OUT_W, OUT_H, brand, scene.eyebrow, scene.title, scene.subtitle))).png().toBuffer();
      await emit(await finish(sharp(card)), total);
    } else {
      const { width: W, height: H } = scene.frame;
      const base = await sharp(artifactPath(projectDir, scene.shot)).ensureAlpha().raw().toBuffer();
      const raw = { raw: { width: W, height: H, channels: 4 as const } };
      const full: Rect = { x: 0, y: 0, width: W, height: H };
      const target = scene.crop ?? full;
      const layer = async (alpha: number) =>
        alpha <= 0 || scene.annotations.length === 0
          ? sharp(base, raw).png().toBuffer()
          : sharp(base, raw).composite([{ input: Buffer.from(overlaySvg(scene.annotations, scene.frame, brand, scale, alpha)) }]).png().toBuffer();
      const view = async (img: Buffer, r: Rect) =>
        finish(
          sharp(img)
            .extract({ left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
            // "fill": the view rect is already 16:9, so never crop beyond what was asked for.
            .resize(OUT_W, OUT_H, { kernel: "lanczos3", fit: "fill" }),
        );

      // Hold the full frame while the incoming transition plays, then zoom, then fade the highlight in.
      const startF = frames(transitionMs * 0.6);
      const zoomF = scene.crop ? frames(ZOOM_MS) : 0;
      const fadeF = scene.annotations.length ? frames(FADE_MS) : 0;
      const plain = await layer(0);
      await emit(await view(plain, full), Math.max(1, startF));
      for (let i = 1; i <= zoomF; i++) await emit(await view(plain, lerpRect(full, target, ease(i / zoomF))), 1);
      for (let i = 1; i <= fadeF; i++) await emit(await view(await layer(i / fadeF), target), 1);
      const hold = await view(await layer(1), target);
      await emit(hold, Math.max(1, total - used));
    }
    // The concat demuxer ignores the last entry's duration unless the file is repeated.
    list.push(list.at(-2)!);
    await writeFile(join(work, "list.ffconcat"), list.join("\n") + "\n");
    const tmpOut = join(work, "segment.mp4");
    await ffmpeg([
      "-f", "concat", "-safe", "0", "-i", join(work, "list.ffconcat"),
      "-vf", `fps=${FPS},format=${ENCODER.pixFmt}`,
      "-frames:v", String(total),
      "-c:v", ENCODER.codec, "-preset", ENCODER.preset, "-crf", String(ENCODER.crf), "-tune", "stillimage",
      "-r", String(FPS), "-an", tmpOut,
    ]);
    await rename(tmpOut, file);
    return { file, cached: false, hash };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
