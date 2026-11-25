import type { FrameListener, StreamFrame, StreamSource } from '../core/stream';
import { context2d, drawContained } from './canvas';
import type { VisualFrame } from './source';

export type VideoCaptureMode = 'requestVideoFrameCallback' | 'animationFrame';

export type VideoPlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export type VideoResetReason = 'load' | 'seek' | 'restart';

export interface VideoSourceStatus {
  readonly state: VideoPlaybackState;
  readonly fileName: string | null;
  readonly durationMs: number | null;
  readonly mediaTimeMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly captureMode: VideoCaptureMode;
  readonly message: string;
}

export interface VideoSourceCallbacks {
  onStatus?: (status: VideoSourceStatus) => void;
  /** Fires when captured frames must not be compared with earlier frames. */
  onSessionReset?: (reason: VideoResetReason) => void;
  onError?: (message: string) => void;
}

export interface VideoSourceEnvironment {
  now: () => number;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  createObjectUrl: (file: Blob) => string;
  revokeObjectUrl: (url: string) => void;
}

export interface VideoSourceOptions {
  callbacks?: VideoSourceCallbacks;
  environment?: Partial<VideoSourceEnvironment>;
  context?: CanvasRenderingContext2D;
}

interface VideoFrameMetadataLike {
  readonly mediaTime: number;
  readonly presentedFrames?: number;
}

type VideoFrameCallback = (now: number, metadata: VideoFrameMetadataLike) => void;

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
};

const DEFAULT_ENVIRONMENT: VideoSourceEnvironment = {
  now: () => performance.now(),
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  createObjectUrl: (file) => URL.createObjectURL(file),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
};

function mediaTypeForFile(file: Pick<File, 'name' | 'type'>): string {
  if (file.type.startsWith('video/')) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? '';
}

/** Returns a user-facing reason when the browser plainly rejects a file. */
export function videoFileProblem(video: HTMLVideoElement, file: File): string | null {
  if (file.size === 0) return 'That file is empty. Choose a video that contains data.';
  const mediaType = mediaTypeForFile(file);
  if (!mediaType) {
    return 'Unsupported file type. Choose an MP4 or WebM video this browser can decode.';
  }
  if (!video.canPlayType(mediaType)) {
    return `This browser reports that it cannot play ${mediaType}. Try an MP4 (H.264/AAC) or WebM (VP8/VP9) file.`;
  }
  return null;
}

function describeMediaError(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return 'The video could not be loaded because of a network or file access error.';
    case 3:
      return 'The browser could not decode this video. Try an MP4 with H.264 video or a WebM with VP8/VP9 video.';
    case 4:
      return 'This browser cannot play this video format. Try MP4 or WebM.';
    default:
      return 'The video could not be played. Try another MP4 or WebM file.';
  }
}

/**
 * Captures presented video frames through HTMLVideoElement and a local Canvas.
 * The adapter owns the Object URL and all media listeners. Call dispose() to
 * release both; stop() only pauses capture so the same media can resume.
 */
export class VideoSource implements StreamSource<VisualFrame> {
  private readonly video: VideoElementWithFrameCallback;
  private readonly context: CanvasRenderingContext2D;
  private readonly callbacks: VideoSourceCallbacks;
  private readonly env: VideoSourceEnvironment;
  private readonly captureMode: VideoCaptureMode;
  private readonly listeners: Array<{ type: string; handler: EventListener }> = [];

  private listener: FrameListener<VisualFrame> | undefined;
  private active = false;
  private disposed = false;
  private objectUrl: string | undefined;
  private fileName: string | null = null;
  private state: VideoPlaybackState = 'idle';
  private statusDetail: string | undefined;
  private sequence = 0;
  private sessionOriginMs = 0;
  private lastTimestampMs = -Infinity;
  private lastFrameKey: number | undefined;
  private lastCaptureMediaTimeMs: number | undefined;
  private videoFrameHandle: number | undefined;
  private animationHandle: number | undefined;
  private suspended = false;
  private pendingSeek = false;
  private playAfterSeek = false;
  private autoPlayPending = false;

