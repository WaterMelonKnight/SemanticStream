/**
 * A page-scoped generation token for cost queries. It is advanced on pagehide,
 * source switch and pageshow so a late `/api/runtime` result cannot update a
 * session that has already been replaced.
 */
export class CostGeneration {
  private value = 0;

  current(): number {
    return this.value;
  }

  next(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }
}
