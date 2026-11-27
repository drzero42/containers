import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShim, createServer, readSecret } from './server.mjs';

const PLEX_SERVER = '11111111-1111-1111-1111-111111111111';
const JF_SERVER = '22222222-2222-2222-2222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // Plex + Jellyfin
const BOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // Jellyfin only
const OWNER = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // Plex server owner (local account 1)

const users = [
  {
    id: ALICE, username: 'alice', identity_name: 'Alice', accounts: [
      { server_type: 'plex', external_user_id: '1001' },
      { server_type: 'jellyfin', external_user_id: 'jf-alice' },
    ],
  },
  { id: BOB, username: 'bob', identity_name: null, accounts: [{ server_type: 'jellyfin', external_user_id: 'jf-bob' }] },
  { id: OWNER, username: 'owner', identity_name: null, accounts: [{ server_type: 'plex', external_user_id: '1' }] },
];

const plexItems = {
  500: { type: 'movie', Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }] },
  600: { type: 'show', Guid: [{ id: 'tvdb://81189' }] },
  700: { type: 'season', Guid: [] },
};

function historyRow(i, extra) {
  return {
    reference_id: `ref-${i}`, started_at: new Date(Date.UTC(2026, 10, 20, 0, 0, 0) - i * 3600e3).toISOString(),
    stopped_at: null, media_type: 'movie', media_title: `Movie ${i}`, show_title: null,
    rating_key: String(1000 + i), parent_rating_key: null, grandparent_rating_key: null,
    duration_ms: 60000, watched: true, ...extra,
  };
}
// 150 Plex rows for alice (2 pages): every 3rd is an episode, every 10th a track,
// plus one episode without a show key at the end (dropped).
const plexHistory = [...Array.from({ length: 150 }, (_, i) =>
  historyRow(i, i % 10 === 9 ? { media_type: 'track' }
    : i % 3 === 0 ? { media_type: 'episode', show_title: 'Show', rating_key: String(2000 + i), parent_rating_key: '20', grandparent_rating_key: '600' }
    : {})), historyRow(150, { media_type: 'episode', grandparent_rating_key: '' })];

const calls = [];
async function fakeFetch(url, opts) {
  const u = new URL(url);
  calls.push(u.pathname + u.search);
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (u.host === 'plextv') {
    assert.equal(u.pathname, '/api/v2/user');
    return json({ id: 6181169, username: 'owner' });
  }
  if (u.host === 'plex') {
    assert.equal(opts.headers['X-Plex-Token'], 'plex-token');
    const key = u.pathname.split('/').pop();
    return plexItems[key] ? json({ MediaContainer: { Metadata: [plexItems[key]] } }) : json({}, 404);
  }
  assert.equal(opts.headers.Authorization, 'Bearer trr-key');
  const p = decodeURIComponent(u.pathname.replace('/api/v2/public', ''));
  if (p === '/users') return json({ data: users, meta: { nextCursor: null } });
  if (p === '/servers') return json({ data: [{ server_id: PLEX_SERVER, server_type: 'plex', historical: false }, { server_id: JF_SERVER, server_type: 'jellyfin', historical: false }] });
  if (p === '/media/movie:tmdb:603/stats')
    return json({ windows: { all_time: { combined: { plays: 9, watch_time_ms: 3600000, unique_users: 2 }, per_server: [] }, last_30: { combined: { plays: 4, watch_time_ms: 0 } }, last_7: { combined: { plays: 1, watch_time_ms: 0 } } } });
  if (p === '/media/show:tvdb:81189/stats') return json({ windows: { all_time: { combined: { plays: 42, watch_time_ms: 0 } } } });
  if (p === '/media/movie:tmdb:603/watchers')
    return json({ watchers: [
      { user: { user_id: ALICE }, plays: 5, watch_time_ms: 120000 },
      { user: { user_id: ALICE }, plays: 2, watch_time_ms: 60000 }, // second (Jellyfin) account
      { user: { user_id: BOB }, plays: 2, watch_time_ms: 0 },
      { user: { user_id: OWNER }, plays: 1, watch_time_ms: 0 },
    ] });
  if (p === `/users/${OWNER}/stats`) return json({ windows: { all_time: { plays: 7, watch_time_ms: 0 } } });
  if (p === `/users/${ALICE}/stats`) return json({ windows: { all_time: { plays: 321, watch_time_ms: 7200000 }, last_30: { plays: 3, watch_time_ms: 0 }, last_7: { plays: 0, watch_time_ms: 0 } } });
  if (p === '/history') {
    assert.equal(u.searchParams.get('user_id'), ALICE);
    assert.equal(u.searchParams.get('server_id'), PLEX_SERVER);
    const offset = Number(u.searchParams.get('cursor') ?? 0);
    const data = plexHistory.slice(offset, offset + 100);
    return json({ data, meta: { nextCursor: offset + 100 < plexHistory.length ? String(offset + 100) : null } });
  }
  return json({ error: 'not found' }, 404);
}

const cfg = { tracearrUrl: 'http://tracearr', tracearrApiKey: 'trr-key', plexUrl: 'http://plex', plexTvUrl: 'http://plextv', plexToken: 'plex-token', apiKey: 'seerr-key', cacheTtlMs: 60000 };
const shim = createShim(cfg, fakeFetch);
const call = (params) => shim.handle({ apikey: 'seerr-key', ...params });

