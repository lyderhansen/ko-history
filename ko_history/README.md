# KO History

> Lightweight knowledge-object versioning for Splunk. Every dashboard, report, alert, macro, event type, and field extraction is snapshotted into a summary index on a cron, every DELETE and MOVE is captured from the audit log, and the bundled dashboards + React app page surface the full history with inline visual previews, side-by-side diffs, change overlays, and one-click restore of any past version.

## Why

A dashboard disappears, a critical alert gets overwritten, a report is lost — and Splunk keeps no user-facing version history. KO History gives you:

- **A version log per KO** — every change captured with timestamp, author, and full source.
- **An audit trail** — DELETE and MOVE actions linked to the user who performed them.
- **Visual recovery** — preview *any* past version inline, diff two versions (boxes drawn over changed panels on the live render), then restore the source into any app in one click.
- **Survives deletion** — history lives in a separate summary index, so it outlives the object.

## What's in the box

| Path | Purpose |
|------|---------|
| `default/savedsearches.conf` | Ten scheduled searches that feed `index=ko_history`. |
| `default/data/ui/views/` | The dashboards: `wrapper.xml` (React page host), `ko_version.xml`, `ko_version_ds.xml`, `ko_rest_explorer.xml`, `ko_help.xml`. |
| `appserver/static/visualizations/` | Four bundled custom vizs (see below). |
| `appserver/static/pages/wrapper.js` + `appserver/templates/wrapper.html` | The React app page (`@splunk/react-page`). |
| `default/data/ui/nav/default.xml` | App navigation. |
| `default/visualizations.conf` | Registers the four custom vizs. |
| `metadata/default.meta` | ACL (read: \*, write: admin/sc\_admin; vizs exported system-wide). |

### The ten saved searches

A **backup** + **delete-audit** pair per KO type. Backups run on a staggered 15-minute cron and write one event per object changed in the last 15 min (`_time` = the object's `updated` timestamp). Audits run hourly and capture DELETE/MOVE from `_internal`. The saved-search name is the `source` field — that's how the UI discriminates streams.

| KO type | Backup (cron) | Delete-audit (cron) |
|---|---|---|
| Dashboards | `ko_views_xml_backup` (`3,18,33,48`) | `ko_views_delete_audit` (`4`) |
| Reports & alerts | `ko_reports_and_alerts_backup` (`6,21,36,51`) | `ko_reports_and_alerts_delete_audit` (`7`) |
| Macros | `ko_macros_backup` (`9,24,39,54`) | `ko_macros_delete_audit` (`10`) |
| Event types | `ko_eventtypes_backup` (`11,26,41,56`) | `ko_eventtypes_delete_audit` (`14`) |
| Field extractions | `ko_fieldextractions_backup` (`13,28,43,58`) | `ko_fieldextractions_delete_audit` (`17`) |

All write to `index=ko_history`.

### The four bundled visualizations

| Viz | Role |
|---|---|
| `dashboard_preview` | Renders a saved dashboard (Studio or Simple XML) inline and overlays a visual diff between two versions. Use inside **classic Simple XML** hosts. |
| `dashboard_preview_ds` | Sandbox-proof **schematic** preview + diff that works inside **Dashboard Studio** (and Simple XML) — panel layout coloured by the diff. |
| `json_viewer` | KO source (Studio JSON or Simple XML) as a syntax-highlighted, foldable, line-numbered listing with copy-to-clipboard. Sandbox-safe. |
| `ko_viewer` | A Splunk-native **record card** for one KO version — bespoke profile for reports/alerts (definition, schedule, trigger actions, alert condition), generic profile for macros / event types / field extractions / etc. |

## Install

### Prerequisites

The **`ko_history` index** must exist — this app does **not** ship `indexes.conf`. Create it first:
- **Enterprise**: `[ko_history]` in `indexes.conf` on the indexer tier, or Settings → Indexes → New Index.
- **Cloud**: Cloud Admin Console → Settings → Indexes → New Index, name `ko_history`.

### Steps

1. Install the tarball (Manage Apps → Install app from file) or drop `ko_history/` into `$SPLUNK_HOME/etc/apps/`.
2. **`splunk restart`** — a full restart is required (the React page is served from a Mako template + static bundle that a reload won't refresh).
3. Confirm the ten saved searches are scheduled under Settings → Searches, reports, and alerts.
4. Wait one cron cycle (~15 min), then open **Apps → KO History**.

## Configuration

### Permissions

`metadata/default.meta` grants read to all roles, write to `admin` / `sc_admin`. The custom vizs are exported `system`-wide so they appear in the viz picker of dashboards in any app; preview slots are always written into the `ko_history` app only. **Restore** and the live-preview write path require write on `data/ui/views` in `ko_history` — loosen `[views]` if other roles must drill in.

### Excluding noisy hosts from the delete audit

If a search head queries itself via REST and that shows up as DELETE noise, edit the relevant `*_delete_audit` search and append `NOT host=<your-sh>` to each union leg.

### Usage statistics enrichment (optional)

The original dashboard joined `index=ko_history` with a `Splunk Housekeeping - KO - Dashboards Usage - Statistics Collector` summary for `access_count`/`users`. That collector is **not bundled** — source or stub it and union it into the base search if you want it.

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

Each backup's `where updated > now-900s` clause is what makes it incremental — **do not widen this window** without widening the cron interval, or the same version is summary-indexed repeatedly.

## Versions

| Version | Notes |
|---------|-------|
| 0.1.59  | Visual compare **Blend** sub-mode (Photoshop-style difference / onion-skin overlay of the two renders); `ko_viewer` gains a **diff panel** (field-level changes + line diff of the primary code field) so every non-dashboard KO gets a version diff; baseline/target relabelled **PREVIOUS / LATEST** everywhere. |
| 0.1.58  | Five KO types (views, reports/alerts, macros, event types, field extractions); React wrapper with visual compare + change overlays + restore; four bundled vizs (dashboard_preview, dashboard_preview_ds, json_viewer, ko_viewer). |
| 0.0.1   | Initial scaffold. Four saved searches, dashboard with rendered-preview drilldown, generic ACL. |
