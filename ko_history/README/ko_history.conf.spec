# ko_history.conf.spec
#
# Application settings for KO History. Place overrides in
# $SPLUNK_HOME/etc/apps/ko_history/local/ko_history.conf, or use the settings
# page (Settings in the KO History nav), which writes local for you.
# On Splunk Cloud the settings page is the only route, since the filesystem is
# not reachable.

[restore]
* Controls which knowledge object types KO History may write back into your
  environment. Restore takes a captured version and creates or overwrites a
  real object in the app you select, so it is the only destructive operation
  in the app.
* Every key defaults to 0. Restore is opt-in: a fresh install, and an upgrade
  from a release before 1.2.0, has restore disabled for every type until an
  admin enables it.
* Capture, version history, preview, compare and the source viewer do not
  consult these settings and work normally with everything disabled.
* If this stanza is missing or unreadable, the app behaves as though every key
  were 0.

dashboard = <boolean>
* Allow restoring dashboards, both Simple XML and Dashboard Studio.
* Default: 0

savedsearch = <boolean>
* Allow restoring reports and alerts.
* Default: 0

macro = <boolean>
eventtype = <boolean>
fieldextraction = <boolean>
lookup = <boolean>
tag = <boolean>
* Reserved. Restore is implemented for these five types but has not completed
  testing, so the app ignores these keys and the settings page lists them as
  greyed-out placeholders. Setting them to 1 has no effect. They are expected
  to become active in a later release.
* Default: 0
