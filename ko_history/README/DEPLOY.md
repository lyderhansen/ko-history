# Deploying KO History

KO History captures versions of your knowledge objects into a summary index named
**`ko_history`**, then a dashboard + app page let you audit and recover them.

Deployment is three steps: **create the index → install the app → enable the searches.**

## 1. Create the `ko_history` index

The index name is fixed at `ko_history` in this release. Create it before installing.

- **Splunk Cloud:** create an Events index named `ko_history` via **Settings → Indexes**
  (or ACS / the Cloud console). Retention: choose a long frozen period to keep version
  history (the app assumes audit-grade retention).
- **Splunk Enterprise (on-prem):** the bundled `default/indexes.conf` creates `ko_history`
  with a 20-year frozen period. No action needed unless you manage indexes centrally
  (indexer cluster) — there, create `ko_history` through your cluster's index management.

## 2. Install the app

Install the packaged tarball:

```
$SPLUNK_HOME/bin/splunk install app ko_history-<version>.tar.gz
```

Then restart Splunk (required for the bundled React app page and custom visualizations).

## 3. Enable the scheduled searches

The capture saved searches ship **disabled**. Enable the per-type backup and the combined
delete-audit searches under **Settings → Searches, reports, and alerts** (app: KO History).
Optionally run each one-time `*_backfill` search **once** to seed a snapshot of existing KOs
(they are disabled by default and must not be scheduled — re-running duplicates snapshots).

## What v1.0 restores

Restore is available for **dashboards, reports, and alerts** (reports and alerts are both
stored as saved searches). The other captured KO types (macros, event types, field
extractions, lookups, tags) are versioned and viewable now; one-click restore for them
is on the roadmap.

## Renaming the index (advanced)

The index name `ko_history` is referenced in several layers (saved-search SPL and summary
targets, dashboard searches, and the app page bundle). Renaming it is not a single-setting
change in v1.0 — see the in-app **KO History — how the pieces fit together** help page for
the full list of change points.
