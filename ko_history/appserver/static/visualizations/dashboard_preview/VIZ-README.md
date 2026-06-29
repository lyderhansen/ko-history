# Dashboard Preview + Diff — Splunk Custom Visualization

Renders a saved Splunk dashboard (Dashboard Studio or Classic Simple XML) inline inside another dashboard panel, and **overlays a visual diff between two versions** of that dashboard's source.

Designed for **version-history dashboards**: snapshot a dashboard's `eai:data` into a summary index over time, then pick two snapshots — a **baseline** (old) and a **target** (new) — and the viz renders the target while highlighting exactly what changed.

## What you get

Four independently toggleable diff views:

| View | What it does | Works on | Default |
|------|--------------|----------|---------|
| **Highlight boxes** | Colored boxes drawn *inside* the rendered dashboard over added / changed / moved panels. Green=added, amber=changed, blue=moved. | Studio + SXML | On |
| **Change list** | Side-drawer summary: panels added/removed/changed/moved, searches modified, titles changed, layout moves. | Studio + SXML | On |
| **Source diff** | Side-drawer line-by-line diff of the two source definitions (Studio JSON is pretty-printed first). | Studio + SXML | Off |
| **Blend overlay** | *Experimental.* Onion-skin — renders both versions and composites them with `mix-blend-mode: difference`. Noisy for live data. | Studio + SXML | Off |

## How It Works

Splunk has no "render this XML string" endpoint, so the viz writes the **target** source into a preview-slot view inside *this* app and iframes it. Because the iframe is **same-origin**, the viz reaches into `iframe.contentDocument` after render and attaches highlight boxes directly onto the real panel DOM nodes — so highlighting is layout-agnostic and works for both Studio and Classic SXML without any coordinate math.

The **baseline** is normally only parsed in memory to compute the diff — it is **not** written or rendered. (The single exception is Blend mode, which writes a second slot for the onion-skin.)

Diff computation:
- **Studio**: the `<definition>` JSON is extracted and panels are matched by **viz id** — robust against reordering. Detects added/removed panels, changed options/title/type, changed searches, and moved/resized panels (from `layout.structure` positions).
- **Classic SXML**: panels are parsed with `DOMParser` and matched by **document order (index)**. Detects added/removed panels, title changes, viz-type changes, and search changes. *(Index matching means an inserted panel near the top shifts the alignment — fine for a POC, noted as a limitation.)*

## Security model

- **Single trusted app.** Preview slots are *always* written into the `dashboard_preview` app — never `search`, never the parent dashboard's app, never anywhere user-configurable. Enforced in code.
- **Approval before every new write.** When the rendered content changes, an in-panel card shows the target title/type/size and the slot(s) it will write, and blocks until you click **Render & diff**. Same content does not re-prompt within the page lifetime.
- **Baseline is read-only** unless Blend mode is on.
- The in-browser approval gate is a UX guard; the *real* control is Splunk RBAC on `data/ui/views` in this app (see Permissions).

## Install

1. Manage Apps → Install app from file → upload the tarball → restart Splunk.
2. The "Dashboard Preview" viz appears in the viz picker for both Classic and Studio dashboards.

## Data contract

The driving search must return (at least) two rows — one baseline, one target — each with the source in the **Source Field**, tagged by the **Role Field**:

| Column | Role | Description |
|--------|------|-------------|
| `data` | required | The `eai:data` XML envelope of the dashboard version. |
| `role` | required* | `baseline` or `target`. *If absent, first row = baseline, last row = target.* |
| `app`  | optional | Origin app (shown in approval prompt). |
| `title`| optional | Informational. |

## POC: two dropdowns to choose versions

Put two dropdown inputs on the host dashboard, each populated from your snapshot index, writing tokens `$baseline_id$` and `$target_id$`. The viz's search then returns exactly those two snapshots, tagged by role:

