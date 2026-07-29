# KO History

> Lightweight knowledge-object versioning for Splunk. Every dashboard, report, alert, macro, event type, and field extraction is snapshotted into a summary index on a cron, every DELETE and MOVE is captured from the audit log, and the bundled dashboards + React app page surface the full history with inline visual previews, side-by-side diffs, change overlays, and one-click restore of any past version.

## Why

A dashboard disappears, a critical alert gets overwritten, a report is lost, and Splunk keeps no user-facing version history. KO History gives you:

- **A version log per KO**: every change captured with timestamp, author, and full source.
- **An audit trail**: DELETE and MOVE actions linked to the user who performed them.
- **Restore scope**: all seven object types are captured, previewed and compared. **One-click restore currently covers dashboards and saved searches**; restore for macros, event types, field extractions, lookups and tags is implemented but disabled pending further testing.
- **Visual recovery**: preview *any* past version inline, diff two versions (boxes drawn over changed panels on the live render), then restore the source into any app in one click.
- **Survives deletion**: history lives in a separate summary index, so it outlives the object.

## What's in the box

| Path | Purpose |
|------|---------|
| `default/savedsearches.conf` | 17 stanzas: 7 type backups, 1 combined delete-audit, 1 lookup builder, 1 usage collector, 7 one-time backfills, all feeding `index=ko_history`. All ship disabled. |
| `default/data/ui/views/` | The dashboards: `wrapper.xml` (React page host), `ko_version.xml`, `ko_version_ds.xml`, `ko_help.xml`. |
| `appserver/static/visualizations/` | Three bundled custom vizs (see below). |
| `appserver/static/pages/wrapper.js` + `appserver/templates/wrapper.html` | The React app page (`@splunk/react-page`). |
| `default/data/ui/nav/default.xml` | App navigation. |
| `default/visualizations.conf` | Registers the three custom vizs. |
| `metadata/default.meta` | ACL (read: \*, write: admin/sc\_admin; vizs exported system-wide). |

### The scheduled searches (17 stanzas)

**ALL capture searches ship `disabled = 1`. Enable them after creating the index.**

Seven **backup** searches run on a staggered 15-minute cron (`realtime_schedule = 0`, `schedule_window = auto`) and write one event per object changed in the last 15 min (`_time` = the object's `updated` timestamp). One **combined delete-audit** runs hourly and captures DELETE/MOVE from `_internal` for all KO types. A **lookup builder** and **usage collector** are optional; see *Usage statistics* below. Seven **one-time backfill** searches are included for initial onboarding. Run each manually once, then leave disabled.

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

**Optional usage stats (daily). Enable both together, or neither.** They populate the access and run counts shown in the KO tables.

| Search name | Cron | Purpose |
|---|---|---|
| `ko_tracked_kos_lookup_builder` | `0 1 * * *` | Builds membership lookup used by the collector |
| `ko_usage_collector` | `30 1 * * *` | Captures per-KO access/run counts |

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
3. Enable the capture searches under **Settings → Searches, reports, and alerts** (app: KO History). All ship disabled. Enable `ko_views_xml_backup` through `ko_tags_backup` and `ko_all_delete_audit` after the `ko_history` index exists. See *Scheduled searches* above for the full list.
4. Wait one cron cycle (~15 min), then open **Apps → KO History**.

## Configuration

### Permissions

`metadata/default.meta` grants read to all roles, write to `admin` / `sc_admin`. The custom vizs are exported `system`-wide so they appear in the viz picker of dashboards in any app; preview slots are always written into the `ko_history` app only. **Restore** and the live-preview write path require write on `data/ui/views` in `ko_history` for the acting user. **Do not broaden the `[views]` write stanza to additional roles.** Because all three vizs export as `system`, any role granted `[views]` write in this app gains a view create/overwrite primitive reachable from any dashboard fleet-wide, gated only by the client-side approval prompt, which is convenience, not security. If non-admin roles must use the preview or restore features, implement a constrained server-side endpoint (a custom REST handler that enforces per-user/per-slot limits) rather than expanding raw view-write permissions.

### Excluding noisy hosts from the delete audit

If a search head queries itself via REST and that shows up as DELETE noise, edit the relevant `*_delete_audit` search and append `NOT host=<your-sh>` to each union leg.

### Usage statistics enrichment (optional)

The original dashboard joined `index=ko_history` with a `Splunk Housekeeping - KO - Dashboards Usage - Statistics Collector` summary for `access_count`/`users`. That collector is **not bundled**. Source or stub it and union it into the base search if you want it.

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
| 1.1.2   | Dashboard Studio schema fixes: every help panel carried a `name` property, which is a dataSource field and not a visualization one, so Studio rejected all of them. Both dashboards moved to the `tabs` + `layoutDefinitions` layout form, the only one the current schema accepts. The help page is now four tabs (Overview, Operating, Troubleshooting, Architecture) instead of one very long scroll. Adds `app.manifest`. |
| 1.1.1   | Source viewer: copy either side of a diff, not just the newer one, and long lines now wrap instead of being clipped (the wrapper's inline source view had no wrap mode at all). Restore scope stated explicitly: all seven object types are captured, previewed and compared, while one-click restore covers dashboards and saved searches. |
| 1.1.0   | Polish and packaging release. Searches now run as async jobs instead of a blocking oneshot, fixing a preview panel that could hang indefinitely on a slow instance; a progress bar and a 30-second timeout replace the silent spinner. Restore, compare, and approval dialogs share one visual language. View mode writes a single preview slot. Every shipped search carries inline SPL comments. Apache-2.0 `LICENSE` now ships with the app. **Removed:** the REST Explorer and KO Statistics dashboards, which were development tools rather than product surfaces. |
| 1.0.3   | 12 MB slimmer tarball (unused static assets removed). **Viz renames/removals. Action required if you reference these ids from other dashboards:** `json_viewer` was **renamed** to `source_viewer` (`ko_history.json_viewer` → `ko_history.source_viewer`); `dashboard_preview_ds` was **removed** (dashboards using `ko_history.dashboard_preview_ds` will lose that panel). Also: expand/view UX improvements, Newer/Older navigation in the compare panel, KPI filter controls. |
| 1.0.2   | Deep-audit cleanup: live-render teardown leak fix, unified empty-data policy across all four vizs, audit rows now show *who* deleted/moved (`By` column + history), `realtime_schedule` restored faithfully, index schema trimmed (`userName` and SPL no-ops dropped), DS page-load scans 4→2, icons shipped from `static/` only. |
| 1.0.1   | Hardening release: all capture searches ship disabled, scheduler no-skip (`realtime_schedule=0`, `schedule_window=auto`), source-view render caps, viz render-key fixes. |
| 1.0.0   | Initial public release. Seven KO types (views, reports/alerts, macros, event types, field extractions, lookups, tags); combined `ko_all_delete_audit`; one-time backfill searches; per-user preview slots; AppInspect-clean tarball. |
| 0.1.x   | Pre-release iterations: single-app merge, React wrapper, visual compare + restore, four bundled vizs, DS dashboard, usage statistics. |
