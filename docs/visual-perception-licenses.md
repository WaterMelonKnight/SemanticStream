# Visual perception — runtime and model licenses

Checked 2026-11-26. This document records what was actually installed/downloaded for Phase 4P.1. It is not legal advice.

## Runtime

| Component | Version | License | Size / source | Deployment notes |
| --- | --- | --- | --- | --- |
| `@mediapipe/tasks-vision` | 1.2.3 | **Apache-2.0** | npm package unpacked size **31,398,574 bytes**; `vision_bundle.mjs` 155,990 bytes | npm metadata and `package.json` declare Apache-2.0; source files carry Apache-2.0 headers. The package tarball has no standalone `LICENSE` file. The upstream `google-ai-edge/mediapipe` repository license is confirmed Apache-2.0 via the GitHub license API. Keep the Apache-2.0 notice with redistributed runtime files. |
| MediaPipe Wasm module | 1.2.3 package assets | Apache-2.0 (same package) | `vision_wasm_module_internal.wasm` **14,665,738 bytes**; internal JS **336,662 bytes**. The build ships only the module variant because the detector runs in a module worker. | Self-hosted from `node_modules` by `scripts/prepare-mediapipe-wasm.mjs` into `public/mediapipe/wasm/1.2.3` (ignored by git, copied by `predev`/`prebuild`). The page loads the ES module variant in the worker. |

Source / metadata:

- https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.2.3
- https://github.com/google-ai-edge/mediapipe
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0

## Model weights

| Model | Version/URL | File size | Observed metadata | License status |
| --- | --- | --- | --- | --- |
| EfficientDet-Lite0 int8 | `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite` | **4,602,795 bytes** | HTTP `Last-Modified: 2023-04-27`; served as `application/octet-stream`; no standalone license file in the downloaded bundle | The MediaPipe project and runtime are confirmed **Apache-2.0** (GitHub license API). The model file itself carries no separate license/NOTICE payload, so this experiment **does not assert a separate weight license** and does **not redistribute** the weights. It downloads them at runtime from the official URL. Confirm model-weight redistribution terms with the vendor before bundling or mirroring. |
| EfficientDet-Lite0 float16 | same catalog, `float16/1` | 7,254,339 bytes | same date | same caveat |
| EfficientDet-Lite0 float32 | same catalog, `float32/1` | 13,836,895 bytes | same date | same caveat |

The int8 variant was selected for the smallest download and CPU/Wasm inference. The page reports the actual downloaded byte count and load time at runtime.

Catalog entry point: https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector

## Deployment limits

- The runtime Wasm is served same-origin under the versioned `mediapipe/wasm/1.2.3/` path. The Node gateway serves `.wasm` with `application/wasm` and applies the perception-only CSP; the static build includes `public/_headers` with the page CSP and a version-scoped immutable cache. The header file deliberately does not override MIME for the whole directory, so JavaScript and Wasm keep their native types. A strict CSP needs `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, and `connect-src 'self' https://storage.googleapis.com` (the last only for model download). Test the final CSP in the deployment host.
- The model is fetched from `https://storage.googleapis.com` when the user enables detection. If the deployment must be offline, download the model and change `EFFICIENTDET_MODEL_URL` to a same-origin path **only after confirming redistribution rights** and retaining the model's source/version record. A strict `connect-src` must then allow the chosen origin.
- Camera requires a secure context (HTTPS or localhost) and a `Permissions-Policy` that allows camera for the page.
- The worker is a module worker bundled by Vite. No cross-origin isolation is required for the CPU/Wasm path.
- The browser must support WebAssembly, module Workers, Canvas `ImageData`, and `PerformanceObserver` (the last is optional for diagnostics).

## YOLOX-Nano + ONNX Runtime Web feasibility

Not implemented in this phase. Findings:

- **ONNX Runtime Web** npm metadata: `onnxruntime-web` 1.31.1, **MIT**, unpacked **150,622,959 bytes**. It provides WASM/WebGPU/WebGL execution providers; the built assets add deployment size and backend-selection complexity.
- **YOLOX** code is Apache-2.0 (Megvii-BaseDetection/YOLOX; confirmed via GitHub license API). The official Nano checkpoint/weights license and an official ONNX file size were **not verified** in this environment. Do not claim a weight size or license until the exact release artifact is inspected.
- Integration requires custom preprocessing, anchor-free decode, class handling, and NMS; MediaPipe provides these in the task graph. YOLOX would be more code and a larger runtime surface for this experiment.
- MediaPipe won the first implementation because it gave a small int8 model, built-in preprocessing/NMS, a stable JS provider API, and a working module-worker path in the tested Chromium build.

References:

- https://github.com/Megvii-BaseDetection/YOLOX
- https://www.npmjs.com/package/onnxruntime-web
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
- MIT License: https://opensource.org/license/mit

## What is not done

- No model weights are committed to this repository.
- No remote inference API, paid service, account, training, or fine-tuning.
- No accuracy claim: there is no labeled evaluation set in this phase.
- No real iPhone/Android device test was performed; headless Chromium on the development host is the only browser verification.
