// Tautulli API v2 shim backed by Tracearr.
//
// Answers the five Tautulli calls Seerr makes (see Seerr's server/api/tautulli.ts)
// from Tracearr's public API v2, so Seerr's watch data keeps working without
// Tautulli. Plex rating keys are resolved to TMDB/TVDB/IMDb ids through Plex,
// because Tracearr's media refs are provider ids, not Plex rating keys.
//
// No dependencies: Node's built-in http and fetch only.

import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SHIM_VERSION = '2.15.0'; // reported as tautulli_version; Seerr requires >= 2.9.0

// FOO or FOO_FILE (repo convention); both set is an error.
export function readSecret(env, name, { required = true } = {}) {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct && file) throw new Error(`${name} and ${name}_FILE are both set`);
  if (file) return fs.readFileSync(file, 'utf8').trim();
  if (direct) return direct;
  if (required) throw new Error(`${name} or ${name}_FILE is required`);
  return undefined;
}

export function loadConfig(env = process.env) {
  const cfg = {
    port: Number(env.PORT ?? 8181),
    tracearrUrl: (env.TRACEARR_URL ?? '').replace(/\/+$/, ''),
    tracearrApiKey: readSecret(env, 'TRACEARR_API_KEY'),
    plexUrl: (env.PLEX_URL ?? '').replace(/\/+$/, ''),
    plexToken: readSecret(env, 'PLEX_TOKEN'),
    apiKey: readSecret(env, 'SHIM_API_KEY'),
    cacheTtlMs: Number(env.CACHE_TTL_SECONDS ?? 300) * 1000,
    // plex.tv id of the server owner, whom Tracearr stores as local account 1.
    // Looked up from plex.tv with PLEX_TOKEN when unset.
    plexOwnerId: env.PLEX_OWNER_ID || undefined,
    plexTvUrl: env.PLEX_TV_URL ?? 'https://plex.tv',
  };
  if (!cfg.tracearrUrl) throw new Error('TRACEARR_URL is required');
  if (!cfg.plexUrl) throw new Error('PLEX_URL is required');
  return cfg;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isInteger(n) ? n : v;
}

const epoch = (iso) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null);

// Tracearr's stats windows -> Tautulli's query_days.
const WINDOW_DAYS = { all_time: 0, last_30: 30, last_7: 7 };

