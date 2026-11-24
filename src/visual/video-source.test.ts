import { describe, expect, it } from 'vitest';
import type { VideoSourceEnvironment, VideoSourceStatus } from './video-source';
import { VideoSource } from './video-source';
import type { VisualFrame } from './source';

type CapturedFrame = VisualFrame & { readonly sequence: number };

type Listener = EventListener;

class FakeVideo {
  src = '';
  currentTime = 0;
  duration = 10;
  paused = true;
  ended = false;
  readyState = 0;
  videoWidth = 640;
  videoHeight = 360;
  error: MediaError | null = null;
  canPlay = 'probably';
  loadCalls = 0;
  playCalls = 0;
  pauseCalls = 0;
  addCalls = 0;
  removeCalls = 0;
  cancelledFrameCallbacks = 0;
  playRejects = false;

  readonly listeners = new Map<string, Set<Listener>>();
  readonly frameCallbacks = new Map<number, (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void>();
  private nextFrameHandle = 1;
  readonly supportsFrameCallback: boolean;

  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;

  constructor(supportsFrameCallback = true) {
    this.supportsFrameCallback = supportsFrameCallback;
    if (!supportsFrameCallback) return;
    this.requestVideoFrameCallback = (callback) => {
      const handle = this.nextFrameHandle++;
      this.frameCallbacks.set(handle, callback);
      return handle;
    };
    this.cancelVideoFrameCallback = (handle) => {
      this.cancelledFrameCallbacks += 1;
      this.frameCallbacks.delete(handle);
    };
  }

  addEventListener(type: string, handler: Listener): void {
    this.addCalls += 1;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.removeCalls += 1;
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler(new Event(type));
    }
  }

  canPlayType(): string {
    return this.canPlay;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playRejects) return Promise.reject(new Error('blocked'));
    this.paused = false;
    this.dispatch('play');
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    if (!this.paused) {
      this.paused = true;
      this.dispatch('pause');
    }
  }

  load(): void {
    this.loadCalls += 1;
    this.paused = true;
    this.ended = false;
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  fireFrame(mediaTime: number, presentedFrames?: number): void {
    const entry = this.frameCallbacks.entries().next();
    if (entry.done) throw new Error('No pending frame callback.');
    this.frameCallbacks.delete(entry.value[0]);
    entry.value[1](0, { mediaTime, ...(presentedFrames === undefined ? {} : { presentedFrames }) });
  }

  get pendingFrameCallbacks(): number {
    return this.frameCallbacks.size;
  }
}

class FakeContext {
  fillStyle = '';
  fillRectCalls = 0;
  drawImageCalls = 0;

  fillRect(): void {
    this.fillRectCalls += 1;
  }

  drawImage(): void {
    this.drawImageCalls += 1;
  }
}

interface Harness {
  readonly video: FakeVideo;
  readonly context: FakeContext;
  readonly source: VideoSource;
  readonly frames: CapturedFrame[];
  readonly statuses: VideoSourceStatus[];
  readonly resets: string[];
  readonly errors: string[];
  readonly createdUrls: string[];
  readonly revokedUrls: string[];
  readonly animationFrames: Map<number, FrameRequestCallback>;
  clock: { now: number };
  runAnimationFrame(): void;
}

