export interface IndexedEntry {
  kind: "file" | "directory";
  relativePath: string;
  lowerPath: string;
  mask: number;
  ascii: boolean;
}

export type WatchRoot = (root: string, onChange: () => void) => Promise<() => void>;

export type BuildIndex = (isUrgent: () => boolean) => Promise<IndexedEntry[] | null>;

export interface PathIndexOptions {
  watch: WatchRoot;
  maxEntries?: number;
  idleMs?: number;
}

interface Slot {
  root: string;
  entries: IndexedEntry[] | null;
  signature: string | null;
  builtSeq: number;
  builtAt: number;
  changeSeq: number;
  building: Promise<void> | null;
  waiters: number;
  usedAt: number;
  watching: Promise<boolean>;
  unwatch: (() => void) | null;
}

const DEFAULT_MAX_ENTRIES = 250_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const SAFETY_REFRESH_MS = 60_000;
const MAX_FRESH_BUILDS = 3;

export class PathIndexes {
  readonly maxEntries: number;
  private readonly watch: WatchRoot;
  private readonly idleMs: number;
  private readonly slots = new Map<string, Slot>();
  private seq = 0;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PathIndexOptions) {
    this.watch = options.watch;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  prepare(key: string, root: string, signature: string, build: BuildIndex): void {
    if (this.slots.has(key)) return;
    this.createSlot(key, root, signature, build);
    this.scheduleSweep();
  }

  async get(key: string, signature: string, build: BuildIndex): Promise<IndexedEntry[] | null> {
    const slot = this.slots.get(key);
    if (!slot) return null;
    slot.usedAt = Date.now();
    this.scheduleSweep();
    if (slot.entries === null) return null;
    if (slot.changeSeq < slot.builtSeq && slot.signature === signature) {
      if (!slot.building && Date.now() - slot.builtAt >= SAFETY_REFRESH_MS) {
        this.startBuild(slot, signature, build);
      }
      return slot.entries;
    }
    return this.fresh(slot, signature, build);
  }

  async idle(): Promise<void> {
    const slots = [...this.slots.values()];
    await Promise.all(slots.map((slot) => slot.watching));
    for (const slot of slots) {
      while (slot.building) await slot.building;
    }
  }

  private async fresh(
    slot: Slot,
    signature: string,
    build: BuildIndex,
  ): Promise<IndexedEntry[] | null> {
    slot.waiters += 1;
    try {
      for (let attempt = 0; attempt < MAX_FRESH_BUILDS; attempt += 1) {
        while (slot.building) await slot.building;
        if (slot.changeSeq < slot.builtSeq && slot.signature === signature) return slot.entries;
        this.startBuild(slot, signature, build);
      }
      return null;
    } finally {
      slot.waiters -= 1;
    }
  }

  private createSlot(key: string, root: string, signature: string, build: BuildIndex): Slot {
    const slot: Slot = {
      root,
      entries: null,
      signature: null,
      builtSeq: 0,
      builtAt: 0,
      changeSeq: 0,
      building: null,
      waiters: 0,
      usedAt: Date.now(),
      watching: Promise.resolve(false),
      unwatch: null,
    };
    slot.watching = this.watch(root, () => {
      this.seq += 1;
      slot.changeSeq = this.seq;
    }).then(
      (unwatch) => {
        if (this.slots.get(key) !== slot) {
          unwatch();
          return false;
        }
        slot.unwatch = unwatch;
        this.startBuild(slot, signature, build);
        return true;
      },
      () => false,
    );
    this.slots.set(key, slot);
    return slot;
  }

  private startBuild(slot: Slot, signature: string, build: BuildIndex): void {
    this.seq += 1;
    const seq = this.seq;
    const building = this.runBuild(slot, seq, signature, build);
    slot.building = building;
  }

  private async runBuild(
    slot: Slot,
    seq: number,
    signature: string,
    build: BuildIndex,
  ): Promise<void> {
    const entries = await build(() => slot.waiters > 0).catch(() => null);
    slot.building = null;
    if (seq < slot.builtSeq) return;
    slot.entries = entries;
    slot.signature = signature;
    slot.builtSeq = seq;
    slot.builtAt = Date.now();
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      const now = Date.now();
      for (const [key, slot] of this.slots) {
        if (slot.building || slot.waiters > 0 || now - slot.usedAt < this.idleMs) continue;
        this.evict(key);
      }
      if (this.slots.size > 0) this.scheduleSweep();
    }, this.idleMs);
    this.sweepTimer.unref?.();
  }

  private evict(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    slot.unwatch?.();
    slot.unwatch = null;
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
