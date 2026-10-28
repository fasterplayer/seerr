import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import type { NotFoundInfo } from '@server/lib/notfound';
import {
  evaluateReleases,
  NOT_FOUND_RECHECK_MS,
  NOT_FOUND_RETRY_MS,
  NotFoundCache,
  NotifiedStore,
} from '@server/lib/notfound';
import { NOTIFIED_FILE, notifyNotFound } from '@server/lib/notfoundNotify';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

interface EpisodeNumberResult {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number;
  id: number;
}
export interface DownloadingItem {
  mediaType: MediaType;
  externalId: number;
  size: number;
  sizeLeft: number;
  status: string;
  timeLeft: string;
  estimatedCompletionTime: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
}

// Live release searches ("is anything findable?") hit the indexers: cap them.
const MAX_NOT_FOUND_CHECKS_PER_MINUTE = 2;

class DownloadTracker {
  private radarrServers: Record<number, DownloadingItem[]> = {};
  private sonarrServers: Record<number, DownloadingItem[]> = {};
  private radarrNotFound = new NotFoundCache();
  private sonarrNotFound = new NotFoundCache();
  private notFoundCheckTimes: number[] = [];
  private notFoundBusy = new Set<string>();
  private notifiedStore?: NotifiedStore;

  private getNotified(): NotifiedStore {
    this.notifiedStore ??= new NotifiedStore(NOTIFIED_FILE);
    return this.notifiedStore;
  }

  public getMovieNotFound(
    serverId: number,
    externalServiceId: number
  ): NotFoundInfo | undefined {
    return this.radarrNotFound.get(serverId, externalServiceId);
  }

  public getSeriesNotFound(
    serverId: number,
    externalServiceId: number
  ): NotFoundInfo | undefined {
    return this.sonarrNotFound.get(serverId, externalServiceId);
  }

  // At most MAX_NOT_FOUND_CHECKS_PER_MINUTE searches in any 60 s window, shared
  // by Radarr and Sonarr. The cache is empty after a restart: we catch up slowly.
  private takeNotFoundSlot(): boolean {
    const now = Date.now();
    this.notFoundCheckTimes = this.notFoundCheckTimes.filter(
      (t) => now - t < 60000
    );
    if (this.notFoundCheckTimes.length >= MAX_NOT_FOUND_CHECKS_PER_MINUTE) {
      return false;
    }
    this.notFoundCheckTimes.push(now);
    return true;
  }

  private async checkNotFound<
    T extends { id?: number; added: string },
  >(options: {
    kind: 'Radarr' | 'Sonarr';
    mediaType: MediaType;
    cache: NotFoundCache;
    serverIds: number[];
    loadItems: () => Promise<T[]>;
    // wanted: monitored, released, without file, not in the queue
    isWanted: (item: T) => boolean;
    search: (item: T) => Promise<Parameters<typeof evaluateReleases>[0]>;
  }) {
    const { kind, mediaType, cache, serverIds, loadItems, isWanted, search } =
      options;
    const notified = this.getNotified();
    const notifiedKey = (id: number) => `${kind}:${serverIds[0]}:${id}`;
    const busyKey = `${kind}:${serverIds[0]}`;
    if (this.notFoundBusy.has(busyKey)) return;

    this.notFoundBusy.add(busyKey);
    try {
      const items = await loadItems();
      const wanted = items.filter(
        (item) => item.id !== undefined && isWanted(item)
      );
      // an item that is no longer wanted (queued, has a file...) is forgotten,
      // so that a future outage is announced again
      items
        .filter((item) => item.id !== undefined && !wanted.includes(item))
        .forEach((item) => {
          serverIds.forEach((sid) => cache.clear(sid, item.id as number));
          notified.remove(notifiedKey(item.id as number));
        });
      // item deleted from Radarr/Sonarr
      notified.retain(
        (key) =>
          !key.startsWith(`${kind}:${serverIds[0]}:`) ||
          items.some((item) => notifiedKey(item.id as number) === key)
      );

      const due = cache.pickDue(
        serverIds[0],
        wanted.map((item) => ({ id: item.id as number, added: item.added })),
        MAX_NOT_FOUND_CHECKS_PER_MINUTE
      );
      for (const candidate of due) {
        if (!this.takeNotFoundSlot()) break;
        const item = wanted.find((i) => i.id === candidate.id) as T;
        let info: NotFoundInfo | null;
        try {
          info = evaluateReleases(await search(item));
        } catch (e) {
          logger.warn(`${kind} release check failed for item ${candidate.id}`, {
            label: 'Download Tracker',
            errorMessage: e.message,
          });
          // unknown result: look again soon, and let the other items go first
          serverIds.forEach((sid) =>
            cache.set(
              sid,
              candidate.id,
              null,
              Date.now() - NOT_FOUND_RECHECK_MS + NOT_FOUND_RETRY_MS
            )
          );
          continue;
        }
        serverIds.forEach((sid) => cache.set(sid, candidate.id, info));
        if (info && !notified.has(notifiedKey(candidate.id))) {
          // announce once per outage (the file survives restarts)
          const sent = await notifyNotFound(
            mediaType,
            serverIds,
            candidate.id,
            info
          );
          if (sent > 0) notified.add(notifiedKey(candidate.id));
        }
        logger.debug(
          `${kind} release check for item ${candidate.id}: ${
            info ? `not found (${info.reason}, ${info.count})` : 'found'
          }`,
          { label: 'Download Tracker' }
        );
      }
    } catch (e) {
      logger.error(`Unable to check releases on ${kind}`, {
        label: 'Download Tracker',
        errorMessage: e.message,
      });
    } finally {
      this.notFoundBusy.delete(busyKey);
    }
  }

