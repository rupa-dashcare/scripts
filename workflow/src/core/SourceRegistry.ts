import type { Source } from '../ports/index';
import type { SourceName } from '../domain/types';

/**
 * One of the two extension points (§11.2). The pipeline never imports a
 * concrete source, so a seventh adapter cannot break it.
 */
export class SourceRegistry {
  private readonly sources = new Map<SourceName, Source>();

  register(source: Source): this {
    if (this.sources.has(source.name)) {
      throw new Error(`source "${source.name}" is already registered`);
    }
    this.sources.set(source.name, source);
    return this;
  }

  enabled(only?: readonly SourceName[]): readonly Source[] {
    const all = [...this.sources.values()];
    if (!only || only.length === 0) return all;
    const wanted = new Set(only);
    return all.filter((s) => wanted.has(s.name));
  }

  get size(): number {
    return this.sources.size;
  }
}
