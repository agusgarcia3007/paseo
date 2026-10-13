export interface IndexedEntry {
  kind: "file" | "directory";
  relativePath: string;
  lowerPath: string;
  mask: number;
  ascii: boolean;
}

export type WatchRoot = (root: string, onChange: () => void) => Promise<() => void>;

export interface PathIndexOptions {
  maxEntries?: number;
  watch?: WatchRoot;
}

type Build = () => Promise<IndexedEntry[] | null>;

interface Slot {
  entries: IndexedEntry[] | null;
  builtAt: number;
  buildMs: number;
  building: Promise<void> | null;
  usedAt: number;
  dirty: boolean;
  watched: boolean;
  unwatch: Promise<(() => void) | null>;
}

const DEFAULT_MAX_ENTRIES = 250_000;
const MIN_REFRESH_MS = 1_000;
const REFRESH_PER_BUILD = 3;
const WATCHED_REFRESH_MS = 60_000;
const IDLE_MS = 10 * 60_000;

export class PathIndexes {
  readonly maxEntries: number;
  private readonly watch: WatchRoot | undefined;
  private readonly slots = new Map<string, Slot>();

  constructor(options: PathIndexOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.watch = options.watch;
  }

  lookup(key: string, root: string, build: Build): IndexedEntry[] | null {
    const now = Date.now();
    this.evictIdle(now);
    const slot = this.slots.get(key) ?? this.createSlot(key, root, now);
    slot.usedAt = now;
    if (!slot.building && this.isStale(slot, now)) {
      slot.dirty = false;
      slot.building = this.rebuild(slot, build);
    }
    return slot.entries;
  }

  async idle(): Promise<void> {
    while (true) {
      const pending = [...this.slots.values()].flatMap((slot) =>
        slot.building ? [slot.building] : [],
      );
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private createSlot(key: string, root: string, now: number): Slot {
    const slot: Slot = {
      entries: null,
      builtAt: 0,
      buildMs: 0,
      building: null,
      usedAt: now,
      dirty: false,
      watched: false,
      unwatch: Promise.resolve(null),
    };
    if (this.watch) {
      slot.unwatch = this.watch(root, () => {
        slot.dirty = true;
      }).then(
        (unwatch) => {
          slot.watched = true;
          return unwatch;
        },
        () => null,
      );
    }
    this.slots.set(key, slot);
    return slot;
  }

  private isStale(slot: Slot, now: number): boolean {
    if (slot.builtAt === 0 || slot.dirty) return true;
    const refreshAfter = slot.watched
      ? WATCHED_REFRESH_MS
      : Math.max(MIN_REFRESH_MS, slot.buildMs * REFRESH_PER_BUILD);
    return now - slot.builtAt >= refreshAfter;
  }

  private async rebuild(slot: Slot, build: Build): Promise<void> {
    const startedAt = Date.now();
    const entries = await build().catch(() => null);
    slot.entries = entries;
    slot.builtAt = Date.now();
    slot.buildMs = slot.builtAt - startedAt;
    slot.building = null;
  }

  private evictIdle(now: number): void {
    for (const [key, slot] of this.slots) {
      if (slot.building || now - slot.usedAt <= IDLE_MS) continue;
      void slot.unwatch.then((unwatch) => unwatch?.());
      this.slots.delete(key);
    }
  }
}

export function characterMask(text: string): number {
  let mask = 0;
  for (let index = 0; index < text.length; index += 1) {
    mask |= characterBit(text.charCodeAt(index));
  }
  return mask;
}

function characterBit(code: number): number {
  if (code >= 97 && code <= 122) return 1 << (code - 97);
  if (code >= 48 && code <= 57) return 1 << (26 + ((code - 48) % 6));
  return 0;
}

function isAlphanumeric(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

export function compactQuery(lowerQuery: string): string {
  let compact = "";
  for (let index = 0; index < lowerQuery.length; index += 1) {
    if (isAlphanumeric(lowerQuery.charCodeAt(index))) compact += lowerQuery[index];
  }
  return compact;
}

export function mayMatch(entry: IndexedEntry, compact: string, mask: number): boolean {
  if ((entry.mask & mask) !== mask) return false;
  const path = entry.lowerPath;
  let queryIndex = 0;
  for (let index = 0; index < path.length && queryIndex < compact.length; index += 1) {
    if (path.charCodeAt(index) === compact.charCodeAt(queryIndex)) queryIndex += 1;
  }
  return queryIndex === compact.length;
}

export function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) return false;
  }
  return true;
}

export function containsCompact(lowerPath: string, compact: string): boolean {
  if (!compact) return true;
  const first = compact.charCodeAt(0);
  for (let start = 0; start < lowerPath.length; start += 1) {
    if (lowerPath.charCodeAt(start) !== first) continue;
    let queryIndex = 1;
    for (
      let index = start + 1;
      index < lowerPath.length && queryIndex < compact.length;
      index += 1
    ) {
      const code = lowerPath.charCodeAt(index);
      if (!isAlphanumeric(code)) continue;
      if (code !== compact.charCodeAt(queryIndex)) break;
      queryIndex += 1;
    }
    if (queryIndex === compact.length) return true;
  }
  return false;
}

export function keepBest<T>(
  best: T[],
  candidate: T,
  limit: number,
  compare: (a: T, b: T) => number,
): void {
  if (best.length === limit && compare(candidate, best[limit - 1]) >= 0) return;
  let low = 0;
  let high = best.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(best[middle], candidate) <= 0) low = middle + 1;
    else high = middle;
  }
  best.splice(low, 0, candidate);
  if (best.length > limit) best.pop();
}
