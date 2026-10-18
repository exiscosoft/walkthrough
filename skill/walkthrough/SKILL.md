---
name: walkthrough
description: Turn a feature brief into a narrated, annotated walkthrough video of a website running in the local dev environment, using the `walkthrough` CLI (capture in Chrome, redacted screenshots, script, own-voice narration, MP4 + captions). Use when someone asks for a tutorial, walkthrough, demo or how-to video of a web feature, or wants to update or re-record one.
---

# Walkthrough videos

You drive the `walkthrough` CLI. It does the browser capture, redaction, speech and rendering; you plan the flow, write the narration from captured evidence, and guide the person through review. Never do capture, audio or video work by other means.

Run commands from the walkthrough repo (`pnpm dev <command>`, or `walkthrough <command>` if it is linked) and always pass `--json`. Each command returns `{ok, status, data, warnings, errors}`. `status: "paused"` (exit code 2) means the engine needs a person or a decision: stop and report the error `code`, `message` and `hint`. Do not work around a pause.

## Before you start: tell the person what leaves the machine

Capture, speech and rendering all run locally. When **you** read evidence screenshots and aria snapshots to plan the flow or write the script, they are sent to your model provider. They are redacted first, but say this once, plainly, before reading evidence. If the person does not want that, use the manual path: they write `flow.yaml` and the script themselves (`script draft` gives template narration built only from observed labels), and you only run commands.

## Workflow

1. **Brief → project.** Collect the objective, audience, observable outcome, start URL (the local dev app), prerequisites and demo data owner. Then run:
   `walkthrough init <name>.walkthrough --name … --objective … --audience … --outcome … --url … [--redact "<css>,<css>"] [--reset-command "<seed demo data>"]`
   Ask about customer-data fields that must always be masked, and pass them to `--redact`.

2. **Plan.** `walkthrough plan <dir> --request` writes `evidence/_plan/bundle.json` (the brief plus a redacted screenshot and accessibility snapshot of the start page). Use it to write `<dir>/flow.yaml`:
   - 5–15 steps with semantic locators: `{role, name}` or `{label}`. Use `{css}` only as a last resort.
   - Give each step an `expect` list that proves the step worked.
   - Mark any step that changes data `sideEffect: mutating`. Set `allow: true` only after the person confirms it is safe on demo data. Never allow sends, purchases, deletions or permission changes without explicit approval.
   - Mark exactly one step `outcome: true`: the one whose after-state proves the stated outcome. This is usually an `observe` step on the success message.
   - Secrets go in `testData` as `{ env: VAR, sensitive: true }`, never as literal values.
   - Use `signedOutWhen` to name what an expired session looks like, such as the login URL.
   - Use a `manual` step for sign-in, with an `expect` that shows sign-in finished (for example, the dashboard heading). Run capture `--headed` so the person can complete it. Later runs skip the step while the saved session lasts.

   Feature notes and code are context only. Nothing counts as demonstrated until capture observes it. Then run `walkthrough plan <dir>`.

3. **Capture.** `walkthrough capture <dir> [--headed]`. On a pause, report the code and stop:
   - `LOCATOR_NOT_FOUND` / `AMBIGUOUS_LOCATOR`: the UI changed. The hint lists the labels that are present. Propose a `flow.yaml` fix.
   - `UNEXPECTED_DIALOG`, `OFF_ALLOWLIST_NAVIGATION`, `CAPTCHA`, `AUTH_EXPIRED`, `MANUAL_TAKEOVER_REQUIRED`: the person decides what to do.
   - `MUTATING_ACTION_NOT_ALLOWED`: ask before setting `allow: true`.
   - `REPLAY_REQUIRES_RESET`: data-changing steps already ran. Use `--reset` if `resetCommand` is set. Otherwise ask the person to reset the demo data.
   - `EXPECTATION_FAILED` / `OUTCOME_UNVERIFIED`: the site didn't reach the expected state. Never narrate past it.

4. **Script.** Read `evidence/<step>/evidence.json` for each step: its labels, target name, URL and screenshot path. Write one or two short sentences per step that use the **exact visible labels** in double quotes. Set them with `walkthrough script set <dir> --step <id> --text "…" --source agent`.
   - Describe only what the evidence shows. Claim success only on or after the outcome step.
   - Add pronunciations for product names and acronyms with `walkthrough pronounce <dir> "SSO" "S S O"`. Captions keep the written form.
   - `walkthrough validate <dir> --json` flags ungrounded narration (`GROUNDING`) and labels that weren't observed (`LABEL_NOT_OBSERVED`). Fix both.

5. **Voice.** If the person has no approved voice, set one up:
   1. Enroll with `voice enroll --voice <id> --name … --file <clean 8–15 s recording> --confirm-own-voice`. Only enroll the person's own voice, and only after they confirm it is theirs.
   2. Generate a sample with `voice test --voice <id> --engine <engine>`.
   3. The person listens to it, then runs `voice approve`.
   4. Point the project at the voice with `voice use <dir> --engine <engine> --voice <id>`.

   Use the engine that `docs/speech-benchmark.md` recommends for this machine. If local synthesis is too slow or poor, use `voice use <dir> --engine import` and have them record `<stepId>.wav` files: `narrate <dir> --from-dir <folder>`.

   Then run `walkthrough narrate <dir>`. It only regenerates missing or stale clips.

6. **Review.** Run `walkthrough storyboard <dir>` and ask the person to open `storyboard.html`. Apply the edits they ask for:
   - Highlights: `annotate --step … --move callout:-40,0 | --remove … | --crop auto|none|x,y,w,h`.
   - Narration: `script set`, then `narrate` again.
   - Masks: `walkthrough redactions <dir>` lists them. Low-confidence masks need the person to look and confirm (`--confirm <ids>|all`).

   A watermarked draft is available any time with `walkthrough render <dir> --preview`.

7. **Approve and export.** These are the person's decisions, never yours: `approve <dir> storyboard`, `approve <dir> script`, and `approve <dir> visuals`, which confirms every frame is suitable to share. Then run `walkthrough render <dir>` and `walkthrough export <dir>`. Report the MP4, caption and package paths from the output.

## Updating an existing video

- **Narration change:** `script set`, then `narrate`, re-approve the script, then `render`. Only the changed clip and its scene are regenerated, and there's no recapture.
- **UI change:** edit the step in `flow.yaml`, `plan`, then `capture`. Steps after the changed one are marked `needs_validation` and are recaptured. Use `--reset` when data-changing steps sit in between.
- `walkthrough status <dir> --json` always gives the current stage, stale items and the next action.