  public getMovieProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.radarrServers[serverId]) {
      return [];
    }

    return this.radarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.sonarrServers[serverId]) {
      return [];
    }

    return this.sonarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
  }

  public updateDownloads() {
    this.updateRadarrDownloads();
    this.updateSonarrDownloads();
  }

  private async updateRadarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.radarr, (radarrA, radarrB) => {
      return (
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
      );
    });

    // Load downloads from Radarr servers
    Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const radarr = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          try {
            await radarr.refreshMonitoredDownloads();
            const queueItems = await radarr.getQueue();

            this.radarrServers[server.id] = queueItems.map((item) => ({
              externalId: item.movieId,
              estimatedCompletionTime: new Date(item.estimatedCompletionTime),
              mediaType: MediaType.MOVIE,
              size: item.size,
              sizeLeft: item.sizeleft,
              status: item.status,
              timeLeft: item.timeleft,
              title: item.title,
              downloadId: item.downloadId,
            }));

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Radarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }

            const queued = new Set(queueItems.map((item) => item.movieId));
            await this.checkNotFound({
              kind: 'Radarr',
              mediaType: MediaType.MOVIE,
              cache: this.radarrNotFound,
              serverIds: [
                server.id,
                ...settings.radarr
                  .filter(
                    (rs) =>
                      rs.hostname === server.hostname &&
                      rs.port === server.port &&
                      rs.baseUrl === server.baseUrl &&
                      rs.id !== server.id &&
                      rs.syncEnabled
                  )
                  .map((rs) => rs.id),
              ],
              loadItems: () => radarr.getMovies(),
              isWanted: (m) =>
                m.monitored && m.isAvailable && !m.hasFile && !queued.has(m.id),
              search: (m) => radarr.getReleases({ movieId: m.id }),
            });
          } catch {
            logger.error(
              `Unable to get queue from Radarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          const matchingServers = settings.radarr.filter(
            (rs) =>
              rs.hostname === server.hostname &&
              rs.port === server.port &&
              rs.baseUrl === server.baseUrl &&
              rs.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Radarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.radarrServers[ms.id] = this.radarrServers[server.id];
            }
          });
        }
      })
    );
  }

  private async updateSonarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
      return (
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
      );
    });

    // Load downloads from Sonarr servers
    Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const sonarr = new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          });

          try {
            await sonarr.refreshMonitoredDownloads();
            const queueItems = await sonarr.getQueue();

            this.sonarrServers[server.id] = queueItems.map((item) => ({
              externalId: item.seriesId,
              estimatedCompletionTime: new Date(item.estimatedCompletionTime),
              mediaType: MediaType.TV,
              size: item.size,
              sizeLeft: item.sizeleft,
              status: item.status,
              timeLeft: item.timeleft,
              title: item.title,
              episode: item.episode,
              downloadId: item.downloadId,
            }));

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Sonarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }

            const queued = new Set(queueItems.map((item) => item.seriesId));
            // The search is done on the first monitored regular season
            const searchSeason = (series: SonarrSeries) =>
              series.seasons.find((s) => s.seasonNumber > 0 && s.monitored);
            await this.checkNotFound({
              kind: 'Sonarr',
              mediaType: MediaType.TV,
              cache: this.sonarrNotFound,
              serverIds: [
                server.id,
                ...settings.sonarr
                  .filter(
                    (ss) =>
                      ss.hostname === server.hostname &&
                      ss.port === server.port &&
                      ss.baseUrl === server.baseUrl &&
                      ss.id !== server.id &&
                      ss.syncEnabled
                  )
                  .map((ss) => ss.id),
              ],
              loadItems: () => sonarr.getSeries(),
              isWanted: (series) =>
                series.monitored &&
                series.statistics.episodeFileCount === 0 &&
                !queued.has(series.id as number) &&
                // aired episodes exist (otherwise nothing can be found yet)
                (searchSeason(series)?.statistics?.episodeCount ?? 0) > 0,
              search: (series) =>
                sonarr.getReleases({
                  seriesId: series.id as number,
                  seasonNumber: searchSeason(series)?.seasonNumber as number,
                }),
            });
          } catch {
            logger.error(
              `Unable to get queue from Sonarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          const matchingServers = settings.sonarr.filter(
            (ss) =>
              ss.hostname === server.hostname &&
              ss.port === server.port &&
              ss.baseUrl === server.baseUrl &&
              ss.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Sonarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.sonarrServers[ms.id] = this.sonarrServers[server.id];
            }
          });
        }
      })
    );
  }
}

const downloadTracker = new DownloadTracker();

export default downloadTracker;
