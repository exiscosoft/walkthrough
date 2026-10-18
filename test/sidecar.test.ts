import { mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpeechProcess } from "../src/speech/sidecar.js";

const ROOT = resolve("test/.tmp/sidecar");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, ".venvs", "chatterbox", "bin"), { recursive: true });
  await symlink(resolve("test/stub-speech/python"), join(ROOT, ".venvs", "chatterbox", "bin", "python"));
  process.env.WALKTHROUGH_SPEECH_DIR = ROOT;
});

afterAll(() => {
  delete process.env.STUB_HANG_ON_SYNTH;
});

describe("speech sidecar", () => {
  it.each([false, true])("a timed-out request kills the engine process (timed under /usr/bin/time: %s)", async (timed) => {
    process.env.STUB_HANG_ON_SYNTH = "1";
    const proc = SpeechProcess.spawn("chatterbox", { timed });
    const load = await proc.request<{ info: { pid: number } }>({ cmd: "load", engine: "chatterbox" });
    const pid = load.info.pid;
    expect(alive(pid)).toBe(true);
    await expect(proc.request({ cmd: "synthesize", text: "Hello.", out: "/dev/null" }, 300)).rejects.toMatchObject({ code: "SPEECH_TIMEOUT" });
    await proc.close();
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });
});
