# AGENTS.md — Smart Rear-View Assistant

Permanent instructions for every Codex session in this repository. Keep this file short; details live in `docs/`.

## What this project is

An experimental, privacy-first rear-view assistant. An old **Android phone** mounted in the rear window captures video, runs a lightweight vehicle detector **locally**, tracks vehicles, raises an experimental "possible approach" indication, and streams video plus boxes over a **local Wi-Fi hotspot** to an **iPhone Safari** viewer. It is a research prototype, **not** a certified or validated safety system.

## Session start checklist (do this before changing anything)

1. Read, in order: `AGENTS.md`, `docs/SESSION_HANDOFF.md`, `docs/ARCHITECTURE.md`, then the documents relevant to your task (`docs/IMPLEMENTATION_PLAN.md`, `docs/PROTOCOL_SPEC.md`, `docs/TESTING_AND_VALIDATION.md`, `docs/SECURITY_AND_PRIVACY.md`, `docs/DEVICE_COMPATIBILITY.md`, `docs/TECHNICAL_DECISIONS.md`, `docs/TROUBLESHOOTING.md`).
2. Inspect the real state: `git status`, `git branch --show-current` (may be detached), `git log --oneline -10`, `git diff --stat`. Do not rely on the handoff's recorded hashes.
3. Treat the **code and executed tests as evidence of actual state**. Documentation states intent. If they disagree, say so, then fix whichever is wrong (code, or docs with a note) — do not silently pick one.
4. Do not assume a planned task succeeded because it was planned. Re-verify before building on it.

## Working rules

- Preserve the existing architecture and module contracts (`docs/ARCHITECTURE.md`, `docs/PROTOCOL_SPEC.md`) unless you document a justified change in `docs/TECHNICAL_DECISIONS.md` (mark the old decision *superseded*, never delete it).
- Do not reimplement features that already exist; search the code first.
- Never overwrite unrelated work or discard uncommitted changes (no `git reset --hard`, `git checkout .`, `git clean`, force-push) without explicit approval.
- Run the relevant tests after each change; record real results in `docs/TESTING_AND_VALIDATION.md`. Never invent results, hashes or device measurements.
- Never claim a feature, milestone or test is complete unless you verified it. Use the status vocabulary in `docs/SESSION_HANDOFF.md`.
- Update docs whenever architecture, interfaces, dependencies or behaviour change (maintenance rules: `docs/ARCHITECTURE.md` §H).
- At the end of every substantial session, update `docs/SESSION_HANDOFF.md`.
- **Never push, merge, deploy, publish, open PRs, or provision external infrastructure without explicit user approval.** Commit only when asked.

## Non-negotiable constraints

- **Local-first.** All detection runs on the rear phone. No cloud inference.
- **No cloud video upload.** No analytics SDKs. No data leaves the two phones.
- **No unnecessary video recording.** No recording by default; diagnostic clips are explicit opt-in, local, auto-deleted (`docs/SECURITY_AND_PRIVACY.md`).
- **Roles:** rear Android phone = capture + detection + server; iPhone Safari = initial viewer (no iPhone install).
- **Transport:** local Wi-Fi/hotspot only. No internet required.
- **Approach detection is experimental.** Bounding-box growth heuristic only; time-to-contact is a trend, not a prediction.
- **Gyroscope/accelerometer are logged only in the MVP.** Gyro-based conflict prediction is deferred.
- **Security and stale-feed detection are mandatory** (token auth, bound interfaces, bounded queues, stale/lost indicators). The plain-HTTP limitation is acknowledged, not hidden.
- **UI must never imply that "no warning" means the road is clear.** Unavailable camera/detector/stream must be shown as unavailable.
- **Do not claim the prototype is a certified or validated safety system.** Do not test collision scenarios on public roads.

## Out of scope for the MVP (do not add without a documented decision)

WebRTC, cloud services, databases, segmentation models (SAM etc.), metric distance estimation, gyro-based collision prediction, re-identification, an iOS native app.

## Where things are

Switching Codex accounts or machines: `docs/ACCOUNT_MIGRATION.md`.

See `docs/ARCHITECTURE.md` (design, planned directory layout), `docs/IMPLEMENTATION_PLAN.md` (milestones M0–M12, gates G0–G4), `docs/SESSION_HANDOFF.md` (current verified position).
