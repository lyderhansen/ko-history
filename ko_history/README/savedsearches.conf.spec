# Custom-viz options for the dashboard_preview visualization, registered under
# the ko_history app. These keys appear on any saved search (or dashboard
# panel) that uses display.visualizations.custom.type = ko_history.dashboard_preview.
display.visualizations.custom.ko_history.dashboard_preview.dataField = <string>
display.visualizations.custom.ko_history.dashboard_preview.roleField = <string>
display.visualizations.custom.ko_history.dashboard_preview.baselineValue = <string>
display.visualizations.custom.ko_history.dashboard_preview.targetValue = <string>
display.visualizations.custom.ko_history.dashboard_preview.appField = <string>
display.visualizations.custom.ko_history.dashboard_preview.appDefault = <string>
display.visualizations.custom.ko_history.dashboard_preview.showHighlights = <boolean>
display.visualizations.custom.ko_history.dashboard_preview.showChangeList = <boolean>
display.visualizations.custom.ko_history.dashboard_preview.showSourceDiff = <boolean>
display.visualizations.custom.ko_history.dashboard_preview.showBlend = <boolean>
display.visualizations.custom.ko_history.dashboard_preview.highlightSelector = <string>
# Default: 'dashboard_preview_slot_<sanitized-username>' (per-user, since 0.1.93).
# When set explicitly, the literal token {user} in the value is replaced at
# render time with the sanitized current username (a-z, 0-9, _, - only).
# This substitution applies to both previewSlot and baselineSlot.
# Example: kohist_current_{user} → kohist_current_admin for user 'admin'.
# A value without {user} is used as-is (today's behavior).
# When no Splunk username is available, {user} resolves to an empty string
# and the slot becomes shared across all users (same as omitting {user}).
# WARNING: two viz panels on the same dashboard must use DISTINCT slot names.
# When multiple users share a dashboard, include {user} in every custom slot
# name — e.g. mypanel_{user} — to prevent concurrent renders from overwriting
# each other's preview views.
display.visualizations.custom.ko_history.dashboard_preview.previewSlot = <string>
display.visualizations.custom.ko_history.dashboard_preview.baselineSlot = <string>
display.visualizations.custom.ko_history.dashboard_preview.urlParams = <string>
display.visualizations.custom.ko_history.dashboard_preview.scale = <string>
display.visualizations.custom.ko_history.dashboard_preview.background = <string>

# Schematic DS-host diff viz (dashboard_preview_ds).
# Include _time in the driving search's table (e.g. "| table role _time title data")
# to show each column's version timestamp under its Baseline/Target label.
display.visualizations.custom.ko_history.dashboard_preview_ds.dataField = <string>
display.visualizations.custom.ko_history.dashboard_preview_ds.roleField = <string>
display.visualizations.custom.ko_history.dashboard_preview_ds.baselineValue = <string>
display.visualizations.custom.ko_history.dashboard_preview_ds.targetValue = <string>
display.visualizations.custom.ko_history.dashboard_preview_ds.showSplit = <boolean>
display.visualizations.custom.ko_history.dashboard_preview_ds.showLive = <boolean>
display.visualizations.custom.ko_history.dashboard_preview_ds.liveMock = <boolean>
display.visualizations.custom.ko_history.dashboard_preview_ds.showLabels = <boolean>
display.visualizations.custom.ko_history.dashboard_preview_ds.showChangeList = <boolean>
display.visualizations.custom.ko_history.dashboard_preview_ds.showSourceDiff = <boolean>
display.visualizations.custom.ko_history.dashboard_preview_ds.background = <string>

