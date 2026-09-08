# KO History

> Lightweight knowledge-object versioning for Splunk. Every dashboard, report, alert, macro, event type, and field extraction is snapshotted into a summary index on a cron, every DELETE and MOVE is captured from the audit log, and the bundled dashboards + React app page surface the full history with inline visual previews, side-by-side diffs, change overlays, and one-click restore of any past version.

## Why

A dashboard disappears, a critical alert gets overwritten, a report is lost, and Splunk keeps no user-facing version history. KO History gives you:

- **A version log per KO**: every change captured with timestamp, author, and full source.
- **An audit trail**: DELETE and MOVE actions linked to the user who performed them.
- **Restore scope**: all seven object types are captured, previewed and compared. **One-click restore covers dashboards and saved searches**; restore for macros, event types, field extractions, lookups and tags is implemented but disabled pending further testing.
- **Restore is opt-in**: it ships off for every object type and an admin enables it per type on the app's **Settings** page. It is the only operation that writes back into your environment; everything else works with it disabled.
- **Visual recovery**: preview *any* past version inline, diff two versions (boxes drawn over changed panels on the live render), then restore the source into any app in one click.
- **Survives deletion**: history lives in a separate summary index, so it outlives the object.

## What's in the box

| Path | Purpose |
|------|---------|
| `default/savedsearches.conf` | 15 stanzas: 7 type backups, 1 combined delete-audit, 7 one-time backfills, all feeding the index named by the `ko_history_index` macro. All ship disabled. |
| `default/data/ui/views/` | The dashboards: `wrapper.xml` (React page host), `ko_version.xml`, `ko_version_ds.xml`, `ko_help.xml`. |
| `appserver/static/visualizations/` | Three bundled custom vizs (see below). |
| `appserver/static/pages/wrapper.js` + `appserver/templates/wrapper.html` | The React app page (`@splunk/react-page`). |
| `default/data/ui/nav/default.xml` | App navigation. |
| `default/visualizations.conf` | Registers the three custom vizs. |
| `metadata/default.meta` | ACL (read: \*, write: admin/sc\_admin; vizs exported system-wide). |

### The scheduled searches (17 stanzas)

**ALL capture searches ship `disabled = 1`. Enable them after creating the index.**

