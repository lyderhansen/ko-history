/*
 * Real Studio render via @splunk/dashboard-core — DATA-LESS.
 *
 * Mounts the actual Splunk Dashboard Studio component tree for a parsed
 * <definition>, so panels render as their true visualizations (single value,
 * line, table, markdown, …) instead of schematic boxes. We strip every
 * dataSource first, so NO search runs: the panels render their empty/no-data
 * state. This needs no cookie, no authenticated fetch and no iframe, so it is
 * safe inside the Dashboard Studio sandbox.
 *
 * Studio only — Simple XML has no JSON definition to feed the framework.
 */
var React = require('react');
var ReactDOMClient = require('react-dom/client');

function interop(m) { return (m && m.__esModule && m.default !== undefined) ? m.default : (m && m.default !== undefined ? m.default : m); }

var DashboardCore = interop(require('@splunk/dashboard-core'));
var DashboardContextProvider = require('@splunk/dashboard-context').DashboardContextProvider;
var EnterpriseViewOnlyPreset = interop(require('@splunk/dashboard-presets/EnterpriseViewOnlyPreset'));
var TestDataSource = interop(require('@splunk/datasources/TestDataSource'));

// maplibre-gl is stubbed at build time (sandbox blocks its worker). Remove the
// map visualizations from the preset so the framework never tries to mount one.
// We also register ds.test (constant data source) so panels can show synthetic
// values instead of "no data" — splunkd is never contacted.
var PRESET = (function () {
    var p = EnterpriseViewOnlyPreset || {};
    var viz = {};
    if (p.visualizations) {
        for (var k in p.visualizations) {
            if (Object.prototype.hasOwnProperty.call(p.visualizations, k) && k.indexOf('map') === -1 && k.indexOf('choropleth') === -1) {
                viz[k] = p.visualizations[k];
            }
        }
    }
    var ds = {};
    if (p.dataSources) { for (var dk in p.dataSources) { if (Object.prototype.hasOwnProperty.call(p.dataSources, dk)) ds[dk] = p.dataSources[dk]; } }
    ds['ds.test'] = TestDataSource;
    var clone = {};
    for (var kk in p) { if (Object.prototype.hasOwnProperty.call(p, kk)) clone[kk] = p[kk]; }
    clone.visualizations = viz;
    clone.dataSources = ds;
    return clone;
})();

// Synthetic data shaped to a viz type → ds.test options.data (column-major).
function mockDataFor(type) {
    type = (type || '').toLowerCase();
    if (/single|gauge|marker|filler|radial/.test(type)) {
        return { fields: ['value'], columns: [[Math.round(40 + 60 * 0.7)]] }; // a stable-looking number
    }
    if (/pie|donut/.test(type)) {
        return { fields: ['category', 'count'], columns: [['Web', 'API', 'DB', 'Cache'], [42, 31, 18, 9]] };
    }
    if (/line|area|column|bar/.test(type)) {
        var cats = ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'];
        var vals = [12, 28, 19, 41, 33, 24];
        return { fields: ['_time', 'count'], columns: [cats, vals] };
    }
    if (/table/.test(type)) {
        return { fields: ['host', 'status', 'count'], columns: [['web01', 'web02', 'db01'], ['OK', 'WARN', 'OK'], [128, 17, 64]] };
    }
    if (/event/.test(type)) {
        return { fields: ['_time', '_raw'], columns: [['12:01', '12:02'], ['user=alice action=login', 'user=bob action=search']] };
    }
    // default: a small two-column table so something shows.
    return { fields: ['name', 'value'], columns: [['alpha', 'beta', 'gamma'], [3, 7, 5]] };
}

// Remove all data bindings so the framework renders structure only — no
// search is ever issued (which would fail in the sandbox anyway).
function dataless(def) {
    var d;
    try { d = JSON.parse(JSON.stringify(def || {})); } catch (e) { d = {}; }
    delete d.dataSources;
    if (d.visualizations) {
        for (var k in d.visualizations) {
            if (d.visualizations[k] && d.visualizations[k].dataSources) delete d.visualizations[k].dataSources;
        }
    }
    if (d.inputs) {
        for (var ik in d.inputs) {
            if (d.inputs[ik] && d.inputs[ik].dataSources) delete d.inputs[ik].dataSources;
        }
    }
    return d;
}

// Replace every data binding with a synthetic ds.test source so panels render
// representative values. No search is issued (splunkd is never contacted).
function withMockData(def) {
    var d;
    try { d = JSON.parse(JSON.stringify(def || {})); } catch (e) { return dataless(def); }
    var sources = {};
    if (d.visualizations) {
        for (var id in d.visualizations) {
            if (!Object.prototype.hasOwnProperty.call(d.visualizations, id)) continue;
            var v = d.visualizations[id] || {};
            var type = (v.type || '').toLowerCase();
            // Text panels render their own content — no data needed.
            if (/markdown|html|image/.test(type)) { if (v.dataSources) delete v.dataSources; continue; }
            var dsId = 'mock_' + id;
            sources[dsId] = { type: 'ds.test', options: { data: mockDataFor(type) } };
            v.dataSources = { primary: dsId };
        }
    }
    d.dataSources = sources;
    if (d.inputs) {
        for (var ik in d.inputs) { if (d.inputs[ik] && d.inputs[ik].dataSources) delete d.inputs[ik].dataSources; }
    }
    return d;
}

// Mount the live dashboard into `container`. Returns a React root for unmount.
// useMock=true fills panels with synthetic data; otherwise renders data-less.
function mount(container, definition, useMock) {
    var def = useMock ? withMockData(definition) : dataless(definition);
    var root = ReactDOMClient.createRoot(container);
    root.render(
        React.createElement(
            DashboardContextProvider,
            { preset: PRESET, initialDefinition: def, initialMode: 'view' },
            React.createElement(DashboardCore, { width: '100%', height: '100%' })
        )
    );
    return root;
}

module.exports = { mount: mount };
