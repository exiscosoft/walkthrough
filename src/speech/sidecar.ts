import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WalkError } from "../util.js";

export type EngineName = "chatterbox" | "f5-mlx" | "mlx-audio" | "align";

const VENV: Record<EngineName, string> = { chatterbox: "chatterbox", "f5-mlx": "f5", "mlx-audio": "mlxaudio", align: "align" };

export function speechDir(): string {
  return process.env.WALKTHROUGH_SPEECH_DIR ?? fileURLToPath(new URL("../../speech", import.meta.url));
}

export function enginePython(engine: EngineName): string {
  const py = join(speechDir(), ".venvs", VENV[engine], "bin", "python");
  if (!existsSync(py)) {
    throw new WalkError(
      "SPEECH_ENGINE_NOT_INSTALLED",
      `Speech engine "${engine}" is not installed`,
      `Run \`${join(speechDir(), "setup.sh")} ${VENV[engine]}\`, or use the import engine with your own recordings.`,
    );
  }
  return py;
}

export function engineInstalled(engine: EngineName): boolean {
  return existsSync(join(speechDir(), ".venvs", VENV[engine], "bin", "python"));
}

export interface ProcessStats {
  maxRssBytes?: number;
  peakFootprintBytes?: number;
}

// Sidecars run in their own process group, so a Ctrl-C at the terminal doesn't reach them.
// Kill any that are still alive when the CLI exits or is interrupted.
const live = new Set<SpeechProcess>();
let exitHooks = false;
function installExitHooks(): void {
  if (exitHooks) return;
  exitHooks = true;
  process.on("exit", () => live.forEach((p) => p.kill()));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      live.forEach((p) => p.kill());
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/**
 * One sidecar process. Spawned per stage and closed afterwards so model memory
 * is returned to the OS before the next stage starts.
 */
export class SpeechProcess {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderrTail: string[] = [];
  private exited: Promise<{ code: number | null; stats: ProcessStats }>;

  private constructor(private child: ChildProcess, timed: boolean, onLog?: (line: string) => void) {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg);
      else waiter.reject(new WalkError("SPEECH_ENGINE_ERROR", msg.error, this.tail()));
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      onLog?.(line);
    });
    live.add(this);
    installExitHooks();
    this.exited = new Promise((resolve) => {
      child.on("exit", (code) => {
        live.delete(this);
        for (const w of this.pending.values()) {
          w.reject(new WalkError("SPEECH_PROCESS_EXITED", `Speech process exited (code ${code}) mid-request`, this.tail()));
        }
        this.pending.clear();
        resolve({ code, stats: timed ? parseTimeL(this.stderrTail.join("\n")) : {} });
      });
    });
  }

  private tail(): string {
    return this.stderrTail.slice(-8).join("\n");
  }

  /** `timed` runs under /usr/bin/time -l so peak RSS and footprint are reported by the kernel. */
  static spawn(engine: EngineName, opts: { timed?: boolean; onLog?: (line: string) => void } = {}): SpeechProcess {
    const py = enginePython(engine);
    const args = ["-m", "walkthrough_speech"];
    // Own process group, so kill() reaches the Python process even when /usr/bin/time wraps it.
    const spawnOpts = { cwd: speechDir(), stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], detached: true };
    const child = opts.timed ? spawn("/usr/bin/time", ["-l", py, ...args], spawnOpts) : spawn(py, args, spawnOpts);
    return new SpeechProcess(child, Boolean(opts.timed), opts.onLog);
  }

  /** A timed-out request kills the process: a model stuck in swap is a failure, not a wait. */
  request<T = any>(payload: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            this.kill();
            reject(new WalkError("SPEECH_TIMEOUT", `Speech ${String(payload.cmd)} exceeded ${Math.round(timeoutMs / 1000)}s`, this.tail()));
          }, timeoutMs)
        : undefined;
      const done = <V>(f: (v: V) => void) => (v: V) => {
        clearTimeout(timer);
        f(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.child.stdin!.write(JSON.stringify({ ...payload, id }) + "\n");
    });
  }

  async close(): Promise<{ code: number | null; stats: ProcessStats }> {
    if (this.child.exitCode === null) this.child.stdin!.end(JSON.stringify({ cmd: "exit" }) + "\n");
    return this.exited;
  }

  kill(): void {
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }
}

/** Parse macOS `/usr/bin/time -l` output. */
export function parseTimeL(text: string): ProcessStats {
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  return {
    maxRssBytes: num(/^\s*(\d+)\s+maximum resident set size/m),
    peakFootprintBytes: num(/^\s*(\d+)\s+peak memory footprint/m),
  };
}

export interface SynthResult {
  durationMs: number;
  wallMs: number;
  segments: { text: string; startMs: number; endMs: number }[];
  sampleRate: number;
}

export interface AlignResult {
  text: string;
  words: { word: string; startMs: number; endMs: number }[];
  wallMs: number;
}
