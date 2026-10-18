import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Flow, ProjectConfig } from "../project/schema.js";
import { walkthroughHome } from "../project/store.js";
import { installGuards, type GuardEvents } from "./guards.js";

/** Browser adapter boundary: everything above this module talks to a Page plus guard events. */
export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  events: GuardEvents;
  headless: boolean;
  close(): Promise<void>;
}

export function profileDir(name: string): string {
  return join(walkthroughHome(), "profiles", name);
}

export async function openSession(project: ProjectConfig, flow: Flow, opts: { headed?: boolean }): Promise<BrowserSession> {
  const headless = !opts.headed;
  // A persistent profile keeps a manual sign-in between runs. It lives outside the project.
  const context = await chromium.launchPersistentContext(profileDir(project.browserProfile), {
    channel: process.env.WALKTHROUGH_BROWSER_CHANNEL ?? "chrome",
    headless,
    viewport: { width: project.viewport.width, height: project.viewport.height },
    deviceScaleFactor: project.viewport.deviceScaleFactor,
    reducedMotion: "reduce",
    colorScheme: "light",
    locale: project.language === "en" ? "en-US" : project.language,
  });
  // esbuild-based runners (tsx, vitest) wrap named functions in __name(); define it so page.evaluate bodies run.
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = context.pages()[0] ?? (await context.newPage());
  const events = await installGuards(context, page, flow);
  return { context, page, events, headless, close: () => context.close() };
}