Seven **backup** searches run on a staggered 15-minute cron (`realtime_schedule = 0`, `schedule_window = auto`) and write one event per object changed in the last 15 min (`_time` = the object's `updated` timestamp). One **combined delete-audit** runs hourly and captures DELETE/MOVE from `_internal` for all KO types. Seven **one-time backfill** searches are included for initial onboarding. Run each manually once, then leave disabled.

**Backups (15-min window)**

| Search name | Cron |
|---|---|
| `ko_views_xml_backup` | `3,18,33,48 * * * *` |
| `ko_reports_and_alerts_backup` | `6,21,36,51 * * * *` |
| `ko_macros_backup` | `9,24,39,54 * * * *` |
| `ko_eventtypes_backup` | `11,26,41,56 * * * *` |
| `ko_fieldextractions_backup` | `13,28,43,58 * * * *` |
| `ko_lookups_backup` | `12,27,42,57 * * * *` |
| `ko_tags_backup` | `0,15,30,45 * * * *` |

**Delete audit (hourly)**

| Search name | Cron |
|---|---|
| `ko_all_delete_audit` | `23 * * * *` |

**One-time backfills (run manually once; never schedule)**

`ko_views_xml_backfill`, `ko_reports_and_alerts_backfill`, `ko_macros_backfill`, `ko_eventtypes_backfill`, `ko_fieldextractions_backfill`, `ko_lookups_backfill`, `ko_tags_backfill`

All write to `index=ko_history`.

### The three bundled visualizations

| Viz | Role |
|---|---|
| `dashboard_preview` | Renders a saved dashboard (Studio or Simple XML) inline and overlays a visual diff between two versions. Use inside **classic Simple XML** hosts. |
| `source_viewer` | Any JSON or XML string as a syntax-highlighted, foldable, line-numbered listing with copy-to-clipboard. Used here for KO source, but not limited to it: point it at any field holding JSON or XML. Sandbox-safe. |
| `ko_viewer` | A Splunk-native **record card** for one KO version: bespoke profile for reports/alerts (definition, schedule, trigger actions, alert condition), generic profile for macros / event types / field extractions / etc. |

## Install

### Prerequisites

The **`ko_history` index** must exist before the capture searches start writing.

- **Splunk Enterprise (single search head):** `default/indexes.conf` ships with the app and defines `[ko_history]` with a 20-year frozen retention period. A full restart picks it up automatically, so no manual index creation is required.
- **Splunk Enterprise (indexer cluster):** the app-shipped `indexes.conf` applies only on the search head. Create `ko_history` through your cluster's index management (cluster master / manager) before enabling the searches.
- **Splunk Cloud:** indexes are managed platform-side. Create an Events index named `ko_history` via the Cloud Admin Console (ACS / Settings → Indexes → New Index) before enabling the searches. The bundled `indexes.conf` is inert on Cloud and can be ignored.

### Steps

1. Install the tarball (Manage Apps → Install app from file) or drop `ko_history/` into `$SPLUNK_HOME/etc/apps/`.
2. **`splunk restart`**: a full restart is required (the React page is served from a Mako template + static bundle that a reload won't refresh).
3. Enable the capture searches. The app's own **Settings → Searches** section lists every shipped search grouped by what it does, with a switch on each; Splunk's **Settings → Searches, reports, and alerts** works too. All ship disabled. Enable `ko_views_xml_backup` through `ko_tags_backup` and `ko_all_delete_audit` after the `ko_history` index exists. See *Scheduled searches* above for the full list.
4. Wait one cron cycle (~15 min), then open **Apps → KO History**.

## Configuration

### Permissions

`metadata/default.meta` restricts **both read and write to `admin` / `sc_admin`**, so the app is hidden from ordinary users by default. Two deliberate exceptions stay world-readable because they leak nothing and the app breaks without them: `ko_history.conf` (seven booleans the wrapper reads) and `[macros]` (the index name; every dashboard resolves it, so an admin-only macro would make the documented widen-access path produce a broken app). The custom vizs are exported `system`-wide so they appear in the viz picker of dashboards in any app; preview slots are always written into the `ko_history` app only. **Restore** and the live-preview write path require write on `data/ui/views` in `ko_history` for the acting user. **Do not broaden the `[views]` write stanza to additional roles.** Because all three vizs export as `system`, any role granted `[views]` write in this app gains a view create/overwrite primitive reachable from any dashboard fleet-wide, gated only by the client-side approval prompt, which is convenience, not security. If non-admin roles must use the preview or restore features, implement a constrained server-side endpoint (a custom REST handler that enforces per-user/per-slot limits) rather than expanding raw view-write permissions.

### The index name

The index the app reads from lives in one search macro, **`ko_history_index`**, which expands to
the bare name (`ko_history` by default). Every search resolves it as ``index=`ko_history_index` ``,
so changing the macro repoints every dashboard, the wrapper and the lookup builders at once.

Change it from **Settings → Index** in the app, or on *Settings → Advanced search → Search macros*.

**It governs reads, not writes.** Capture writes via `action.summary_index._name` on each saved
search, which is a saved-search setting and cannot reference a macro. Change the macro alone and
the dashboards read the new index while capture keeps filling the old one, which presents as an
app that suddenly lost its data. After changing the name, update `action.summary_index._name` on
every `ko_*_backup`, `ko_*_backfill` and `ko_all_delete_audit`
search to match. `README/DEPLOY.md` has a query that checks the two halves agree.

Whatever index you point at needs a long frozen period: the app stamps each event at the object's
own `updated` time, so snapshots carry dates years in the past and Splunk's ~6-year default would
freeze, meaning delete, the oldest history. This applies to Splunk Cloud too, where the bundled
`indexes.conf` is ignored entirely.

### Excluding noisy hosts from the delete audit

If a search head queries itself via REST and that shows up as DELETE noise, edit the relevant `*_delete_audit` search and append `NOT host=<your-sh>` to each union leg.

### Usage statistics

Not shipped. The app previously included a collector pair feeding a statistics dashboard; the dashboard was cut before release, which left the collectors writing `source=ko_usage` events that every shipped search then filtered out. Both were removed in 1.3.0.

The dashboard searches still carry `NOT source="ko_usage"` on purpose, so an index that already holds those events from an earlier version does not show them as junk rows.

## How it works

```
   staggered 15-min cron      REST: data/ui/views · saved/searches · data/props/extractions
            │
            ▼
   ko_*_backup  ───────────────► index=ko_history   (source = backup search name)
                                      │  _time = object's `updated` → append-only version log
   hourly cron                        │
            ▼                         │
   ko_*_delete_audit ──────────► index=ko_history   (source = audit search name)
   (reads _internal logs)             │  who / what / which KO
                                      ▼
                         KO History Wrapper (React) + KO Version dashboards
                          one row per title+app · visual compare · change
                          overlays on the live render · restore anywhere
```

Each backup's `where updated > now-900s` clause is what makes it incremental. **Do not widen this window** without widening the cron interval, or the same version is summary-indexed repeatedly.

## License

Apache License 2.0. The full text ships with the app as `LICENSE`.

## Versions

| Version | Notes |
|---------|-------|
| 1.3.0   | **The capture searches are enabled from inside the app.** A new **Settings → Searches** section lists all 17 shipped searches grouped by what they do, with a switch on each, so turning capture on no longer means finding them among every search on the instance. Backfills deliberately get a link to their report instead of a switch: they are one-shot, and re-running one duplicates every snapshot it already wrote. **Breaking: the seven `ko_*_catchup` searches and `ko_seen_kos_builder` are removed**, with the `ko_seen_kos` lookup, because they had never been executed and shipping untested scheduled machinery that fails closed and silently is worse than shipping without it. The gap they were meant to close (a knowledge object that arrives *already old* is invisible to the 15-minute capture window) is described in the deployment guide instead. If you enabled one on 1.2.1, its `local/` stanza survives the upgrade and does nothing; delete it at your leisure. **Also removed: `ko_usage_collector` and `ko_tracked_kos_lookup_builder`**, with the `ko_tracked_kos` lookup and `transforms.conf`. The statistics dashboard they fed was cut before release, which left them writing `source=ko_usage` events that every shipped search then excluded. Those exclusions stay in place, so an index still holding such events from an earlier version does not show them as knowledge objects. |
| 1.2.1   | **The index name is now configurable.** It lives in a single `ko_history_index` search macro that every search resolves, editable from the new **Settings → Index** section or from Splunk's macro editor, so the app can be pointed at an index you already have or one your naming policy requires. Note the macro governs where the app **reads**: capture targets `action.summary_index._name`, which cannot reference a macro, so repointing the capture searches stays a manual step and is documented. Also: `build.sh` now fails when webpack does not report success, because `npm run build` exits 0 when webpack is missing and the build would otherwise package a stale bundle and call it a success. |
| 1.2.0   | **Restore is now opt-in and ships disabled.** A new admin **Settings** page in the app nav enables it per object type and writes `ko_history.conf`; the five untested types appear as greyed-out placeholders that conf cannot switch on. **Action required after upgrading: restore stays off until an admin enables it.** Also: Dashboards and Reports entries in the app nav, the Simple XML dashboard is labelled `KO Version (SXML)` so it is distinguishable from the Studio one, and the help page Overview tab is more compact. |
| 1.1.2   | Dashboard Studio schema fixes: every help panel carried a `name` property, which is a dataSource field and not a visualization one, so Studio rejected all of them. Both dashboards moved to the `tabs` + `layoutDefinitions` layout form, the only one the current schema accepts. The help page is now four tabs (Overview, Operating, Troubleshooting, Architecture) instead of one very long scroll. Adds `app.manifest`. |
| 1.1.1   | Source viewer: copy either side of a diff, not just the newer one, and long lines now wrap instead of being clipped (the wrapper's inline source view had no wrap mode at all). Restore scope stated explicitly: all seven object types are captured, previewed and compared, while one-click restore covers dashboards and saved searches. |
| 1.1.0   | Polish and packaging release. Searches now run as async jobs instead of a blocking oneshot, fixing a preview panel that could hang indefinitely on a slow instance; a progress bar and a 30-second timeout replace the silent spinner. Restore, compare, and approval dialogs share one visual language. View mode writes a single preview slot. Every shipped search carries inline SPL comments. Apache-2.0 `LICENSE` now ships with the app. **Removed:** the REST Explorer and KO Statistics dashboards, which were development tools rather than product surfaces. |
| 1.0.3   | 12 MB slimmer tarball (unused static assets removed). **Viz renames/removals. Action required if you reference these ids from other dashboards:** `json_viewer` was **renamed** to `source_viewer` (`ko_history.json_viewer` → `ko_history.source_viewer`); `dashboard_preview_ds` was **removed** (dashboards using `ko_history.dashboard_preview_ds` will lose that panel). Also: expand/view UX improvements, Newer/Older navigation in the compare panel, KPI filter controls. |
| 1.0.2   | Deep-audit cleanup: live-render teardown leak fix, unified empty-data policy across all four vizs, audit rows now show *who* deleted/moved (`By` column + history), `realtime_schedule` restored faithfully, index schema trimmed (`userName` and SPL no-ops dropped), DS page-load scans 4→2, icons shipped from `static/` only. |
| 1.0.1   | Hardening release: all capture searches ship disabled, scheduler no-skip (`realtime_schedule=0`, `schedule_window=auto`), source-view render caps, viz render-key fixes. |
| 1.0.0   | Initial public release. Seven KO types (views, reports/alerts, macros, event types, field extractions, lookups, tags); combined `ko_all_delete_audit`; one-time backfill searches; per-user preview slots; AppInspect-clean tarball. |
| 0.1.x   | Pre-release iterations: single-app merge, React wrapper, visual compare + restore, four bundled vizs, DS dashboard, usage statistics. |
