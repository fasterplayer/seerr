import fs from 'fs';
// "Not found" detection: Radarr/Sonarr items that are wanted and released but
// for which a live release search finds nothing usable. Everything lives in
// memory (like the download tracker); nothing is stored in the database.

export const NOT_FOUND_RECHECK_MS = 24 * 60 * 60 * 1000;
// Let the automatic search done by Radarr/Sonarr at add time finish first.
// A search that failed (indexer timeout...) is tried again after this delay.
export const NOT_FOUND_RETRY_MS = 30 * 60 * 1000;
export const NOT_FOUND_MIN_AGE_MS = 2 * 60 * 1000;

export interface NotFoundInfo {
  // 'noResults': the indexers returned nothing; 'rejected': they returned
  // releases but Radarr/Sonarr rejected all of them (see `rejection`).
  reason: 'noResults' | 'rejected';
  count: number;
  rejection?: string;
  checkedAt: string;
}

export interface ServarrRelease {
  title: string;
  rejected: boolean;
  rejections?: string[];
}

// Numbers differ from one release to the next ("Size: 12 GiB is larger than
// ..."), so rejections are grouped with digits masked.
const rejectionKey = (rejection: string) => rejection.replace(/[\d.,]+/g, '#');

/**
 * Decide from a release search result. Returns null when at least one release
 * is acceptable (the item is not "not found").
 */
export const evaluateReleases = (
  releases: ServarrRelease[],
  checkedAt = new Date()
): NotFoundInfo | null => {
  if (releases.some((release) => !release.rejected)) {
    return null;
  }
  if (releases.length === 0) {
    return {
      reason: 'noResults',
      count: 0,
      checkedAt: checkedAt.toISOString(),
    };
  }

  const counts = new Map<string, { text: string; n: number }>();
  for (const release of releases) {
    // count each distinct rejection once per release
    const seen = new Set<string>();
    for (const text of release.rejections ?? []) {
      const key = rejectionKey(text);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { text, n: 0 };
      entry.n++;
      counts.set(key, entry);
    }
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];

  return {
    reason: 'rejected',
    count: releases.length,
    rejection: top?.text,
    checkedAt: checkedAt.toISOString(),
  };
};

export interface NotFoundCandidate {
  id: number;
  added: string;
}

/** Cache of results by *arr server and item id. A null result = checked, found. */
export class NotFoundCache {
  private entries = new Map<
    string,
    { checkedAt: number; info: NotFoundInfo | null }
  >();

  private static key = (serverId: number, id: number) => `${serverId}:${id}`;

  public get(serverId: number, id: number): NotFoundInfo | undefined {
    return this.entries.get(NotFoundCache.key(serverId, id))?.info ?? undefined;
  }

  public set(
    serverId: number,
    id: number,
    info: NotFoundInfo | null,
    now = Date.now()
  ): void {
    this.entries.set(NotFoundCache.key(serverId, id), {
      checkedAt: now,
      info,
    });
  }

  public clear(serverId: number, id: number): void {
    this.entries.delete(NotFoundCache.key(serverId, id));
  }

  /**
   * Candidates that are old enough and not checked within the last 24 h, the
   * least recently checked first, at most `limit` of them.
   */
  public pickDue(
    serverId: number,
    candidates: NotFoundCandidate[],
    limit: number,
    now = Date.now()
  ): NotFoundCandidate[] {
    return candidates
      .map((candidate) => ({
        candidate,
        last: this.entries.get(NotFoundCache.key(serverId, candidate.id))
          ?.checkedAt,
      }))
      .filter(
        ({ candidate, last }) =>
          now - new Date(candidate.added).getTime() >= NOT_FOUND_MIN_AGE_MS &&
          (last === undefined || now - last >= NOT_FOUND_RECHECK_MS)
      )
      .sort((a, b) => (a.last ?? 0) - (b.last ?? 0))
      .slice(0, Math.max(0, limit))
      .map(({ candidate }) => candidate);
  }
}

/**
 * Items already announced as "not found", kept in a small JSON file so that a
 * restart or the daily recheck never notifies twice. An item is forgotten when
 * it is no longer wanted (queued, has a file...): a later outage notifies again.
 */
export class NotifiedStore {
  private keys: Set<string>;

  constructor(private file: string) {
    try {
      this.keys = new Set(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      this.keys = new Set();
    }
  }

  public has(key: string): boolean {
    return this.keys.has(key);
  }

  public add(key: string): void {
    if (!this.keys.has(key)) {
      this.keys.add(key);
      this.save();
    }
  }

  public remove(key: string): void {
    if (this.keys.delete(key)) {
      this.save();
    }
  }

  public retain(keep: (key: string) => boolean): void {
    const before = this.keys.size;
    this.keys = new Set([...this.keys].filter(keep));
    if (this.keys.size !== before) this.save();
  }

  // atomic write: temporary file, then rename
  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.keys].sort()));
      fs.renameSync(tmp, this.file);
    } catch {
      // not fatal: worst case the next restart notifies again
    }
  }
}