export function createShim(cfg, fetchImpl = fetch) {
  const cache = new Map();
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await fn();
    cache.set(key, { value, expires: Date.now() + cfg.cacheTtlMs });
    return value;
  }

  async function tracearr(path, { allow404 = false } = {}) {
    const res = await fetchImpl(`${cfg.tracearrUrl}/api/v2/public${path}`, {
      headers: { Authorization: `Bearer ${cfg.tracearrApiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new HttpError(502, `Tracearr ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }

  async function plexMetadata(ratingKey) {
    const res = await fetchImpl(`${cfg.plexUrl}/library/metadata/${encodeURIComponent(ratingKey)}`, {
      headers: { 'X-Plex-Token': cfg.plexToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(502, `Plex /library/metadata: HTTP ${res.status}`);
    const body = await res.json();
    return body?.MediaContainer?.Metadata?.[0] ?? null;
  }

  // Plex rating key -> Tracearr media ref ("movie:tmdb:603"), or null.
  async function mediaRef(ratingKey) {
    return cached(`ref:${ratingKey}`, async () => {
      const md = await plexMetadata(ratingKey);
      if (!md || !['movie', 'show', 'episode'].includes(md.type)) return null;
      const ids = {};
      for (const g of md.Guid ?? []) {
        const m = /^(tmdb|tvdb|imdb):\/\/(.+)$/.exec(g.id ?? '');
        if (m) ids[m[1]] = m[2];
      }
      for (const provider of ['tmdb', 'tvdb', 'imdb']) {
        if (ids[provider]) return `${md.type}:${provider}:${ids[provider]}`;
      }
      return null;
    });
  }

  // Plex's local account 1 is the server owner; Seerr knows the owner by plex.tv id.
  let ownerId = cfg.plexOwnerId;
  async function plexOwnerId() {
    if (ownerId) return ownerId;
    const res = await fetchImpl(`${cfg.plexTvUrl}/api/v2/user`, {
      headers: { 'X-Plex-Token': cfg.plexToken, 'X-Plex-Client-Identifier': 'tracearr-tautulli-shim', Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new HttpError(502, `plex.tv /api/v2/user: HTTP ${res.status}`);
    ownerId = String((await res.json()).id);
    return ownerId;
  }

  async function allUsers() {
    return cached('users', async () => {
      const users = [];
      let cursor;
      do {
        const q = new URLSearchParams({ pageSize: '100', include_removed: 'true' });
        if (cursor) q.set('cursor', cursor);
        const page = await tracearr(`/users?${q}`);
        users.push(...page.data);
        cursor = page.meta?.nextCursor;
      } while (cursor);
      for (const u of users) {
        const acct = (u.accounts ?? []).find((a) => a.server_type === 'plex' && a.external_user_id);
        u.plexId = !acct ? null : acct.external_user_id === '1' ? toInt(await plexOwnerId()) : toInt(acct.external_user_id);
      }
      return users;
    });
  }

  async function identityByPlexId(plexId) {
    const users = await allUsers();
    return users.find((u) => u.plexId !== null && String(u.plexId) === String(plexId)) ?? null;
  }

  async function plexServerIds() {
    return cached('plexServers', async () => {
      const body = await tracearr('/servers');
      const list = Array.isArray(body) ? body : (body.data ?? []);
      return list.filter((s) => s.server_type === 'plex' && !s.historical).map((s) => s.server_id);
    });
  }

  function statsRows(windows, wanted) {
    return Object.entries(WINDOW_DAYS)
      .filter(([, days]) => wanted.includes(days))
      .map(([key, days]) => ({
        query_days: days,
        // Media stats nest the totals under "combined"; user stats don't.
        total_plays: Number((windows?.[key]?.combined ?? windows?.[key])?.plays ?? 0),
        total_time: Math.round(Number((windows?.[key]?.combined ?? windows?.[key])?.watch_time_ms ?? 0) / 1000),
      }));
  }

  const handlers = {
    async get_tautulli_info() {
      return { tautulli_version: SHIM_VERSION, tautulli_install_type: 'tracearr-shim' };
    },

    async get_item_watch_time_stats(p) {
      const wanted = p.query_days ? p.query_days.split(',').map(Number) : [0, 7, 30];
      const ref = await mediaRef(p.rating_key);
      const stats = ref ? await tracearr(`/media/${encodeURIComponent(ref)}/stats`, { allow404: true }) : null;
      return statsRows(stats?.windows, wanted);
    },

    async get_item_user_stats(p) {
      const ref = await mediaRef(p.rating_key);
      if (!ref) return [];
      const body = await tracearr(`/media/${encodeURIComponent(ref)}/watchers`, { allow404: true });
      if (!body) return [];
      const users = await allUsers();
      const byId = new Map(users.map((u) => [u.id, u]));
      const out = new Map();
      for (const w of body.watchers ?? []) {
        const identity = byId.get(w.user?.user_id);
        const plexId = identity ? identity.plexId : null;
        if (plexId === null) continue; // no Plex account: Seerr can't match it anyway
        const row = out.get(plexId) ?? {
          user_id: plexId,
          username: identity.username,
          friendly_name: identity.identity_name ?? identity.username,
          total_plays: 0,
          total_time: 0,
        };
        row.total_plays += Number(w.plays ?? w.play_count ?? 0);
        row.total_time += Math.round(Number(w.watch_time_ms ?? 0) / 1000);
        out.set(plexId, row);
      }
      return [...out.values()].sort((a, b) => b.total_plays - a.total_plays);
    },

    async get_user_watch_time_stats(p) {
      const wanted = p.query_days ? p.query_days.split(',').map(Number) : [1, 7, 30, 0];
      const identity = await identityByPlexId(p.user_id);
      const stats = identity ? await tracearr(`/users/${identity.id}/stats`, { allow404: true }) : null;
      return statsRows(stats?.windows, wanted);
    },

    async get_history(p) {
      const start = Number(p.start ?? 0);
      const length = Number(p.length ?? 25);
      const types = p.media_type ? p.media_type.split(',') : null;
      const empty = { recordsFiltered: 0, recordsTotal: 0, draw: Number(p.draw ?? 1), data: [] };
      if (!p.user_id) throw new HttpError(400, 'get_history without user_id is not supported');
      const identity = await identityByPlexId(p.user_id);
      if (!identity) return empty;
      const plexServers = await plexServerIds();

      // Tracearr pages by cursor; Seerr pages by offset. Walk until start+length
      // matching rows (Plex only: Seerr matches on Plex rating keys).
      const rows = [];
      const perServer = plexServers.map((sid) => ({ sid, cursor: undefined, done: false }));
      for (const s of perServer) {
        while (!s.done && rows.length < start + length) {
          const q = new URLSearchParams({ pageSize: '100', user_id: identity.id, server_id: s.sid });
          if (s.cursor) q.set('cursor', s.cursor);
          const page = await tracearr(`/history?${q}`);
          for (const r of page.data) {
            if (types && !types.includes(r.media_type)) continue;
            // Seerr matches episodes on the show key and everything else on the
            // item key; a row without it (e.g. a short session) is useless to it.
            if (!(r.media_type === 'episode' ? r.grandparent_rating_key : r.rating_key)) continue;
            rows.push(r);
          }
          s.cursor = page.meta?.nextCursor;
          s.done = !s.cursor;
        }
      }
      rows.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
      const data = rows.slice(start, start + length).map((r) => ({
        reference_id: r.reference_id,
        date: epoch(r.started_at),
        started: epoch(r.started_at),
        stopped: epoch(r.stopped_at),
        user_id: toInt(p.user_id),
        user: identity.username,
        friendly_name: identity.identity_name ?? identity.username,
        media_type: r.media_type,
        rating_key: toInt(r.rating_key),
        parent_rating_key: toInt(r.parent_rating_key),
        grandparent_rating_key: toInt(r.grandparent_rating_key),
        title: r.media_title,
        grandparent_title: r.show_title ?? '',
        full_title: r.show_title ? `${r.show_title} - ${r.media_title}` : r.media_title,
        year: r.year ?? '',
        media_index: r.episode_number ?? '',
        parent_media_index: r.season_number ?? '',
        play_duration: Math.round(Number(r.duration_ms ?? 0) / 1000),
        percent_complete: r.percent_complete ?? 0,
        watched_status: r.watched ? 1 : 0,
        platform: r.platform,
        player: r.player,
        product: r.product,
      }));
      return { recordsFiltered: rows.length, recordsTotal: rows.length, draw: Number(p.draw ?? 1), data };
    },
  };

  async function handle(params) {
    if (params.apikey !== cfg.apiKey) throw new HttpError(401, 'Invalid apikey');
    const fn = handlers[params.cmd];
    if (!fn) throw new HttpError(400, `Unsupported cmd: ${params.cmd}`);
    return fn(params);
  }

  return { handle, handlers };
}

const envelope = (result, message, data) => JSON.stringify({ response: { result, message, data } });

export function createServer(shim, log = console) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://shim');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname !== '/api/v2') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const params = Object.fromEntries(url.searchParams);
    const started = Date.now();
    try {
      const data = await shim.handle(params);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(envelope('success', null, data));
      log.log(`${params.cmd} 200 ${Date.now() - started}ms`);
    } catch (e) {
      const status = e.status ?? 500;
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(envelope('error', e.message, {}));
      log.error(`${params.cmd} ${status} ${e.message}`);
    }
  });
}

// Compare real paths: Node resolves symlinks (e.g. a ConfigMap mount) in import.meta.url.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const cfg = loadConfig();
  const server = createServer(createShim(cfg));
  server.listen(cfg.port, () => console.log(`tracearr-tautulli-shim listening on :${cfg.port}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
