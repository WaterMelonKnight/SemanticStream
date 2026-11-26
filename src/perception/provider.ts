import type {
  DetectionRequest,
  DetectionResponse,
  FromDetectorWorker,
  ToDetectorWorker,
} from './types';

export interface DetectorModelSpec {
  readonly id: string;
  readonly version: string;
  readonly wasmUrl: string;
  readonly modelUrl: string;
  readonly scoreThreshold: number;
  readonly maxResults: number;
}

export interface DetectorLoadResult {
  readonly loadMs: number;
  readonly modelBytes: number;
}

export interface DetectorProviderEvents {
  readonly onStatus?: (message: string) => void;
  readonly onDownload?: (loadedBytes: number, totalBytes: number) => void;
}

/**
 * Model-agnostic detector provider boundary. The browser implementation can be
 * MediaPipe, ONNX Runtime Web, or a local classifier without changing the
 * capture, scheduling, observation, or benchmark layers.
 */
export interface ObjectDetectorProvider {
  readonly id: string;
  readonly version: string;
  load(spec: DetectorModelSpec, events?: DetectorProviderEvents): Promise<DetectorLoadResult>;
  detect(request: DetectionRequest, pixels: ArrayBuffer): Promise<DetectionResponse>;
  dispose(): void;
}

export class MediaPipeObjectDetectorProvider implements ObjectDetectorProvider {
  readonly id: string;
  readonly version: string;
  private worker: Worker | undefined;
  private loadResolve: ((result: DetectorLoadResult) => void) | undefined;
  private loadReject: ((error: Error) => void) | undefined;
  private detectResolve: ((result: DetectionResponse) => void) | undefined;
  private detectReject: ((error: Error) => void) | undefined;
  private loadEvents: DetectorProviderEvents | undefined;
  private disposed = false;

  constructor(id: string, version: string) {
    this.id = id;
    this.version = version;
  }

  load(spec: DetectorModelSpec, events?: DetectorProviderEvents): Promise<DetectorLoadResult> {
    if (this.disposed) return Promise.reject(new Error('Detector provider is disposed.'));
    if (this.worker) return Promise.reject(new Error('Detector provider is already loading or ready.'));
    this.loadEvents = events;
    const worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<FromDetectorWorker>) => this.handle(event.data);
    worker.onerror = (event) => {
      const message = event.message || 'Detector worker failed.';
      const error = new Error(message);
      this.failLoad(error);
      this.failDetect(error);
    };
    return new Promise<DetectorLoadResult>((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
      const message: ToDetectorWorker = {
        type: 'load',
        wasmUrl: spec.wasmUrl,
        modelUrl: spec.modelUrl,
        scoreThreshold: spec.scoreThreshold,
        maxResults: spec.maxResults,
      };
      worker.postMessage(message);
    });
  }

  detect(request: DetectionRequest, pixels: ArrayBuffer): Promise<DetectionResponse> {
    if (!this.worker || this.disposed) return Promise.reject(new Error('Detector provider is not loaded.'));
    if (this.detectResolve) return Promise.reject(new Error('Detector provider already has an in-flight request.'));
    return new Promise<DetectionResponse>((resolve, reject) => {
      this.detectResolve = resolve;
      this.detectReject = reject;
      const message: ToDetectorWorker = { type: 'detect', request, pixels };
      this.worker?.postMessage(message, [pixels]);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      const message: ToDetectorWorker = { type: 'unload' };
      worker.postMessage(message);
      worker.terminate();
    }
    this.failLoad(new Error('Detector provider was disposed.'));
    this.failDetect(new Error('Detector provider was disposed.'));
  }

  private handle(message: FromDetectorWorker): void {
    if (message.type === 'loading') {
      this.loadEvents?.onStatus?.(message.message);
      return;
    }
    if (message.type === 'download') {
      this.loadEvents?.onDownload?.(message.loadedBytes, message.totalBytes);
      return;
    }
    if (message.type === 'ready') {
      const resolve = this.loadResolve;
      this.loadResolve = undefined;
      this.loadReject = undefined;
      resolve?.({ loadMs: message.loadMs, modelBytes: message.modelBytes });
      return;
    }
    if (message.type === 'error') {
      const error = new Error(message.message);
      if (message.phase === 'detect') this.failDetect(error);
      else this.failLoad(error);
      return;
    }
    if (message.type === 'detections') {
      const resolve = this.detectResolve;
      this.detectResolve = undefined;
      this.detectReject = undefined;
      resolve?.(message);
    }
  }

  private failLoad(error: Error): void {
    const reject = this.loadReject;
    this.loadResolve = undefined;
    this.loadReject = undefined;
    reject?.(error);
  }

  private failDetect(error: Error): void {
    const reject = this.detectReject;
    this.detectResolve = undefined;
    this.detectReject = undefined;
    reject?.(error);
  }
}
