# Bundled model

`yolox_nano.tflite` is `litert-community/yolox-nano-litert` (Megvii YOLOX-Nano, FP16, 416x416, COCO), Apache-2.0.

- Source: https://huggingface.co/litert-community/yolox-nano-litert (file `yolox_nano.tflite`)
- Size: 2,236,912 bytes
- SHA-256: `3a621c40141760da2435891093616e4d8cfa8748000c72ced4e536d694f970e4` (matches the hash Hugging Face publishes)
- Input `[1,416,416,3]` NHWC, BGR, 0-255, gray-114 letterbox. Output `[1,3549,85]` raw heads, decoded on the host (`YoloxDecoder.java`, reference `app/src/core/decode.ts`).
- Downloaded 2026-10-24 with the user's approval. The model is COCO-trained (AP 25.8 FP32 reference): expect misses on small, distant, dark or occluded vehicles. It is not validated for this use.

Licence text: https://www.apache.org/licenses/LICENSE-2.0