  constructor(
    private readonly videoElement: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    options: VideoSourceOptions = {},
  ) {
    this.video = videoElement as VideoElementWithFrameCallback;
    this.callbacks = options.callbacks ?? {};
    this.env = {
      now: options.environment?.now ?? DEFAULT_ENVIRONMENT.now,
      requestAnimationFrame: options.environment?.requestAnimationFrame ?? DEFAULT_ENVIRONMENT.requestAnimationFrame,
      cancelAnimationFrame: options.environment?.cancelAnimationFrame ?? DEFAULT_ENVIRONMENT.cancelAnimationFrame,
      createObjectUrl: options.environment?.createObjectUrl ?? DEFAULT_ENVIRONMENT.createObjectUrl,
      revokeObjectUrl: options.environment?.revokeObjectUrl ?? DEFAULT_ENVIRONMENT.revokeObjectUrl,
    };
    this.context = options.context ?? context2d(canvas, { alpha: false });
    this.captureMode = typeof this.video.requestVideoFrameCallback === 'function'
      && typeof this.video.cancelVideoFrameCallback === 'function'
      ? 'requestVideoFrameCallback'
      : 'animationFrame';

    this.listen('play', this.handlePlay);
    this.listen('playing', this.handlePlaying);
    this.listen('pause', this.handlePause);
    this.listen('ended', this.handleEnded);
    this.listen('loadedmetadata', this.handleLoadedMetadata);
    this.listen('loadeddata', this.handleLoadedData);
    this.listen('durationchange', this.handleTimeUpdate);
    this.listen('timeupdate', this.handleTimeUpdate);
    this.listen('seeking', this.handleSeeking);
    this.listen('seeked', this.handleSeeked);
    this.listen('error', this.handleError);
  }