# Foldable syntax-highlighted source viewer (json_viewer). 16 options.
# Reads columns: dataField (KO source), pathField (display name), appField (app name).
# In diff mode the search must supply a roleField column with baselineValue / targetValue rows.
display.visualizations.custom.ko_history.json_viewer.dataField = <string>
# * Default: 'data'. Column containing the raw KO source (Studio JSON or Simple XML).
display.visualizations.custom.ko_history.json_viewer.pathField = <string>
# * Default: 'title'. Column used as the display name / path shown in the header.
display.visualizations.custom.ko_history.json_viewer.appField = <string>
# * Default: 'app'. Column providing the app name shown alongside the title.
display.visualizations.custom.ko_history.json_viewer.indent = <integer>
# * Default: 2. JSON pretty-print indent width (clamped 1–8).
display.visualizations.custom.ko_history.json_viewer.initialDepth = <integer>
# * Default: 0 (fully collapsed). Depth to auto-expand on first render.
display.visualizations.custom.ko_history.json_viewer.showLineNumbers = <boolean>
# * Default: true.
display.visualizations.custom.ko_history.json_viewer.showFooter = <boolean>
# * Default: true. Shows the line/character count footer.
display.visualizations.custom.ko_history.json_viewer.wrap = <boolean>
# * Default: false. Word-wrap long lines.
display.visualizations.custom.ko_history.json_viewer.banding = <boolean>
# * Default: true. Alternate row shading.
display.visualizations.custom.ko_history.json_viewer.showCopy = <boolean>
# * Default: true. Show copy-to-clipboard button.
display.visualizations.custom.ko_history.json_viewer.themeMode = <string>
# * Default: 'auto'. One of 'light', 'dark', or 'auto' (follows Splunk theme token).
display.visualizations.custom.ko_history.json_viewer.mode = <string>
# * Default: 'auto'. One of 'auto', 'single' (single version), or 'diff' (two-row compare).
#   'auto' shows diff when a roleField column is present, single otherwise.
display.visualizations.custom.ko_history.json_viewer.diffView = <string>
# * Default: 'split'. Diff layout: 'split' (side-by-side) or 'unified'.
display.visualizations.custom.ko_history.json_viewer.roleField = <string>
# * Default: 'role'. Column that identifies which row is baseline vs. target.
display.visualizations.custom.ko_history.json_viewer.baselineValue = <string>
# * Default: 'baseline'. Value in roleField that marks the older / reference version.
display.visualizations.custom.ko_history.json_viewer.targetValue = <string>
# * Default: 'target'. Value in roleField that marks the newer / subject version.

# KO record card — bespoke field profile for reports/alerts; generic profile for
# macros, event types, field extractions, lookups, tags (ko_viewer). 9 options.
# Reads columns named by titleField, appField, typeField plus the KO-type-specific
# fields captured by the backup searches.
# NOTE: mode, roleField, latestValue, previousValue are read in code but not
# exposed through the formatter UI. Set them via the panel XML
# (display.visualizations.custom.*) when the diff view is needed.
display.visualizations.custom.ko_history.ko_viewer.titleField = <string>
# * Default: 'title'.
display.visualizations.custom.ko_history.ko_viewer.appField = <string>
# * Default: 'appName'.
display.visualizations.custom.ko_history.ko_viewer.typeField = <string>
# * Default: 'type'. Used to select the bespoke profile (savedsearch vs. generic).
display.visualizations.custom.ko_history.ko_viewer.showCopy = <boolean>
# * Default: true. Show copy-to-clipboard button on the primary code field.
display.visualizations.custom.ko_history.ko_viewer.themeMode = <string>
# * Default: 'auto'. One of 'light', 'dark', or 'auto' (follows Splunk theme token).
# XML-only options (not exposed in the formatter panel):
display.visualizations.custom.ko_history.ko_viewer.mode = <string>
# * Default: 'auto'. 'auto', 'single', or 'diff'. 'auto' = diff when roleField present.
display.visualizations.custom.ko_history.ko_viewer.roleField = <string>
# * Default: 'role'. Column identifying which row is the latest vs. previous version.
display.visualizations.custom.ko_history.ko_viewer.latestValue = <string>
# * Default: 'target'. Value in roleField that marks the newer version.
display.visualizations.custom.ko_history.ko_viewer.previousValue = <string>
# * Default: 'baseline'. Value in roleField that marks the older version.
