import {
  evaluateReleases,
  NOT_FOUND_MIN_AGE_MS,
  NOT_FOUND_RECHECK_MS,
  NOT_FOUND_RETRY_MS,
  NotFoundCache,
  NotifiedStore,
} from '@server/lib/notfound';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const ok = { title: 'ok', rejected: false, rejections: [] };
const rejected = (...rejections: string[]) => ({
  title: 'r',
  rejected: true,
  rejections,
});

describe('evaluateReleases', () => {
  it('no result at all is "noResults"', () => {
    const info = evaluateReleases([]);
    assert.equal(info?.reason, 'noResults');
    assert.equal(info?.count, 0);
  });

  it('one acceptable release means found', () => {
    assert.equal(evaluateReleases([rejected('Not enough seeders'), ok]), null);
    assert.equal(evaluateReleases([ok, ok, ok, ok]), null);
  });

  it('all rejected: counts them and keeps the most frequent rejection', () => {
    const info = evaluateReleases([
      rejected('Not enough seeders: 0 (minimum: 1)'),
      rejected(
        'Size: 1 GiB is smaller than minimum',
        'Not enough seeders: 0 (minimum: 1)'
      ),
      rejected('Not enough seeders: 0 (minimum: 1)'),
    ]);
    assert.equal(info?.reason, 'rejected');
    assert.equal(info?.count, 3);
    assert.equal(info?.rejection, 'Not enough seeders: 0 (minimum: 1)');
  });

  it('groups rejections that only differ by numbers', () => {
    const info = evaluateReleases([
      rejected('Size: 12.3 GiB is larger than maximum allowed 10 GiB'),
      rejected('Size: 40 GiB is larger than maximum allowed 10 GiB'),
      rejected('Other reason'),
    ]);
    assert.match(info?.rejection ?? '', /^Size: /);
  });

  it('a release without rejection list is tolerated', () => {
    const info = evaluateReleases([{ title: 'x', rejected: true }]);
    assert.equal(info?.reason, 'rejected');
    assert.equal(info?.rejection, undefined);
  });
});

describe('NotFoundCache', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const old = '2026-10-01T00:00:00Z';

  it('skips items added less than 2 minutes ago', () => {
    const cache = new NotFoundCache();
    const fresh = new Date(now - NOT_FOUND_MIN_AGE_MS + 1000).toISOString();
    const aged = new Date(now - NOT_FOUND_MIN_AGE_MS).toISOString();
    const due = cache.pickDue(
      1,
      [
        { id: 1, added: fresh },
        { id: 2, added: aged },
      ],
      10,
      now
    );
    assert.deepEqual(
      due.map((d) => d.id),
      [2]
    );
  });

  it('does not recheck within 24 h, rechecks after', () => {
    const cache = new NotFoundCache();
    cache.set(1, 5, null, now);
    assert.equal(
      cache.pickDue(1, [{ id: 5, added: old }], 10, now + 1000).length,
      0
    );
    assert.equal(
      cache.pickDue(
        1,
        [{ id: 5, added: old }],
        10,
        now + NOT_FOUND_RECHECK_MS - 1
      ).length,
      0
    );
    assert.equal(
      cache.pickDue(1, [{ id: 5, added: old }], 10, now + NOT_FOUND_RECHECK_MS)
        .length,
      1
    );
    // another server has its own entries
    assert.equal(cache.pickDue(2, [{ id: 5, added: old }], 10, now).length, 1);
  });

  it('a backdated entry (failed search) is checked again after 30 minutes', () => {
    const cache = new NotFoundCache();
    cache.set(1, 9, null, now - NOT_FOUND_RECHECK_MS + NOT_FOUND_RETRY_MS);
    const due = (t: number) => cache.pickDue(1, [{ id: 9, added: old }], 10, t);
    assert.equal(due(now + NOT_FOUND_RETRY_MS - 1000).length, 0);
    assert.equal(due(now + NOT_FOUND_RETRY_MS).length, 1);
  });

  it('honours the limit and checks the least recently checked first', () => {
    const cache = new NotFoundCache();
    cache.set(1, 2, null, now - NOT_FOUND_RECHECK_MS - 5000);
    cache.set(1, 3, null, now - NOT_FOUND_RECHECK_MS - 1000);
    const due = cache.pickDue(
      1,
      [
        { id: 3, added: old },
        { id: 2, added: old },
        { id: 4, added: old },
      ],
      2,
      now
    );
    assert.deepEqual(
      due.map((d) => d.id),
      [4, 2]
    );
  });

  it('exposes only "not found" results and forgets on clear', () => {
    const cache = new NotFoundCache();
    const info = evaluateReleases([]);
    cache.set(1, 7, info, now);
    cache.set(1, 8, null, now);
    assert.equal(cache.get(1, 7)?.reason, 'noResults');
    assert.equal(cache.get(1, 8), undefined);
    cache.clear(1, 7);
    assert.equal(cache.get(1, 7), undefined);
    assert.equal(cache.pickDue(1, [{ id: 7, added: old }], 10, now).length, 1);
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
