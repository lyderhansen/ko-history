# Deploying KO History

KO History captures versions of your knowledge objects into a summary index named
**`ko_history`**, then a dashboard + app page let you audit and recover them.

Deployment is three steps: **create the index → install the app → enable the searches.**

## 1. Create the `ko_history` index

The app defaults to an index named `ko_history`. Create it before installing. If you need
a different name, or you already have KO History data under one, see *Using a different
index name* at the end of this file: the name lives in a single search macro.

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
delete-audit searches. The app's own **Settings** page lists every shipped search grouped
by what it does, with a switch on each; Splunk's **Settings → Searches, reports, and
alerts** works too.
Optionally run each one-time `*_backfill` search **once** to seed a snapshot of existing KOs
(they are disabled by default and must not be scheduled: re-running duplicates snapshots).

**Sizing note:** each backup search enumerates the full object list for its type via local
REST every 15 minutes. On large search heads with thousands of KOs per type, each run
returns thousands of rows. It is cheap (local REST, no index scan), but budget for it in
your scheduler load and summary index ingest rate.

**A known gap: KOs that arrive already old.** The backup searches only capture a KO
edited in the last 15 minutes, so a KO that appears on the instance *already old* is
invisible to them. That happens whenever an app is installed after onboarding, and
whenever an edit lands while the scheduler is stopped. Running the `*_backfill` searches
covers everything present at that moment; anything arriving old afterwards is missed
until someone edits it.

Re-running a backfill closes the gap again, but it duplicates every snapshot it already
wrote, so it is a deliberate choice rather than routine maintenance. Closing this gap
automatically is planned for a later release.

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

## Using a different index name

The index name lives in one search macro, **`ko_history_index`**, which expands to
the bare name (`ko_history` by default). Every search in the app reads it as
``index=`ko_history_index` ``, so changing the macro repoints every dashboard and
lookup builder at once.

Two reasons to change it: you already have KO History data under another name, or
your naming policy requires one.

**The macro governs reads, not writes.** Where the app writes is
`action.summary_index._name` on each capture search, a saved-search setting that
cannot use a macro. Changing the macro alone leaves the dashboards looking at the
new index while capture keeps filling the old one, which presents as a working
install with an empty table.

So change it in one of these two ways:

- **Settings page (recommended).** It writes the macro and repoints the capture
  searches together.
- **By hand.** Edit the macro on *Settings > Advanced search > Search macros*,
  then edit `action.summary_index._name` on every `ko_*_backup`, `ko_*_backfill`,
  and `ko_all_delete_audit` search to match.

**Retention still matters.** Whatever index you point at needs a long frozen
period. The bundled `indexes.conf` sets 20 years on `ko_history` for a reason: the
app stamps each event at the knowledge object's own `updated` time, so a snapshot
of an object last edited years ago is written with that old timestamp. Splunk's
default (~6 years) will freeze, meaning delete, anything older. This applies to
every Splunk Cloud install too, because Cloud manages indexes through ACS and
ignores an app-shipped `indexes.conf` entirely: check the retention on the index
you created there.

### Changing it from the Settings page

**Settings** has an **Index** section that writes the `ko_history_index` macro for you,
which is the read side. It deliberately does **not** touch the capture searches, because
`action.summary_index._name` cannot reference a macro and repointing 16 searches silently
on someone's behalf is not a thing a settings page should do without being asked.

So the two halves are split by design:

| Half | What it is | Who changes it |
|---|---|---|
| Read | `ko_history_index` macro | Settings page, or the macro editor |
| Write | `action.summary_index._name` on each capture search | You |

After changing the index name, edit `action.summary_index._name` on every `ko_*_backup`,
`ko_*_backfill` and `ko_all_delete_audit` search to
match. Until you do, capture keeps writing to the old index while the dashboards read the
new one, which looks like an app that suddenly lost all its data.

To check the two halves agree:

```
| rest /servicesNS/-/ko_history/saved/searches splunk_server=local
| search title=ko_* action.summary_index._name=*
| stats values(action.summary_index._name) as writes_to by title
| append [| rest /servicesNS/-/ko_history/admin/macros splunk_server=local
          | search title=ko_history_index | eval title="(macro) reads from",
            writes_to=definition | fields title writes_to]
```

Every row should name the same index.
