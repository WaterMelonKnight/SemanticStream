/** A fixed-capacity ring buffer. Older entries are overwritten once full. */
export class BoundedTimeline<T> {
  private readonly items: Array<T | undefined>;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Timeline capacity must be a positive integer.');
    }
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    if (this.count < this.capacity) {
      this.items[(this.head + this.count) % this.capacity] = item;
      this.count += 1;
      return;
    }
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let index = 0; index < this.count; index += 1) {
      result.push(this.items[(this.head + index) % this.capacity] as T);
    }
    return result;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
