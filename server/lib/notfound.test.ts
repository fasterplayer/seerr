import {
  evaluateEpisodes,
  evaluateMovie,
  NOT_FOUND_SETTLE_MS,
  NotFoundCache,
  NotifiedStore,
  oldestSearch,
} from '@server/lib/notfound';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const now = Date.parse('2026-10-28T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const none = new Set<number>();

const movie = (over: Record<string, unknown> = {}) => ({
  id: 10,
  monitored: true,
  isAvailable: true,
  hasFile: false,
  lastSearchTime: ago(HOUR) as string | null | undefined,
  ...over,
});

describe('evaluateMovie', () => {
  it('monitored, released, no file, searched, nothing grabbed: not found', () => {
    const info = evaluateMovie(movie(), none, [], now);
    assert.equal(info?.reason, 'searched');
    assert.equal(info?.count, 1);
    assert.equal(info?.checkedAt, ago(HOUR));
  });

  it('never searched by Radarr: not judged', () => {
    assert.equal(
      evaluateMovie(movie({ lastSearchTime: undefined }), none, [], now),
      null
    );
    assert.equal(
      evaluateMovie(movie({ lastSearchTime: null }), none, [], now),
      null
    );
  });

  it('in the queue (downloading, pending "delay", import blocked): off', () => {
    assert.equal(evaluateMovie(movie(), new Set([10]), [], now), null);
    // another movie in the queue changes nothing
    assert.notEqual(evaluateMovie(movie(), new Set([11]), [], now), null);
  });

  it('unmonitored, not released yet, or already has a file: off', () => {
    assert.equal(
      evaluateMovie(movie({ monitored: false }), none, [], now),
      null
    );
    assert.equal(
      evaluateMovie(movie({ isAvailable: false }), none, [], now),
      null
    );
    assert.equal(evaluateMovie(movie({ hasFile: true }), none, [], now), null);
  });

  it('searched then grabbed: off; a grab before the search does not count', () => {
    const grab = (date: string, movieId = 10) => ({ date, movieId });
    // grabbed 4 s after the start of the search (what Radarr records)
    const after = new Date(Date.parse(ago(HOUR)) + 4000).toISOString();
    assert.equal(evaluateMovie(movie(), none, [grab(after)], now), null);
    // same second
    assert.equal(evaluateMovie(movie(), none, [grab(ago(HOUR))], now), null);
    // grabbed long before the search (failed download, searched again since)
    assert.notEqual(
      evaluateMovie(movie(), none, [grab(ago(2 * HOUR))], now),
      null
    );
    // the grab of another movie is not ours
    assert.notEqual(
      evaluateMovie(movie(), none, [grab(ago(HOUR / 2), 11)], now),
      null
    );
  });

  it('a search that is still recent is not judged yet', () => {
    const recent = movie({ lastSearchTime: ago(NOT_FOUND_SETTLE_MS - 1000) });
    assert.equal(evaluateMovie(recent, none, [], now), null);
    assert.notEqual(evaluateMovie(recent, none, [], now + 2000), null);
  });
});

describe('evaluateEpisodes', () => {
  const episode = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    monitored: true,
    hasFile: false,
    airDateUtc: ago(24 * HOUR) as string | null | undefined,
    lastSearchTime: ago(HOUR) as string | null | undefined,
    ...over,
  });

  it('aired, monitored, missing and searched episodes: not found', () => {
    const info = evaluateEpisodes([episode(1), episode(2)], [], now);
    assert.equal(info?.reason, 'searched');
    assert.equal(info?.count, 2);
    assert.equal(info?.checkedAt, ago(HOUR));
  });

  it('one searched episode is enough, the others may be unsearched', () => {
    const info = evaluateEpisodes(
      [episode(1), episode(2, { lastSearchTime: undefined })],
      [],
      now
    );
    assert.equal(info?.count, 1);
  });

  it('nothing searched, or no wanted episode: not judged', () => {
    assert.equal(
      evaluateEpisodes([episode(1, { lastSearchTime: undefined })], [], now),
      null
    );
    assert.equal(evaluateEpisodes([], [], now), null);
    // unaired, unmonitored, with file: not wanted, even if searched
    assert.equal(
      evaluateEpisodes(
        [
          episode(1, { airDateUtc: new Date(now + HOUR).toISOString() }),
          episode(2, { monitored: false }),
          episode(3, { hasFile: true }),
          episode(4, { airDateUtc: undefined }),
        ],
        [],
        now
      ),
      null
    );
  });

  it('checkedAt is the latest search of the episodes without grab', () => {
    const info = evaluateEpisodes(
      [
        episode(1, { lastSearchTime: ago(3 * HOUR) }),
        episode(2, { lastSearchTime: ago(2 * HOUR) }),
        episode(3, { lastSearchTime: ago(HOUR) }),
      ],
      [{ date: ago(HOUR / 2), episodeId: 3 }],
      now
    );
    assert.equal(info?.count, 2);
    assert.equal(info?.checkedAt, ago(2 * HOUR));
  });

  it('grabbed after the search: that episode is not "nothing found"', () => {
    const episodes = [episode(1), episode(2)];
    const grabs = [
      { date: ago(HOUR / 2), episodeId: 1 },
      { date: ago(HOUR / 2), episodeId: 2 },
    ];
    // every searched episode was grabbed (failed or removed since): off
    assert.equal(evaluateEpisodes(episodes, grabs, now), null);
    // only one grabbed: the other one is still not found
    assert.equal(evaluateEpisodes(episodes, grabs.slice(0, 1), now)?.count, 1);
    // grabbed before the search: does not count
    assert.equal(
      evaluateEpisodes(episodes, [{ date: ago(2 * HOUR), episodeId: 1 }], now)
        ?.count,
      2
    );
  });

  it('waits while a season search is still running', () => {
    // anime season searched episode by episode: the last one is 1 min old
    const episodes = [
      episode(1, { lastSearchTime: ago(5 * 60 * 1000) }),
      episode(2, { lastSearchTime: ago(60 * 1000) }),
    ];
    assert.equal(evaluateEpisodes(episodes, [], now), null);
    assert.notEqual(
      evaluateEpisodes(episodes, [], now + NOT_FOUND_SETTLE_MS),
      null
    );
  });
});

