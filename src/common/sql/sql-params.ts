/**
 * Tiny helper so raw SQL `$n` placeholders stay in sync with bind arrays.
 */
export class SqlParams {
  private readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** Snapshot for `manager.query(sql, params.all())`. */
  all(): unknown[] {
    return [...this.values];
  }

  get length(): number {
    return this.values.length;
  }
}