test('rejects a wrong apikey', async () => {
  await assert.rejects(shim.handle({ apikey: 'nope', cmd: 'get_tautulli_info' }), { status: 401 });
});

test('get_tautulli_info passes Seerr\'s >= 2.9.0 version check', async () => {
  const d = await call({ cmd: 'get_tautulli_info' });
  const [maj, min] = d.tautulli_version.split('.').map(Number);
  assert.ok(maj > 2 || (maj === 2 && min >= 9));
});

test('get_item_watch_time_stats maps windows to query_days for a movie', async () => {
  const d = await call({ cmd: 'get_item_watch_time_stats', rating_key: '500', grouping: '1' });
  assert.equal(d.find((r) => r.query_days == 0).total_plays, 9);
  assert.equal(d.find((r) => r.query_days == 0).total_time, 3600);
  assert.equal(d.find((r) => r.query_days == 30).total_plays, 4);
  assert.equal(d.find((r) => r.query_days == 7).total_plays, 1);
});

test('get_item_watch_time_stats falls back to tvdb for a show', async () => {
  const d = await call({ cmd: 'get_item_watch_time_stats', rating_key: '600', grouping: '1' });
  assert.equal(d.find((r) => r.query_days == 0).total_plays, 42);
  assert.equal(d.find((r) => r.query_days == 7).total_plays, 0);
});

test('unknown or unsupported rating keys give zero plays, not errors', async () => {
  for (const rk of ['999', '700']) {
    const d = await call({ cmd: 'get_item_watch_time_stats', rating_key: rk, grouping: '1' });
    assert.deepEqual(d.map((r) => r.total_plays), [0, 0, 0]);
    assert.deepEqual(await call({ cmd: 'get_item_user_stats', rating_key: rk }), []);
  }
});

test('get_item_user_stats returns Plex account ids and merges accounts of one identity', async () => {
  const d = await call({ cmd: 'get_item_user_stats', rating_key: '500', grouping: '1' });
  assert.deepEqual(d.map((u) => u.user_id), [1001, 6181169]); // bob has no Plex account; owner 1 -> plex.tv id
  assert.equal(d[0].total_plays, 7);
  assert.equal(typeof d[0].user_id, 'number');
});

test('get_user_watch_time_stats: Seerr reads [0].total_plays with query_days=0', async () => {
  const d = await call({ cmd: 'get_user_watch_time_stats', user_id: '1001', query_days: '0', grouping: '1' });
  assert.equal(d.length, 1);
  assert.equal(d[0].total_plays, 321);
  const owner = await call({ cmd: 'get_user_watch_time_stats', user_id: '6181169', query_days: '0' });
  assert.equal(owner[0].total_plays, 7);
  const none = await call({ cmd: 'get_user_watch_time_stats', user_id: '424242', query_days: '0' });
  assert.equal(none[0].total_plays, 0);
});

test('get_history pages by offset over Tracearr cursors, newest first, filtered by media_type', async () => {
  const base = { cmd: 'get_history', user_id: '1001', media_type: 'movie,episode', order_column: 'date', order_dir: 'desc', grouping: '1' };
  const p1 = (await call({ ...base, start: '0', length: '100' })).data;
  const p2 = (await call({ ...base, start: '100', length: '100' })).data;
  const p3 = (await call({ ...base, start: '200', length: '100' })).data;
  assert.equal(p1.length, 100);
  assert.equal(p2.length, 135 - 100); // 150 rows minus 15 tracks
  assert.equal(p3.length, 0); // Seerr stops on an empty page
  const all = [...p1, ...p2];
  assert.ok(all.every((r) => r.media_type !== 'track'));
  assert.ok(all.every((r, i) => i === 0 || all[i - 1].date >= r.date));
  const ep = all.find((r) => r.media_type === 'episode');
  assert.equal(ep.grandparent_rating_key, 600); // number: Seerr compares parseInt(...) === value
  assert.equal(typeof all.find((r) => r.media_type === 'movie').rating_key, 'number');
  assert.equal(all.find((r) => r.media_type === 'movie').grandparent_rating_key, '');
});

test('get_history for an unknown Plex user is empty', async () => {
  const d = await call({ cmd: 'get_history', user_id: '424242', start: '0', length: '100' });
  assert.deepEqual(d.data, []);
});

test('HTTP server wraps results in Tautulli\'s envelope', async () => {
  const server = createServer(shim, { log() {}, error() {} });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const ok = await (await fetch(`http://127.0.0.1:${port}/api/v2?apikey=seerr-key&cmd=get_tautulli_info`)).json();
    assert.equal(ok.response.result, 'success');
    assert.ok(ok.response.data.tautulli_version);
    const bad = await fetch(`http://127.0.0.1:${port}/api/v2?apikey=x&cmd=get_tautulli_info`);
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).response.result, 'error');
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  } finally {
    server.close();
  }
});

test('readSecret: FOO and FOO_FILE both set is an error', () => {
  assert.throws(() => readSecret({ A: 'x', A_FILE: '/x' }, 'A'), /both set/);
  assert.equal(readSecret({ A: 'x' }, 'A'), 'x');
});
