# ACCOUNT_MIGRATION — continuing this project from another Claude account

The repository is the single source of truth. Nothing about the project state lives only in a chat, a Claude account or a connector. A new account (or a new session on the same account) continues by reading the repo, not the conversation history. Last updated 2026-10-23. Items marked **[Q]** are platform behaviours I could not verify; check the current Claude Code documentation or `read_documentation` in the session.

## 1. What transfers automatically (it is in the repo)

| Item | Where |
| --- | --- |
| Permanent rules and non-negotiable constraints | `CLAUDE.md` (read automatically at session start) |
| Current verified position and next tasks | `docs/SESSION_HANDOFF.md` |
| Design, protocol, decisions, tests, security, device plan | `docs/*.md` |
| Code and unit tests (52 passing at the time of writing) | `app/` |
| CI definition (APK build, never yet run) | `.github/workflows/android-debug.yml` |

## 2. What does NOT transfer (re-create or re-supply)

| Item | Why | What to do |
| --- | --- | --- |
| Chat history and reasoning | Per-account, not in the repo | Not needed; the docs replace it |
| The earlier Claude Docs planning document (sections 1–11, link shared in the original chat) | Owned by the original account | The repo docs supersede it. If you want the earlier research, ask the original account to share or export it, and treat it as background only |
| GitHub access for the new account | Tied to the GitHub identity connected to that Claude account | Section 3 |
| Environment settings (network allow-list, setup script, secrets) | Per environment | Section 4 |
| Connectors / MCP servers (Firecrawl, Google Drive, etc.) | Per account | Reconnect only if needed; the project does not depend on any |
| User-level memory / personal settings | Per account | Not required; project rules are in `CLAUDE.md` |
| Physical-device facts (phone model, WebView, hotspot behaviour) | Not discovered yet | Collect per `docs/DEVICE_COMPATIBILITY.md` |
| Secrets | **None exist.** The project has no API keys and must not get any | Never commit credentials |

## 3. Give the new account access to the repository

Pick the option that matches how the two accounts relate to GitHub.

1. **Same GitHub user, different Claude account (simplest).** Connect that GitHub user in the new Claude account (Claude's "connect GitHub" step) and make sure the Claude GitHub App is installed on `Shreyas9400/driver-assistance` (or on all repositories of that user). Then start a new Claude Code session and select the repo **[Q: exact UI labels]**.
2. **Different GitHub user.** The GitHub owner invites that user as a collaborator with **write** access (Settings → Collaborators), or transfers the repository (Settings → Danger Zone → Transfer), or the new user forks it. If the repo is transferred, update the `origin` URL in any local clone (`git remote set-url origin <new url>`), and install the Claude GitHub App on the new location.
3. **Local clone (no web session).** `git clone https://github.com/Shreyas9400/driver-assistance`, `cd` into it and run Claude Code there. Needs Node 22, npm, and JDK 21 plus an Android SDK for APK builds.

A repository transfer or visibility change is a decision for the owner; do not do it from a Claude session without explicit instruction.

## 4. Re-create the environment (cloud sessions)

**[Q] — verify against the current environment documentation before relying on this list.**

- **Tools needed:** Node 22 and npm (tests and web build need only these); JDK 21, Android SDK platform 36 and build tools (APK builds); `adb` (device inventory over USB; only possible when the phone is attached to the machine running the session, which a cloud session cannot do).
- **Network access (if the environment restricts outbound hosts), typical hosts to allow:** `github.com`, `registry.npmjs.org`, `huggingface.co` (model download for experiment E1), `services.gradle.org`, `plugins.gradle.org`, `repo.maven.apache.org`, `dl.google.com`, `maven.google.com`. These are expectations based on the toolchain, not verified lists.
- **Setup script idea:** install dependencies with `cd app && npm ci`. Do not run it until you want to; it needs network.
- **Practical split:** cloud sessions are good for the laptop-testable code (`app/src/core`, protocol logic, docs). Anything that needs the phone (M1, M4–M7, M9, M12) needs you to run commands on the phone/laptop and paste the results back, or to run Claude Code locally with the phone on USB.

## 5. First prompt for the new account's first session

Copy this as the first message in the new session:

```
This is a continuing project. Do not rely on any prior conversation.
Start by following the "Session start checklist" in CLAUDE.md:
read CLAUDE.md, docs/SESSION_HANDOFF.md, docs/ARCHITECTURE.md and docs/ACCOUNT_MIGRATION.md,
then inspect git (branch, status, last 10 commits) and run: cd app && npm ci && npm test.
Report: (1) the branch and latest commit, (2) whether the test count matches the handoff,
(3) any discrepancy between the docs and the code, (4) the first task from the handoff's
"Next-session instructions". Do not push, merge or deploy without my explicit approval.
```

## 6. Verification checklist for the first session on the new account

- [ ] `git log --oneline -10` shows the same history as the handoff describes (baseline `00d3191`, Phase 0 docs, Phase 1 core).
- [ ] `cd app && npm ci && npm test` passes (52 tests when this file was written; if the number differs, trust the code and update the handoff).
- [ ] `npx tsc --noEmit` is clean.
- [ ] The handoff's "unverified" list is still unverified (APK build, CI, device, real-model output). Do not assume any of it succeeded.
- [ ] Open items from the handoff §7 are confirmed with the user before starting.

## 7. Working agreements across accounts

- **One writer at a time.** Two sessions editing the same branch cause conflicts. Agree who is active; the other waits or works on a separate branch.
- **Branches and PRs.** Work on a branch, keep `main` working (tests passing). Merge to `main` only when the user asks. Avoid force-pushes and history rewrites.
- **No secrets, no personal data.** Do not paste tokens, passwords, hotspot passphrases or video frames into the repo, issues or docs. Do not commit APKs, model weights, recordings or `node_modules`.
- **Docs are part of the change.** Every substantial session ends by updating `docs/SESSION_HANDOFF.md`, the decision register for any design change, and the results table for any real test (`CLAUDE.md`).
- **Hash hygiene.** A file cannot contain its own commit hash; handoff files say "run `git log`".

## 8. Handing off from the current account (do this before switching)

1. Commit everything that should survive; push the branch (`git push -u origin <branch>`).
2. Make sure `docs/SESSION_HANDOFF.md` is current: status, test results with counts, what is unverified, and the next 3–5 tasks with acceptance criteria.
3. Record any decision made in chat but not in the repo in `docs/TECHNICAL_DECISIONS.md`.
4. Record pending user answers (for example approval to download model weights, or the phone details) in the handoff.
5. Tell the new session where the code lives (branch name) in the first prompt above.

## 9. If something does not match

If the docs and the code disagree, or the handoff claims something the tests do not show, say so explicitly and fix whichever is wrong (code or docs with a note). Never silently pick one (`CLAUDE.md` rule 3 of the session start checklist).
