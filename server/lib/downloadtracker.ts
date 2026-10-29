import RadarrAPI from '@server/api/servarr/radarr';
import type { EpisodeResult } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import type { NotFoundInfo } from '@server/lib/notfound';
import {
  evaluateEpisodes,
  evaluateMovie,
  NotFoundCache,
  NotifiedStore,
  oldestSearch,
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

// The episodes of a candidate series are kept this long between two passes
// (Download Sync runs every minute; the queue is always read fresh).
const EPISODES_TTL_MS = 5 * 60 * 1000;

class DownloadTracker {
  private radarrServers: Record<number, DownloadingItem[]> = {};
  private sonarrServers: Record<number, DownloadingItem[]> = {};
  private radarrNotFound = new NotFoundCache();
  private sonarrNotFound = new NotFoundCache();
  private episodesCache = new Map<
    string,
    { at: number; episodes: EpisodeResult[] }
  >();
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

  private async getEpisodes(
    sonarr: SonarrAPI,
    serverId: number,
    seriesId: number
  ): Promise<EpisodeResult[]> {
    const key = `${serverId}:${seriesId}`;
    const cached = this.episodesCache.get(key);
    if (cached && Date.now() - cached.at < EPISODES_TTL_MS) {
      return cached.episodes;
    }
    const episodes = await sonarr.getEpisodes(seriesId);
    this.episodesCache.set(key, { at: Date.now(), episodes });
    return episodes;
  }

  /**
   * Read only: Seerr never searches, Radarr/Sonarr do. `evaluate` reads their
   * state (one list per server, the history only when needed) and returns the
   * items that are "not found".
   * A failed read changes nothing (the previous result stays).
   */
  private async syncNotFound(options: {
    kind: 'Radarr' | 'Sonarr';
    mediaType: MediaType;
    cache: NotFoundCache;
    serverIds: number[];
    evaluate: () => Promise<Map<number, NotFoundInfo>>;
  }) {
    const { kind, mediaType, cache, serverIds, evaluate } = options;
    const notified = this.getNotified();
    const notifiedKey = (id: number) => `${kind}:${serverIds[0]}:${id}`;
    const busyKey = `${kind}:${serverIds[0]}`;
    if (this.notFoundBusy.has(busyKey)) return;

    this.notFoundBusy.add(busyKey);
    try {
      const found = await evaluate();
      cache.replace(serverIds, found);

      // an item that is no longer "not found" (queued, has a file, deleted...)
      // is forgotten, so that a future outage is announced again
      notified.retain((key) => {
        if (!key.startsWith(`${kind}:${serverIds[0]}:`)) return true;
        const id = Number(key.split(':')[2]);
        return found.has(id);
      });

      for (const [id, info] of found) {
        if (notified.has(notifiedKey(id))) continue;
        // announce once per outage (the file survives restarts)
        const sent = await notifyNotFound(mediaType, serverIds, id, info);
        if (sent > 0) notified.add(notifiedKey(id));
        logger.debug(
          `${kind} item ${id} not found (searched at ${info.checkedAt}), ${sent} notification(s)`,
          { label: 'Download Tracker' }
        );
      }
    } catch (e) {
      logger.error(`Unable to check not found items on ${kind}`, {
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

            // the queue also lists the pending ("delay") releases
            const queued = new Set(queueItems.map((item) => item.movieId));
            await this.syncNotFound({
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
              evaluate: async () => {
                const movies = await radarr.getMovies();
                // monitored, released, no file, not in the queue, and
                // searched by Radarr
                const candidates = movies.filter(
                  (m) =>
                    m.monitored &&
                    m.isAvailable &&
                    !m.hasFile &&
                    !queued.has(m.id) &&
                    m.lastSearchTime
                );
                const since = oldestSearch(candidates);
                const grabs = since ? await radarr.getGrabbedSince(since) : [];
                const found = new Map<number, NotFoundInfo>();
                for (const movie of candidates) {
                  const info = evaluateMovie(movie, queued, grabs);
                  if (info) found.set(movie.id, info);
                }
                return found;
              },
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

            // the queue also lists the pending ("delay") releases
            const queued = new Set(queueItems.map((item) => item.seriesId));
            await this.syncNotFound({
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
              evaluate: async () => {
                const allSeries = await sonarr.getSeries();
                // Candidates: monitored, nothing in the queue, and aired
                // monitored episodes without file (series statistics): the
                // episodes are read for those series only.
                const candidates = allSeries.filter(
                  (series) =>
                    series.id !== undefined &&
                    series.monitored &&
                    !queued.has(series.id) &&
                    series.statistics.episodeCount >
                      series.statistics.episodeFileCount
                );
                const episodes = new Map<number, EpisodeResult[]>();
                for (const series of candidates) {
                  const id = series.id as number;
                  try {
                    episodes.set(
                      id,
                      await this.getEpisodes(sonarr, server.id, id)
                    );
                  } catch (e) {
                    logger.warn(
                      `Unable to read the episodes of Sonarr series ${id}`,
                      {
                        label: 'Download Tracker',
                        errorMessage: e.message,
                      }
                    );
                  }
                }
                for (const key of this.episodesCache.keys()) {
                  const [sid, id] = key.split(':').map(Number);
                  if (sid === server.id && !episodes.has(id)) {
                    this.episodesCache.delete(key);
                  }
                }
                const since = oldestSearch(
                  [...episodes.values()]
                    .flat()
                    .filter((episode) => !episode.hasFile)
                );
                const grabs = since ? await sonarr.getGrabbedSince(since) : [];
                const found = new Map<number, NotFoundInfo>();
                for (const series of candidates) {
                  const id = series.id as number;
                  const list = episodes.get(id);
                  // episodes unreadable this time: keep the previous result
                  const info = list
                    ? evaluateEpisodes(list, grabs)
                    : this.sonarrNotFound.get(server.id, id);
                  if (info) found.set(id, info);
                }
                return found;
              },
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
