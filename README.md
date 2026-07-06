# KO History

**Automatic versioning and recovery for Splunk knowledge objects.**

Every Splunk admin has been there: a dashboard disappears, a critical alert gets
overwritten, or a report is lost — with no way back. KO History is a lightweight
Splunk app that automatically captures and versions your user-generated knowledge
objects so you can **audit every change** and **recover content** after accidental
deletes, overwrites, or moves.

## How it works

No external database, no extra infrastructure. KO History uses two ideas you already
have in Splunk:

1. **Backup saved searches** run on a schedule, snapshot each recently-changed
   knowledge object via the REST API, and write one event per version into a
   **summary index** (`ko_history`). The summary index becomes an append-only
   *version log*.
2. **Audit saved searches** scrape the `_internal` access logs for DELETE and MOVE
   actions, recording *who* changed *what* and *when*.

A dashboard and an in-app page then join those streams so every knowledge object
shows its full mutation history — with a visual diff between versions and one-click
restore.

## What it captures

All seven knowledge-object types are **captured, audited, and viewable**:

- Dashboards (Classic Simple XML **and** Dashboard Studio)
- Reports and Alerts (saved searches)
- Macros · Event types · Field extractions · Lookups · Tags

## Restore

One-click restore recovers a captured version back into Splunk as a real object —
into the original app or any app you choose.

- **v1.0 restores: dashboards, reports, and alerts** (reports and alerts are both
  saved searches).
- Restore for the other captured types (macros, event types, field extractions,
  lookups, tags) is on the roadmap — they are versioned and viewable today.

## Install & deploy

Deployment is three steps — **create the index → install the app → enable the
searches**. See [`ko_history/README/DEPLOY.md`](ko_history/README/DEPLOY.md) for the
full guide (including Splunk Cloud index creation via ACS).

A ready-to-install package is produced under `dist/` (see *Build* below), or grab the
release tarball.

## Build from source

```bash
./build.sh
# -> dist/ko_history-<version>.tar.gz
```

The build compiles the bundled custom visualizations and the React app page, then
packages the installable app. Node.js is required (the build installs npm
dependencies on first run). On some environments, run as `NODE_OPTIONS= ./build.sh`.

## Splunk Cloud

KO History is built to pass **Splunk Cloud AppInspect** (0 failures). On Splunk
Cloud, create the `ko_history` index via ACS / the Cloud console before installing.

## Status

Version **1.0.1**.

## License

[Apache License 2.0](LICENSE).
