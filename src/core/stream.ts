export interface StreamFrame<T> {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly payload: T;
}

export type FrameListener<T> = (frame: StreamFrame<T>) => void;

export interface StreamSource<T> {
  start(listener: FrameListener<T>): void;
  stop(): void;
}

export interface ContextSink<T> {
  /** Consume the borrowed payload synchronously. Return false when busy. */
  accept(frame: StreamFrame<T>): boolean;
}
