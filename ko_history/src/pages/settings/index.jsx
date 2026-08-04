import React from 'react';
// navLayout:'auto' is what makes this page match native Splunk chrome.
//
// @splunk/react-page defaults it to 'classic', which short-circuits before it
// even asks the server, so the page renders the OLD top header while every
// native dashboard on Splunk 10.4 renders the new left sidebar. With 'auto' it
// fetches web-features and honours feature:modern-nav / enable_nav_vnext.
//
// Safe on older Splunk: when the feature is absent or off, the check returns
// false and the classic bar renders exactly as before.
//
// Not to be confused with `layout`, which is a different option controlling
// whether the bars are fixed or scroll away.
import layout from '@splunk/react-page';
import SettingsApp from '../../components/SettingsApp';

layout(<SettingsApp />, {
    pageTitle: 'KO History: Settings',
    hideFooter: true,
    layout: 'fixed',
    navLayout: 'auto',
    // react-page defaults theme to 'light'. Both pages render their own
    // content dark (SplunkThemeProvider colorScheme="dark", and the Quiet
    // Focus palette is dark-only), so without this the Splunk chrome came
    // out light around a dark page. Revisit when dynamic theming lands.
    theme: 'dark',
    themeFamily: 'prisma',
    themeDensity: 'comfortable',
});
