# Smart Rear-View Assistant (driver-assistance)

An **experimental, privacy-first** rear-view assistant built from two phones:

- an old **Android phone** mounted in the rear window: captures video, runs a lightweight vehicle detector locally, tracks vehicles, and serves a local stream;
- an **iPhone** acting as the viewer in Safari (nothing to install) over a local Wi-Fi hotspot.

> **Not a safety system.** This is a research prototype. It is not certified, not validated, and must not be relied on for driving decisions. The absence of a warning never means the road is clear.

## Status

**Phase 1 in progress.** Pure-logic modules (decode, tracker, approach estimator, alert state machine) exist with passing unit tests; no camera, inference runtime, server or viewer yet. Current verified position: `docs/SESSION_HANDOFF.md`.

Run the tests: `cd app && npm install && npm test`.

## Key properties

- Local-first: detection on-device, no cloud, no video upload, no recording by default.
- Local network only (hotspot, no internet needed). Plain HTTP with token auth — see `docs/SECURITY_AND_PRIVACY.md` for the limits.
- Experimental approach indication from bounding-box growth. Gyro/accelerometer are logged only in the MVP.

## Documentation map

| Document | Purpose |
| --- | --- |
| `CLAUDE.md` | Permanent rules for every Claude session |
| `docs/SESSION_HANDOFF.md` | Current verified state and next tasks (read first) |
| `docs/ARCHITECTURE.md` | System design, components, data flow, constraints |
| `docs/IMPLEMENTATION_PLAN.md` | Milestones, gates G0–G4, fallbacks |
| `docs/TECHNICAL_DECISIONS.md` | Decision register |
| `docs/PROTOCOL_SPEC.md` | HTTP/WebSocket contracts |
| `docs/TESTING_AND_VALIDATION.md` | Test plan, acceptance criteria, results table |
| `docs/SECURITY_AND_PRIVACY.md` | Threat model, privacy, retention |
| `docs/DEVICE_COMPATIBILITY.md` | What to discover on the real phone; compatibility matrix |
| `docs/TROUBLESHOOTING.md` | Failure diagnosis |
| `docs/ACCOUNT_MIGRATION.md` | Continuing from another Claude account or machine |

## Development

Development is incremental across Claude sessions. Start with `CLAUDE.md`. Do not begin implementation until the Phase 0 documentation has been reviewed and approved.
