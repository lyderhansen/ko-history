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
  (indexer cluster). There, create `ko_history` through your cluster's index management.

## 2. Install the app

Install the packaged tarball:

```
$SPLUNK_HOME/bin/splunk install app ko_history-<version>.tar.gz
```

Then **restart Splunk**. Treat this as part of the install, not a suggestion, and note
that Splunk may not prompt you for it. The bundled React app pages and the custom
visualizations are Mako templates and static bundles, which Splunk resolves when the
appserver starts, so before a restart the main page raises a template lookup error and
the visualizations do not render. The same applies after an upgrade, where a stale
bundle is worse than a missing one.

**If you skip it, here is what you will see:** opening **KO History** or **Settings**
returns a 5xx error, usually a 500, sometimes with a stack trace ending in
`TopLevelLookupException: failed to locate the template for uri`. That error means one
thing only, a missing restart. Every other page in the app keeps working, so a healthy
nav next to a broken main page is the expected shape of the problem rather than a sign
of a bad package.

The app opens on **Home**, a plain Dashboard Studio page that works without the restart
and reports what state the install is in, including when Splunk last started, so a
missed restart shows up as a readable message rather than a stack trace.

## 3. Enable the scheduled searches

The capture saved searches ship **disabled**. Enable the per-type backup and the combined
delete-audit searches. The **Reports** entry in the app nav lists them already scoped
to KO History; **Settings → Searches, reports, and alerts** works too.
Optionally run each one-time `*_backfill` search **once** to seed a snapshot of existing KOs
(they are disabled by default and must not be scheduled: re-running duplicates snapshots).

**Sizing note:** each backup search enumerates the full object list for its type via local
REST every 15 minutes. On large search heads with thousands of KOs per type, each run
returns thousands of rows. It is cheap (local REST, no index scan), but budget for it in
your scheduler load and summary index ingest rate.

**Catch-up (recommended):** the backup searches only capture a KO edited in the last
15 minutes, so a KO that arrives *already old* is invisible to them forever. That happens
whenever an app is installed after onboarding, and whenever an edit lands while the
scheduler is stopped. Enable **`ko_seen_kos_builder`** and the seven **`ko_*_catchup`**
searches to close that gap automatically: the builder rebuilds a lookup of everything ever
captured, and each catch-up captures whatever is missing from it, once.

Enable the builder first. The catch-ups refuse to run against an empty lookup, because an
empty lookup means "nothing has ever been captured" and they would otherwise re-capture the
whole instance and duplicate the backfill. Enabling the builder first is the only ordering
requirement; it runs at 01:05 and the catch-ups from 02:20.

They also refuse to run against a **stale** lookup, meaning one not rebuilt in the last 26
hours. A lookup that is merely out of date still passes a non-empty test, while everything
captured since the last successful rebuild is missing from it and therefore looks as though
it has never been seen, so it gets captured again, nightly, for as long as the builder stays
broken. Both checks fail closed on purpose: a skipped catch-up corrects itself on the next
run, whereas a duplicate version is permanent and indistinguishable from a real edit.

The practical consequence is that **if `ko_seen_kos_builder` stops running, the catch-ups stop
too, silently and by design.** If catch-up captures dry up, check that search first. Watch it
with:

```
| inputlookup ko_seen_kos | stats count as tracked_kos max(built) as built
| eval age_hours=round((now()-built)/3600,1), rebuilt=strftime(built,"%F %T")
| table tracked_kos rebuilt age_hours
```

`age_hours` above 26 means the catch-ups are currently blocked. A lookup written by a version
before 1.2.0 has no `built` column at all, which reads as stale and blocks them until the
builder runs once, which is the safe direction to fail.

**Optional, usage statistics:** `ko_tracked_kos_lookup_builder` and
`ko_usage_collector` are both disabled by default and work as a pair, so enable both together
(or neither). They capture daily per-KO access and run counts and feed the statistics
dashboard; enabling only one is harmless but produces no useful data.

## 4. Enable restore (optional)

**Restore ships turned off for every object type.** It is the only operation in KO History
that writes back into your environment, so it is opt-in. Everything else, capture, version
history, preview, compare and the source viewer, works with restore disabled.

To turn it on, open **Settings** in the app nav. Tick the object types you want restorable
and save. The page writes `local/ko_history.conf` for you, which is the only route on
Splunk Cloud. Writing it needs the `admin` or `sc_admin` role; everyone else sees the page
read-only, which is also how a non-admin finds out why Restore is greyed out.

> **Upgrading from 1.1.x:** restore was previously always on for dashboards and saved
> searches. After upgrading to 1.2.0 it is off until an admin enables it. Nothing else
> changes, and no captured history is affected.

**Search head clusters:** the app declares SHC support in `app.manifest`:

```
"supportedDeployments": ["_standalone", "_distributed", "_search_head_clustering"],
"targetWorkloads": ["_search_heads"]
```

Both fields are required. Splunk Cloud validates them at install time and rejects the app
with *"App validation failed: App does not support search head cluster deployments"* when
`supportedDeployments` is absent, not only when it is present and excludes SHC. AppInspect
does not check this, so a package can pass Cloud vetting cleanly and still be refused by the
installer.

Beyond that declaration, nothing to do. Custom app configs are not replicated between
members by default, which would leave restore enabled on one search head and disabled on
the next, so the app ships `default/server.conf` with:

```
[shclustering]
conf_replication_include.ko_history = true
```

That is the only `[shclustering]` setting present. It does not configure clustering; it
adds one conf file to the list an existing cluster keeps in step, and it is inert on a
standalone search head. Splunk Cloud stacks are clustered, so this is what keeps the
settings page consistent there.

Restore is available for **dashboards, reports, and alerts** (reports and alerts are both
stored as saved searches). The other captured KO types (macros, event types, field
extractions, lookups, tags) are versioned and viewable now, and appear on the settings page
as greyed-out placeholders: their restore is written but has not finished testing, so the
app ignores those conf keys even if you set them by hand.

## Renaming the index (advanced)

The index name `ko_history` is referenced in several layers (saved-search SPL and summary
targets, dashboard searches, and the app page bundle). Renaming it is not a single-setting
change. See the in-app **KO History: how the pieces fit together** help page for
the full list of change points.