  get isPlaying(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  get currentState(): VideoPlaybackState {
    return this.state;
  }

  load(file: File): void {
    if (this.disposed) return;
    const problem = videoFileProblem(this.videoElement, file);
    if (problem) {
      this.callbacks.onError?.(problem);
      return;
    }

    let nextUrl: string;
    try {
      nextUrl = this.env.createObjectUrl(file);
    } catch {
      this.callbacks.onError?.('The browser could not create a local URL for that video.');
      return;
    }

    this.cancelCapture();
    this.state = 'loading';
    this.statusDetail = undefined;
    this.suspended = false;
    this.pendingSeek = false;
    this.playAfterSeek = false;
    this.autoPlayPending = true;
    this.fileName = file.name;
    this.video.pause();

    const previousUrl = this.objectUrl;
    this.objectUrl = nextUrl;
    this.video.src = nextUrl;
    this.video.load();
    if (previousUrl) this.env.revokeObjectUrl(previousUrl);
    this.resetSession('load');
    this.clearCanvas();
    this.emitStatus('loading');
  }

  start(listener: FrameListener<VisualFrame>): void {
    if (this.disposed) return;
    this.listener = listener;
    if (this.active) return;
    this.active = true;
    if (this.video.readyState >= 2) {
      if (this.isPlaying) this.scheduleCapture();
      else this.captureStillFrame();
    }
  }

  stop(): void {
    this.active = false;
    this.listener = undefined;
    this.cancelCapture();
  }

  async play(): Promise<void> {
    if (this.disposed || this.state === 'idle' || this.state === 'error') return;
    if (this.video.ended) {
      this.restart();
      return;
    }
    try {
      await this.video.play();
      this.statusDetail = undefined;
    } catch {
      if (this.disposed || this.video.error) return;
      this.emitStatus('paused', 'The browser blocked autoplay. Press Play to start.');
    }
  }

  pause(): void {
    if (this.disposed) return;
    this.playAfterSeek = false;
    this.cancelCapture();
    this.video.pause();
  }

  restart(): void {
    if (this.disposed || this.state === 'idle' || this.state === 'error') return;
    this.seekTo(0, 'restart', true);
  }

  seekTo(seconds: number, reason: VideoResetReason = 'seek', playAfterSeek = false): void {
    if (this.disposed || this.state === 'idle' || this.state === 'loading' || this.state === 'error') return;
    if (!Number.isFinite(seconds)) return;

    const duration = this.video.duration;
    let target = Math.max(0, seconds);
    if (Number.isFinite(duration) && duration > 0) {
      target = Math.min(target, Math.max(0, duration - 0.001));
    }

    this.cancelCapture();
    this.suspended = true;
    this.pendingSeek = true;
    this.playAfterSeek = playAfterSeek || !this.video.paused;
    this.resetSession(reason);
    this.emitStatus(this.video.paused ? 'paused' : 'playing', 'Seeking…');

    if (Math.abs(this.video.currentTime - target) < 0.001) {
      this.finishSeek();
      return;
    }
    this.video.currentTime = target;
  }

  /** Re-request capture after a visibility change without resetting the session. */
  resumeCapture(): void {
    if (this.disposed || !this.active || !this.isPlaying) return;
    this.cancelCapture();
    this.scheduleCapture();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    for (const { type, handler } of this.listeners) {
      this.videoElement.removeEventListener(type, handler);
    }
    this.listeners.length = 0;
    this.video.pause();
    if (this.objectUrl) {
      this.env.revokeObjectUrl(this.objectUrl);
      this.objectUrl = undefined;
    }
    this.fileName = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.clearCanvas();
  }

  private listen(type: string, handler: EventListener): void {
    this.videoElement.addEventListener(type, handler);
    this.listeners.push({ type, handler });
  }

  private readonly handlePlay = (): void => {
    if (this.disposed) return;
    this.statusDetail = undefined;
    this.emitStatus('playing');
    this.scheduleCapture();
  };

  private readonly handlePlaying = (): void => {
    if (this.disposed) return;
    this.statusDetail = undefined;
    this.emitStatus('playing');
    this.scheduleCapture();
  };

  private readonly handlePause = (): void => {
    if (this.disposed || this.state === 'loading' || this.state === 'error') return;
    this.cancelCapture();
    if (this.video.ended) return;
    if (this.pendingSeek) {
      this.emitStatus(this.video.paused ? 'paused' : 'playing', this.statusDetail);
      return;
    }
    this.emitStatus('paused');
  };

  private readonly handleEnded = (): void => {
    if (this.disposed) return;
    this.cancelCapture();
    this.emitStatus('ended');
  };

  private readonly handleLoadedMetadata = (): void => {
    if (this.disposed || this.state === 'error') return;
    this.emitStatus(this.video.paused ? 'ready' : 'playing');
  };

  private readonly handleLoadedData = (): void => {
    if (this.disposed || this.state === 'error') return;
    if (this.state === 'loading' || this.state === 'ready') {
      this.emitStatus(this.video.paused ? 'ready' : 'playing');
    }
    this.captureStillFrame();
    if (this.autoPlayPending) {
      this.autoPlayPending = false;
      if (this.active) void this.play();
    }
  };

  private readonly handleTimeUpdate = (): void => {
    if (this.disposed || this.state === 'error' || this.state === 'idle') return;
    this.emitStatus(this.state, this.statusDetail);
  };

  private readonly handleSeeking = (): void => {
    if (this.disposed || !this.active || this.pendingSeek || this.state === 'loading' || this.state === 'error') {
      return;
    }
    this.cancelCapture();
    this.suspended = true;
    this.pendingSeek = true;
    this.playAfterSeek = !this.video.paused;
    this.resetSession('seek');
    this.emitStatus(this.video.paused ? 'paused' : 'playing', 'Seeking…');
  };

  private readonly handleSeeked = (): void => {
    if (this.disposed) return;
    this.finishSeek();
  };

  private readonly handleError = (): void => {
    if (this.disposed) return;
    this.fail(describeMediaError(this.video.error));
  };

  private fail(message: string): void {
    if (this.disposed) return;
    this.cancelCapture();
    this.video.pause();
    this.statusDetail = message;
    this.emitStatus('error', message);
    this.callbacks.onError?.(message);
  }

  private finishSeek(): void {
    if (!this.pendingSeek || this.disposed) return;
    this.pendingSeek = false;
    this.suspended = false;
    this.lastFrameKey = undefined;
    this.emitStatus(this.video.paused ? 'paused' : 'playing');
    this.captureStillFrame();

    const shouldPlay = this.playAfterSeek;
    this.playAfterSeek = false;
    if (shouldPlay && this.video.paused) {
      void this.play();
    } else if (!this.video.paused) {
      this.scheduleCapture();
    }
  }

  private resetSession(reason: VideoResetReason): void {
    this.cancelCapture();
    this.sequence = 0;
    this.sessionOriginMs = this.env.now();
    this.lastTimestampMs = -Infinity;
    this.lastFrameKey = undefined;
    this.lastCaptureMediaTimeMs = undefined;
    this.callbacks.onSessionReset?.(reason);
  }

  private scheduleCapture(): void {
    if (!this.active || this.disposed || this.suspended || !this.listener) return;
    if (this.video.paused || this.video.ended || this.state === 'loading' || this.state === 'error') return;
    if (this.videoFrameHandle !== undefined || this.animationHandle !== undefined) return;

    if (this.captureMode === 'requestVideoFrameCallback') {
      const request = this.video.requestVideoFrameCallback;
      if (request) {
        this.videoFrameHandle = request.call(this.video, this.handleVideoFrame);
        return;
      }
    }
    this.animationHandle = this.env.requestAnimationFrame(this.handleAnimationFrame);
  }

  private cancelCapture(): void {
    if (this.videoFrameHandle !== undefined) {
      this.video.cancelVideoFrameCallback?.(this.videoFrameHandle);
      this.videoFrameHandle = undefined;
    }
    if (this.animationHandle !== undefined) {
      this.env.cancelAnimationFrame(this.animationHandle);
      this.animationHandle = undefined;
    }
  }

  private readonly handleVideoFrame = (_now: number, metadata: VideoFrameMetadataLike): void => {
    this.videoFrameHandle = undefined;
    if (!this.active || this.disposed || this.suspended) return;
    if (this.video.paused || this.video.ended) return;

    const mediaTimeMs = Number.isFinite(metadata.mediaTime)
      ? metadata.mediaTime * 1_000
      : this.video.currentTime * 1_000;
    const frameKey = metadata.presentedFrames ?? Math.round(mediaTimeMs);
    this.captureFrame(mediaTimeMs, frameKey);
    this.scheduleCapture();
  };

  private readonly handleAnimationFrame = (_now: number): void => {
    this.animationHandle = undefined;
    if (!this.active || this.disposed || this.suspended) return;
    if (this.video.paused || this.video.ended) return;

    const mediaTimeMs = this.video.currentTime * 1_000;
    const frameKey = Math.round(mediaTimeMs);
    this.captureFrame(mediaTimeMs, frameKey);
    this.scheduleCapture();
  };

  private captureStillFrame(): void {
    if (!this.active || !this.listener || this.suspended || this.disposed) return;
    if (this.video.readyState < 2) return;
    const mediaTimeMs = this.video.currentTime * 1_000;
    this.captureFrame(mediaTimeMs, Math.round(mediaTimeMs));
  }

  private captureFrame(mediaTimeMs: number, frameKey: number): void {
    if (!this.listener || !this.active || this.suspended || this.disposed) return;
    if (this.video.readyState < 2 || this.video.videoWidth === 0) return;
    if (frameKey === this.lastFrameKey) return;
    if (this.lastCaptureMediaTimeMs !== undefined
      && Math.abs(mediaTimeMs - this.lastCaptureMediaTimeMs) < 0.5) {
      return;
    }

    this.context.fillStyle = '#05060f';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    try {
      drawContained(this.context, this.videoElement, this.canvas.width, this.canvas.height);
    } catch (error) {
      console.error('Video frame capture failed.', error);
      this.stop();
      this.fail('The browser could not copy this video frame to the Canvas.');
      return;
    }

    const timestampMs = Math.max(this.env.now(), this.lastTimestampMs);
    this.lastTimestampMs = timestampMs;
    this.lastFrameKey = frameKey;
    this.lastCaptureMediaTimeMs = mediaTimeMs;
    const frame: StreamFrame<VisualFrame> = {
      sequence: ++this.sequence,
      timestampMs,
      payload: {
        canvas: this.canvas,
        elapsedMs: mediaTimeMs,
        mediaTimeMs,
        sessionElapsedMs: Math.max(0, timestampMs - this.sessionOriginMs),
        phase: 'Video',
      },
    };

    try {
      this.listener(frame);
    } catch (error) {
      console.error('Video frame listener failed.', error);
      this.stop();
      this.fail('A captured video frame could not be processed.');
    }
  }

  private clearCanvas(): void {
    this.context.fillStyle = '#05060f';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private emitStatus(state: VideoPlaybackState, detail?: string): void {
    if (this.disposed) return;
    this.state = state;
    this.statusDetail = detail;
    this.callbacks.onStatus?.({
      state,
      fileName: this.fileName,
      durationMs: this.durationMs(),
      mediaTimeMs: this.mediaTimeMs(),
      width: this.video.videoWidth || null,
      height: this.video.videoHeight || null,
      captureMode: this.captureMode,
      message: detail ?? this.defaultMessage(state),
    });
  }

  private defaultMessage(state: VideoPlaybackState): string {
    const name = this.fileName ?? 'video';
    switch (state) {
      case 'idle':
        return 'Choose a local video to start. Nothing is uploaded.';
      case 'loading':
        return `Loading ${name} locally…`;
      case 'ready':
        return `${name} is ready. Press Play.`;
      case 'playing':
        return `Playing ${name}. Frames stay on this device.`;
      case 'paused':
        return 'Paused. Resume to capture more frames.';
      case 'ended':
        return 'Playback ended. Restart to replay.';
      case 'error':
        return this.statusDetail ?? 'The video could not be played.';
    }
  }

  private durationMs(): number | null {
    const { duration } = this.video;
    return Number.isFinite(duration) && duration >= 0 ? duration * 1_000 : null;
  }

  private mediaTimeMs(): number | null {
    const { currentTime } = this.video;
    return Number.isFinite(currentTime) ? currentTime * 1_000 : null;
  }
}
