import fs from 'fs';
// "Not found" detection, read only: Seerr never searches. Radarr/Sonarr decide
// when and what to search; an item is "not found" when it is wanted and
// released, nothing is on disk or in the queue, Radarr/Sonarr have searched
// for it (lastSearchTime) and nothing was grabbed since. Everything lives in
// memory (like the download tracker); nothing is stored in the database.

// A search can still be running (an anime season is searched episode by
// episode, for minutes) and a grab is recorded only at its end: an item whose
// last search is more recent than this is not judged yet.
export const NOT_FOUND_SETTLE_MS = 10 * 60 * 1000;

export interface NotFoundInfo {
  // 'searched': Radarr/Sonarr searched at `checkedAt` and grabbed nothing.
  // 'noResults' / 'rejected' (earlier versions, live release search) are no
  // longer produced; the front end still knows them.
  reason: 'searched' | 'noResults' | 'rejected';
  // number of items (episodes for a series) concerned
  count: number;
  rejection?: string;
  // lastSearchTime of Radarr/Sonarr (ISO)
  checkedAt: string;
}

// An entry of the "grabbed" history of Radarr/Sonarr (history/since).
export interface GrabEvent {
  date: string;
  movieId?: number | null;
  seriesId?: number | null;
  episodeId?: number | null;
}

export interface SearchableMovie {
  id: number;
  monitored: boolean;
  isAvailable: boolean;
  hasFile: boolean;
  lastSearchTime?: string | null;
}

export interface SearchableEpisode {
  id: number;
  monitored: boolean;
  hasFile: boolean;
  airDateUtc?: string | null;
  lastSearchTime?: string | null;
}

const time = (iso?: string | null): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

// A grab is dated after the start of the search that caused it, which is what
// lastSearchTime records (checked on Radarr 6.4.4 and Sonarr 4.0.20).
const grabbedSince = (
  grabs: GrabEvent[],
  searchedAt: number,
  matches: (grab: GrabEvent) => boolean
): boolean =>
  grabs.some((grab) => {
    const t = time(grab.date);
    return t !== undefined && t >= searchedAt && matches(grab);
  });

/** Oldest lastSearchTime (ISO) among the candidates: where to start the history. */
export const oldestSearch = (
  items: { lastSearchTime?: string | null }[]
): string | undefined => {
  const times = items
    .map((item) => time(item.lastSearchTime))
    .filter((t): t is number => t !== undefined);
  return times.length > 0
    ? new Date(Math.min(...times)).toISOString()
    : undefined;
};

/**
 * Radarr movie: monitored, released (isAvailable), no file, not in the queue
 * (pending "delay" items included: the queue lists them), searched by Radarr
 * and nothing grabbed since that search.
 */
export const evaluateMovie = (
  movie: SearchableMovie,
  queued: ReadonlySet<number>,
  grabs: GrabEvent[],
  now = Date.now()
): NotFoundInfo | null => {
  const searchedAt = time(movie.lastSearchTime);
  if (
    !movie.monitored ||
    !movie.isAvailable ||
    movie.hasFile ||
    queued.has(movie.id) ||
    searchedAt === undefined ||
    now - searchedAt < NOT_FOUND_SETTLE_MS ||
    grabbedSince(grabs, searchedAt, (grab) => grab.movieId === movie.id)
  ) {
    return null;
  }

  return {
    reason: 'searched',
    count: 1,
    checkedAt: new Date(searchedAt).toISOString(),
  };
};

/**
 * Sonarr series, from its episodes (the caller has already checked that the
 * series is monitored and has nothing in the queue). Wanted episodes =
 * monitored, aired (airDateUtc in the past), no file. The series is "not found"
 * when at least one wanted episode was searched by Sonarr (its own
 * lastSearchTime) and not grabbed since. It waits while any wanted episode was
 * searched less than NOT_FOUND_SETTLE_MS ago (a season search may be running).
 * `count` = searched episodes with nothing grabbed; `checkedAt` = the latest of
 * their searches.
 */
export const evaluateEpisodes = (
  episodes: SearchableEpisode[],
  grabs: GrabEvent[],
  now = Date.now()
): NotFoundInfo | null => {
  const searched = episodes
    .filter((episode) => {
      const aired = time(episode.airDateUtc);
      return (
        episode.monitored &&
        !episode.hasFile &&
        aired !== undefined &&
        aired <= now
      );
    })
    .map((episode) => ({ episode, searchedAt: time(episode.lastSearchTime) }))
    .filter(
      (e): e is { episode: SearchableEpisode; searchedAt: number } =>
        e.searchedAt !== undefined
    );

  if (
    searched.length === 0 ||
    searched.some(({ searchedAt }) => now - searchedAt < NOT_FOUND_SETTLE_MS)
  ) {
    return null;
  }

  const nothing = searched.filter(
    ({ episode, searchedAt }) =>
      !grabbedSince(grabs, searchedAt, (grab) => grab.episodeId === episode.id)
  );
  if (nothing.length === 0) {
    return null;
  }

  return {
    reason: 'searched',
    count: nothing.length,
    checkedAt: new Date(
      Math.max(...nothing.map(({ searchedAt }) => searchedAt))
    ).toISOString(),
  };
};

/** Result of the last pass, by *arr server and item id (only "not found" items). */
export class NotFoundCache {
  private servers = new Map<number, Map<number, NotFoundInfo>>();

  public get(serverId: number, id: number): NotFoundInfo | undefined {
    return this.servers.get(serverId)?.get(id);
  }

  /** Replaces the whole result of the servers (each pass starts from scratch). */
  public replace(
    serverIds: number[],
    entries: Map<number, NotFoundInfo>
  ): void {
    serverIds.forEach((serverId) => this.servers.set(serverId, entries));
  }
}

/**
 * Items already announced as "not found", kept in a small JSON file so that a
 * restart never notifies twice. An item is forgotten when it is no longer
 * "not found" (queued, has a file...): a later outage notifies again.
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
