export class Scope {
  private readonly parent: Scope | null;
  private readonly bindings = new Map<string, unknown>();

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  get(key: string): unknown {
    if (this.bindings.has(key)) return this.bindings.get(key);
    if (this.parent) return this.parent.get(key);
    throw new Error(`scope key not found: ${key}`);
  }

  has(key: string): boolean {
    return this.bindings.has(key) || (this.parent?.has(key) ?? false);
  }

  bind(key: string, value: unknown): void {
    this.bindings.set(key, value);
  }

  toObject(): Record<string, unknown> {
    const merged: Record<string, unknown> = this.parent ? this.parent.toObject() : {};
    for (const [k, v] of this.bindings) merged[k] = v;
    return merged;
  }

  child(): Scope {
    return new Scope(this);
  }
}
