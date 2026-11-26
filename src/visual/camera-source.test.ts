import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraSource } from './camera-source';

function fakes(play: Promise<void> = Promise.resolve()) {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const video = {
    srcObject: null as MediaStream | null,
    readyState: 0,
    currentTime: 0,
    play: vi.fn(() => play),
    pause: vi.fn(),
  };
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = { width: 720, height: 405, getContext: () => context };
  return { track, stream, video, canvas };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CameraSource lifecycle', () => {
  it('stops a track that arrives after the source was disposed', async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => { resolveStream = resolve; });
    const getUserMedia = vi.fn(() => pending);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const f = fakes();
    const source = new CameraSource(f.video as unknown as HTMLVideoElement, f.canvas as unknown as HTMLCanvasElement, vi.fn());
    const started = source.start(vi.fn());
    source.dispose();
    resolveStream(f.stream);
    await started;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
  });

  it('disposes tracks when play is still pending', async () => {
    let resolvePlay!: () => void;
    const play = new Promise<void>((resolve) => { resolvePlay = resolve; });
    const f = fakes(play);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => f.stream) },
    });
    const source = new CameraSource(f.video as unknown as HTMLVideoElement, f.canvas as unknown as HTMLCanvasElement, vi.fn());
    const started = source.start(vi.fn());
    await Promise.resolve();
    source.dispose();
    resolvePlay();
    await started;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.video.pause).toHaveBeenCalled();
  });
});
