# tracearr-tautulli-shim

Answers the Tautulli API v2 calls that [Seerr](https://github.com/seerr-team/seerr) makes, using [Tracearr](https://github.com/connorgallopo/Tracearr)'s public API v2. Seerr's watch data (play counts and viewers on media pages, a user's play count and recently watched) keeps working after Tautulli is retired. Seerr has no native Tracearr support yet (seerr-team/seerr#2449).

Supported commands: `get_tautulli_info`, `get_item_watch_time_stats`, `get_item_user_stats`, `get_user_watch_time_stats` and `get_history` (with `user_id`). Anything else returns an error.

## How it maps

- Seerr sends Plex rating keys. The shim asks Plex for the item's TMDB, TVDB or IMDb GUID and queries Tracearr's `/media/<type>:<provider>:<id>` with it. Show stats roll up their episodes in Tracearr.
- Seerr identifies users by Plex account id. The shim matches that to the Tracearr identity whose Plex account has that `external_user_id`, translating the server owner's local id `1` to their plex.tv id. Link people's Plex and Jellyfin accounts in Tracearr, or their Jellyfin plays don't count toward their totals.
- Play counts come from Tracearr, so they include every server Tracearr tracks (Jellyfin too), not only Plex. Viewers without a Plex account are left out, since Seerr can't match them.
- `get_history` returns Plex plays only, because Seerr matches them on Plex rating keys.
- Media stats cover the title, not one Plex rating key: every Plex copy of a show (e.g. an older re-added one) and other servers count. Tautulli counts only the rating key asked for.
- Tracearr's 7- and 30-day windows are UTC calendar days, today inclusive; Tautulli's 30-day window reaches one day further back.

## Configuration

| Variable | |
|---|---|
| `TRACEARR_URL` | e.g. `http://tracearr:3000` |
| `TRACEARR_API_KEY` / `_FILE` | Tracearr public API key (`trr_pub_…`, Settings → API) |
| `PLEX_URL` | e.g. `http://plex:32400` |
| `PLEX_TOKEN` / `_FILE` | Plex token, for rating key → GUID lookups |
| `SHIM_API_KEY` / `_FILE` | The `apikey` Seerr must send. Reusing the old Tautulli key means Seerr only needs its hostname changed. |
| `PLEX_OWNER_ID` | plex.tv account id of the Plex server owner. Tracearr stores the owner as local account `1`; Seerr knows them by plex.tv id. When unset, it's looked up once from `https://plex.tv/api/v2/user` with `PLEX_TOKEN`. |
| `PORT` | Default `8181` |
| `CACHE_TTL_SECONDS` | Cache for rating key lookups and the user list. Default `300` |

Point Seerr's Tautulli settings at the shim's host and port. `/healthz` is a plain liveness endpoint.

## Tests

```sh
node --test images/tracearr-tautulli-shim/
```