function createHarness(supportsFrameCallback = true): Harness {
  const video = new FakeVideo(supportsFrameCallback);
  const context = new FakeContext();
  const frames: CapturedFrame[] = [];
  const statuses: VideoSourceStatus[] = [];
  const resets: string[] = [];
  const errors: string[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  const clock = { now: 0 };
  let nextAnimationHandle = 1;

  const environment: Partial<VideoSourceEnvironment> = {
    now: () => clock.now,
    requestAnimationFrame: (callback) => {
      const handle = nextAnimationHandle++;
      animationFrames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      animationFrames.delete(handle);
    },
    createObjectUrl: (file) => {
      const url = 'blob:' + (file as File).name + ':' + createdUrls.length;
      createdUrls.push(url);
      return url;
    },
    revokeObjectUrl: (url) => {
      revokedUrls.push(url);
    },
  };

  const source = new VideoSource(
    video as unknown as HTMLVideoElement,
    { width: 720, height: 405 } as HTMLCanvasElement,
    {
      callbacks: {
        onStatus: (status) => statuses.push(status),
        onSessionReset: (reason) => resets.push(reason),
        onError: (message) => errors.push(message),
      },
      environment,
      context: context as unknown as CanvasRenderingContext2D,
    },
  );
  source.start((frame) => frames.push({ ...frame.payload, sequence: frame.sequence }));

  return {
    video,
    context,
    source,
    frames,
    statuses,
    resets,
    errors,
    createdUrls,
    revokedUrls,
    animationFrames,
    clock,
    runAnimationFrame() {
      const entry = animationFrames.entries().next();
      if (entry.done) throw new Error('No pending animation frame.');
      animationFrames.delete(entry.value[0]);
      entry.value[1](clock.now);
    },
  };
}

function videoFile(name: string, type = 'video/mp4', size = 8): File {
  return new File([new Uint8Array(size)], name, { type });
}

function loadFile(harness: Harness, file: File): void {
  harness.source.load(file);
  harness.video.readyState = 3;
  harness.video.dispatch('loadedmetadata');
  harness.video.dispatch('loadeddata');
  // loadeddata paints the first still frame; lifecycle assertions below track
  // frames captured after this initial paint.
  harness.frames.length = 0;
}

describe('local video source', () => {
  it('paints the first decoded frame before playback starts', () => {
    const harness = createHarness();
    harness.source.load(videoFile('poster.mp4'));
    harness.video.readyState = 3;
    harness.video.dispatch('loadedmetadata');
    harness.video.dispatch('loadeddata');
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({ mediaTimeMs: 0, phase: 'Video' });
    expect(harness.frames[0].sessionElapsedMs).toBe(0);
  });

  it('switches files while reusing one listener set and revoking the old URL', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('first.mp4'));
    expect(harness.video.playCalls).toBe(1);
    expect(harness.video.pendingFrameCallbacks).toBe(1);

    harness.clock.now = 100;
    harness.video.fireFrame(0.5, 1);
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({ mediaTimeMs: 500, phase: 'Video' });

    const listenerRegistrations = harness.video.addCalls;
    loadFile(harness, videoFile('second.webm', 'video/webm'));
    expect(harness.video.addCalls).toBe(listenerRegistrations);
    expect(harness.revokedUrls).toEqual(['blob:first.mp4:0']);
    expect(harness.createdUrls).toEqual(['blob:first.mp4:0', 'blob:second.webm:1']);
    expect(harness.resets.filter((reason) => reason === 'load')).toHaveLength(2);

    harness.clock.now = 200;
    harness.video.fireFrame(1, 2);
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0].mediaTimeMs).toBe(1_000);
  });

  it('deduplicates repeated presented frames from requestVideoFrameCallback', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));

    harness.clock.now = 10;
    harness.video.fireFrame(1, 41);
    harness.clock.now = 20;
    harness.video.fireFrame(1, 41);
    expect(harness.frames).toHaveLength(1);

    harness.clock.now = 30;
    harness.video.fireFrame(1.033, 42);
    expect(harness.frames).toHaveLength(2);
  });

  it('cancels a pending frame callback on pause and requests one after resume', async () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    expect(harness.video.pendingFrameCallbacks).toBe(1);

    harness.source.pause();
    expect(harness.video.paused).toBe(true);
    expect(harness.video.pendingFrameCallbacks).toBe(0);
    expect(harness.video.cancelledFrameCallbacks).toBe(1);

    await harness.source.play();
    expect(harness.video.paused).toBe(false);
    expect(harness.video.pendingFrameCallbacks).toBe(1);
  });

  it('resets the sampling session and sequence on seek, then captures the target frame', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    harness.clock.now = 100;
    harness.video.fireFrame(2, 10);
    expect(harness.frames).toHaveLength(1);

    harness.clock.now = 200;
    harness.source.seekTo(5);
    expect(harness.resets.at(-1)).toBe('seek');
    expect(harness.video.currentTime).toBe(5);
    expect(harness.video.pendingFrameCallbacks).toBe(0);
    expect(harness.frames).toHaveLength(1);

    harness.clock.now = 300;
    harness.video.dispatch('seeked');
    expect(harness.frames).toHaveLength(2);
    expect(harness.frames[1]).toMatchObject({ mediaTimeMs: 5_000, phase: 'Video' });
    expect(harness.frames[1].sequence).toBe(1);
  });

  it('captures a fresh frame when seeking to the current media position', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    harness.video.currentTime = 2;
    harness.clock.now = 100;
    harness.video.fireFrame(2, 10);
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0].sequence).toBe(2);

    harness.clock.now = 200;
    harness.source.seekTo(2);
    expect(harness.frames).toHaveLength(2);
    expect(harness.frames[1].sequence).toBe(1);
    expect(harness.frames[1].mediaTimeMs).toBe(2_000);
  });

  it('restarts from zero and resumes a paused video after the seek completes', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    harness.video.currentTime = 4;
    harness.video.paused = true;
    harness.video.dispatch('pause');
    const playsBefore = harness.video.playCalls;

    harness.source.restart();
    expect(harness.video.currentTime).toBe(0);
    harness.video.dispatch('seeked');
    expect(harness.video.playCalls).toBeGreaterThan(playsBefore);
    expect(harness.video.paused).toBe(false);
    expect(harness.resets.at(-1)).toBe('restart');
  });

  it('releases listeners, media, and the Object URL on dispose', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    const registrations = harness.video.addCalls;

    harness.source.dispose();
    expect(harness.video.removeCalls).toBe(registrations);
    expect(harness.video.loadCalls).toBe(2);
    expect(harness.revokedUrls).toEqual(['blob:clip.mp4:0']);
    expect(harness.video.src).toBe('');
    expect(harness.video.pauseCalls).toBeGreaterThan(0);

    const resetsBefore = harness.resets.length;
    harness.source.load(videoFile('ignored.mp4'));
    expect(harness.createdUrls).toHaveLength(1);
    expect(harness.resets).toHaveLength(resetsBefore);
  });

  it('reports unsupported or empty files without disturbing the current video', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    const currentSource = harness.video.src;

    harness.video.canPlay = '';
    harness.source.load(videoFile('movie.mkv', 'video/x-matroska'));
    expect(harness.errors.at(-1)).toContain('cannot play');
    expect(harness.createdUrls).toHaveLength(1);
    expect(harness.video.src).toBe(currentSource);
    expect(harness.resets.filter((reason) => reason === 'load')).toHaveLength(1);

    harness.video.canPlay = 'probably';
    harness.source.load(videoFile('empty.mp4', 'video/mp4', 0));
    expect(harness.errors.at(-1)).toContain('empty');
  });

  it('surfaces media decode errors with an actionable message', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    harness.video.error = { code: 3 } as MediaError;
    harness.video.dispatch('error');
    expect(harness.statuses.at(-1)?.state).toBe('error');
    expect(harness.errors.at(-1)).toContain('H.264');
    expect(harness.video.pendingFrameCallbacks).toBe(0);
  });

  it('falls back to animation frames when requestVideoFrameCallback is missing', () => {
    const harness = createHarness(false);
    loadFile(harness, videoFile('clip.mp4'));
    expect(harness.statuses.at(-1)?.captureMode).toBe('animationFrame');
    expect(harness.animationFrames.size).toBe(1);

    harness.video.currentTime = 1;
    harness.clock.now = 100;
    harness.runAnimationFrame();
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0].mediaTimeMs).toBe(1_000);

    harness.clock.now = 116;
    harness.runAnimationFrame();
    expect(harness.frames).toHaveLength(1);

    harness.video.currentTime = 1.04;
    harness.clock.now = 132;
    harness.runAnimationFrame();
    expect(harness.frames).toHaveLength(2);
    expect(harness.frames[1].mediaTimeMs).toBe(1_040);
  });

  it('does not emit while stopped and resumes without duplicating a paused frame', () => {
    const harness = createHarness();
    loadFile(harness, videoFile('clip.mp4'));
    harness.clock.now = 100;
    harness.video.fireFrame(1, 1);
    expect(harness.frames).toHaveLength(1);

    harness.source.stop();
    harness.video.currentTime = 1;
    harness.video.paused = true;
    harness.video.dispatch('pause');
    harness.source.start((frame) => harness.frames.push({ ...frame.payload, sequence: frame.sequence }));
    expect(harness.frames).toHaveLength(1);
  });
});