```spl
index=dashboard_snapshots dashboard_name="my_dashboard"
   (snapshot_id="$baseline_id$" OR snapshot_id="$target_id$")
| eval role=if(snapshot_id="$baseline_id$", "baseline", "target")
| eval data=source_xml          ``` whatever field holds the eai:data snapshot ```
| table role snapshot_id _time app title data
```

Dropdown population search (both dropdowns use the same, with `snapshot_id` / `_time` as value/label):

```spl
index=dashboard_snapshots dashboard_name="my_dashboard"
| stats latest(_time) as t by snapshot_id
| eval label=strftime(t, "%F %T")
| sort - t
| table snapshot_id label
```

### Snapshotting the source (scheduled, run e.g. daily)

```spl
| rest /servicesNS/-/-/data/ui/views splunk_server=local
| search isDashboard=1 title="my_dashboard"
| rename eai:data as source_xml, eai:acl.app as app
| eval snapshot_id=strftime(now(), "%Y%m%d%H%M%S"), dashboard_name=title
| table _time dashboard_name snapshot_id app title source_xml
| collect index=dashboard_snapshots
```

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| **Source Field** | Column with the raw dashboard source XML. | `data` |
| **Role Field** | Column tagging each row baseline/target. | `role` |
| **Baseline Value** / **Target Value** | The role-field values that mark old / new. | `baseline` / `target` |
| **App Field** / **App Fallback** | Origin app (prompt display only). | `app` / `search` |
| **Highlight Boxes** | In-iframe highlight overlay. | On |
| **Change List** | Structural change drawer. | On |
| **Source Diff** | Line-by-line source diff drawer. | Off |
| **Blend Overlay** | Experimental onion-skin (writes a 2nd slot). | Off |
| **Highlight Selector** | Advanced: CSS selector override for panel elements inside the iframe, if auto-detect misses. | (blank) |
| **Target Slot Name** | View written for the target render. Unique per viz instance. | `dashboard_preview_slot` |
| **Baseline Slot Name** | View written for the baseline render (Blend only). | `dashboard_preview_slot_baseline` |
| **URL Parameters** | Query string on the iframe URL (chrome hidden). | see formatter |
| **Scale** | CSS scale factor for the embedded dashboard. | `1.0` |
| **Background** | Background around the iframe and approval overlay. | `transparent` |

## Highlight selector tuning

The in-iframe highlighter tries a ladder of selectors (`[data-viz-id]`, `[data-element-id]`, `.dashboard-element`, `.dashboard-panel`, …). If your Splunk build renders panels under a different attribute and boxes don't appear:

1. Open the rendered preview slot directly: `/en-US/app/dashboard_preview/dashboard_preview_slot`.
2. Inspect a panel element, find a stable selector (an attribute or class common to all panels).
3. Put it in **Highlight Selector**.

The **Change list** and **Source diff** never depend on the iframe DOM, so they always work even if highlighting can't locate panels.

## Permissions

The viewing user needs **write access to `data/ui/views`** in the `dashboard_preview` app. Ships restrictive (`write: [admin, sc_admin]`). Loosen in `metadata/default.meta` to grant a specific role if non-admins must render previews.

## Notes & limitations

- **Identical versions** → "No changes" / "structurally identical" — nothing is highlighted.
- **Removed panels** appear in the change list (red) but cannot be highlighted on the target — they're not there.
- **SXML index matching** can misalign when panels are inserted/removed mid-list; the change list stays readable but highlight mapping may shift.
- **Blend mode** composites two *live* renders — async data, timestamps and animations make it perceptually noisy. Use it for gross layout/structure comparison, not pixel-precise diffing.
- Highlight injection polls for up to ~8s for panels to finish rendering, then stops. Heavy dashboards may need the scale lowered for everything to fit.

## Build

From the repo root:

```bash
./build.sh dashboard_preview
```

Output tarball: `dist/dashboard_preview-1.2.0.tar.gz`.
