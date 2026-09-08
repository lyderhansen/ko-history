# KO History

**Automatic versioning and recovery for Splunk knowledge objects.**

Every Splunk admin has been there: a dashboard disappears, a critical alert gets
overwritten, or a report is lost, with no way back. KO History is a lightweight
Splunk app that automatically captures and versions your user-generated knowledge
objects so you can **audit every change** and **recover content** after accidental
deletes, overwrites, or moves.

## How it works

No external database, no extra infrastructure. KO History uses two ideas you already
have in Splunk:

1. **Backup saved searches** run on a schedule, snapshot each recently-changed
   knowledge object via the REST API, and write one event per version into a
   **summary index** (`ko_history` by default, and the name is configurable).
   The summary index becomes an append-only *version log*.
2. **Audit saved searches** scrape the `_internal` access logs for DELETE and MOVE
   actions, recording *who* changed *what* and *when*.

A dashboard and an in-app page then join those streams so every knowledge object
shows its full mutation history, with a visual diff between versions and one-click
restore.

## What it captures

All seven knowledge-object types are **captured, audited, and viewable**:

- Dashboards (Classic Simple XML **and** Dashboard Studio)
- Reports and Alerts (saved searches)
- Macros · Event types · Field extractions · Lookups · Tags

## Restore

One-click restore recovers a captured version back into Splunk as a real object,
into the original app or any app you choose.

It is the only operation that writes back into your environment, so it **ships
turned off**. An admin enables it per object type on the app's Settings page.
Capture, version history, preview and compare all work with restore disabled.

- **Restore covers dashboards, reports and alerts** (reports and alerts are both
  saved searches).
- Restore for the other captured types (macros, event types, field extractions,
  lookups and tags) is implemented but disabled pending further testing. They are
  captured, previewed and compared today, so no history is lost while it is off.

## Install & deploy

Deployment is three steps: **create the index → install the app → enable the
searches**. The app's own **Settings** page lists every shipped search grouped by
what it does, with a switch on each, so the last step does not mean hunting through
every saved search on the instance. See
[`ko_history/README/DEPLOY.md`](ko_history/README/DEPLOY.md) for the full guide
(including Splunk Cloud index creation via ACS).

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

KO History passes **Splunk Cloud AppInspect** vetting: 252 checks, 0 errors and
0 failures on the full profile. The three remaining warnings are non-blocking, and
two of them match Splunk's own bundled JavaScript rather than this app's code. On Splunk
Cloud, create the `ko_history` index via ACS / the Cloud console before installing,
and give it a long retention period: snapshots are stamped at each object's own
edit time, so an object last touched years ago is written with that old timestamp.

Already have KO History data under a different index name, or need one to match a
naming policy? The name every search reads lives in a single search macro,
`ko_history_index`, editable from the app's Settings page or the macro editor.
Note that the macro governs **reads**; capture writes via each search's
`action.summary_index._name`, which cannot reference a macro, so both halves have
to be pointed at the same index. `ko_history/README/DEPLOY.md` walks through it.

## Status

Version **1.3.0**.

## License

[Apache License 2.0](LICENSE).
