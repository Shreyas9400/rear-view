# E1 — LiteRT.js + YOLOX-nano probe (throwaway, not part of the app)

Answers: does `litert-community/yolox-nano-litert` run through `@litertjs/core` on the target phone, on which accelerator, how fast. Plan: `docs/IMPLEMENTATION_PLAN.md` M4. Results: `results/*.json`, summary in `docs/DEVICE_COMPATIBILITY.md` §3 and `docs/TECHNICAL_DECISIONS.md` D-020.

Downloaded files (not committed, re-fetch to reproduce; hashes are the ones Hugging Face publishes):

| File | Source | Size | SHA-256 |
| --- | --- | --- | --- |
| `models/yolox_nano.tflite` | `https://huggingface.co/litert-community/yolox-nano-litert` (Apache-2.0) | 2,236,912 | `3a621c40141760da2435891093616e4d8cfa8748000c72ced4e536d694f970e4` |
| `public/sample.png` | same repo, `samples/sample.png` | 1,441,179 | `9739a17cf8300684d0211bd0b910387e2e04e31fd87b358331d5c22240a38324` |
| `@litertjs/core` 2.6.0 (Apache-2.0) | npm, installed exactly with `npm install @litertjs/core@2.6.0 --save-exact` | ~47 MB unpacked | — |

Reproduce (from this folder):

1. `npm install`; put the two files above in `models/` and `public/`.
2. Copy `node_modules/@litertjs/core/wasm/*` to `public/wasm/` and the model to `public/models/`.
3. `../../node_modules/.bin/vite build`
4. `node server.mjs 8099` (serves `dist/`, sets COOP/COEP headers, `POST /log` writes `results/*.json`).
5. `adb reverse tcp:8099 tcp:8099`, open `http://localhost:8099/?auto=1` in the phone's Chrome. Optional `&trials=wasm,wasm%2Bthreads` (quote the URL for the device shell).

The sample image shows pedestrians and no vehicles, so it checks the model and decode plumbing but **not** vehicle detection quality.
