/// <reference lib="webworker" />

import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import type {
  FromDetectorWorker,
  ToDetectorWorker,
  WorkerDetection,
} from './types';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let detector: ObjectDetector | undefined;
let loading = false;

function post(message: FromDetectorWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readModel(
  url: string,
): Promise<{ bytes: Uint8Array; loadedBytes: number; totalBytes: number }> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Model download failed with HTTP ${response.status}.`);
  const totalBytes = Number(response.headers.get('content-length')) || 0;
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    post({ type: 'download', loadedBytes: buffer.byteLength, totalBytes: totalBytes || buffer.byteLength });
    return { bytes: buffer, loadedBytes: buffer.byteLength, totalBytes: totalBytes || buffer.byteLength };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  let lastProgressAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loadedBytes += value.byteLength;
    const now = performance.now();
    if (now - lastProgressAt > 250) {
      lastProgressAt = now;
      post({ type: 'download', loadedBytes, totalBytes: totalBytes || 0 });
    }
  }
  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  post({ type: 'download', loadedBytes, totalBytes: totalBytes || loadedBytes });
  return { bytes, loadedBytes, totalBytes: totalBytes || loadedBytes };
}

async function load(message: Extract<ToDetectorWorker, { type: 'load' }>): Promise<void> {
  if (detector || loading) return;
  loading = true;
  const startedAt = performance.now();
  try {
    post({ type: 'loading', message: 'Downloading EfficientDet-Lite0 model…' });
    const model = await readModel(message.modelUrl);
    post({ type: 'loading', message: 'Starting MediaPipe Wasm runtime…' });
    const fileset = await FilesetResolver.forVisionTasks(message.wasmUrl, true);
    detector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model.bytes, delegate: 'CPU' },
      runningMode: 'IMAGE',
      scoreThreshold: message.scoreThreshold,
      maxResults: message.maxResults,
    });
    post({ type: 'ready', loadMs: performance.now() - startedAt, modelBytes: model.loadedBytes });
  } catch (error) {
    detector?.close();
    detector = undefined;
    post({ type: 'error', phase: 'load', message: errorMessage(error) });
  } finally {
    loading = false;
  }
}

function detect(
  message: Extract<ToDetectorWorker, { type: 'detect' }>,
): void {
  if (!detector) {
    post({ type: 'error', phase: 'detect', message: 'Detector is not loaded.' });
    return;
  }
  try {
    const image = new ImageData(new Uint8ClampedArray(message.pixels), message.request.width, message.request.height);
    const startedAt = performance.now();
    const result = detector.detect(image);
    const inferenceMs = performance.now() - startedAt;
    const detections: WorkerDetection[] = [];
    for (const detection of result.detections) {
      const box = detection.boundingBox;
      const category = detection.categories[0];
      if (!box || !category) continue;
      detections.push({
        categoryId: category.index,
        categoryName: category.categoryName || category.displayName || 'object',
        score: category.score,
        box: { x: box.originX, y: box.originY, width: box.width, height: box.height },
      });
    }
    post({
      type: 'detections',
      requestId: message.request.requestId,
      sessionId: message.request.sessionId,
      frameSequence: message.request.frameSequence,
      inferenceMs,
      detections,
    });
  } catch (error) {
    post({ type: 'error', phase: 'detect', message: errorMessage(error) });
  }
}

scope.onmessage = (event: MessageEvent<ToDetectorWorker>) => {
  const message = event.data;
  if (message.type === 'load') {
    void load(message);
    return;
  }
  if (message.type === 'detect') {
    detect(message);
    return;
  }
  if (message.type === 'unload') {
    detector?.close();
    detector = undefined;
    post({ type: 'unloaded' });
  }
};
