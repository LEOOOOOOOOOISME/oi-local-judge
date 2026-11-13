/**
 * Small bounded TTL map used by the login/registration rate limiters.
 *
 * The previous module-level Maps only expired a key when that exact key was
 * visited again, so an attacker could grow them without bound by varying the
 * username or source IP. This map prunes expired keys and evicts the oldest
 * key when the capacity is reached.
 */
export class BoundedTtlMap<T extends number> {
  private readonly entries = new Map<string, T[]>();

  constructor(
    private readonly maxKeys: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private pruneAll(at: number): void {
    for (const [key, values] of this.entries) {
      const recent = values.filter((value) => at - Number(value) < this.ttlMs);
      if (recent.length === 0) this.entries.delete(key);
      else this.entries.set(key, recent);
    }
  }

  get(key: string): T[] {
    const at = this.now();
    this.pruneAll(at);
    return [...(this.entries.get(key) ?? [])];
  }

  record(key: string, value: T): void {
    const at = this.now();
    this.pruneAll(at);
    const existing = this.entries.get(key);
    if (existing) {
      existing.push(value);
      return;
    }
    if (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, [value]);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.pruneAll(this.now());
    return this.entries.size;
  }
}