describe('oldestSearch', () => {
  it('returns the oldest lastSearchTime, undefined without any', () => {
    assert.equal(
      oldestSearch([
        { lastSearchTime: ago(HOUR) },
        { lastSearchTime: ago(3 * HOUR) },
        {},
        { lastSearchTime: null },
      ]),
      ago(3 * HOUR)
    );
    assert.equal(oldestSearch([{}, { lastSearchTime: null }]), undefined);
    assert.equal(oldestSearch([]), undefined);
  });
});

describe('NotFoundCache', () => {
  it('replace swaps the whole result of the servers', () => {
    const cache = new NotFoundCache();
    const info = {
      reason: 'searched' as const,
      count: 1,
      checkedAt: ago(HOUR),
    };
    cache.replace([1, 2], new Map([[7, info]]));
    assert.equal(cache.get(1, 7)?.reason, 'searched');
    assert.equal(cache.get(2, 7)?.checkedAt, ago(HOUR));
    assert.equal(cache.get(3, 7), undefined);
    cache.replace([1], new Map());
    assert.equal(cache.get(1, 7), undefined);
    assert.equal(cache.get(2, 7)?.reason, 'searched');
  });
});

describe('NotifiedStore', () => {
  const tmp = () =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notified-')), 'n.json');

  it('remembers across instances (restart) and forgets on remove', () => {
    const file = tmp();
    const a = new NotifiedStore(file);
    assert.equal(a.has('Radarr:1:5'), false);
    a.add('Radarr:1:5');
    a.add('Sonarr:1:7');
    const b = new NotifiedStore(file);
    assert.equal(b.has('Radarr:1:5'), true);
    b.remove('Radarr:1:5');
    assert.equal(new NotifiedStore(file).has('Radarr:1:5'), false);
    assert.equal(new NotifiedStore(file).has('Sonarr:1:7'), true);
    assert.equal(fs.existsSync(file + '.tmp'), false);
  });

  it('retain drops the keys that no longer match', () => {
    const file = tmp();
    const a = new NotifiedStore(file);
    a.add('Radarr:1:5');
    a.add('Radarr:1:6');
    a.retain((key) => key.endsWith(':6'));
    const b = new NotifiedStore(file);
    assert.equal(b.has('Radarr:1:5'), false);
    assert.equal(b.has('Radarr:1:6'), true);
  });

  it('starts empty on a missing or corrupt file', () => {
    const file = tmp();
    assert.equal(new NotifiedStore(file).has('x'), false);
    fs.writeFileSync(file, '{not json');
    assert.equal(new NotifiedStore(file).has('x'), false);
  });
});
