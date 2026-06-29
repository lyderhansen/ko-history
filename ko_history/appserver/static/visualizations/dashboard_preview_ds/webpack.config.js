var path = require('path');

module.exports = {
    entry: './src/visualization_source.js',
    target: 'web',
    output: {
        filename: 'visualization.js',
        // Async chunks (live_render + dashboard-core) are emitted alongside
        // visualization.js in the same static directory. publicPath is set to
        // '' here and overridden at RUNTIME inside visualization_source.js
        // (document.currentScript-based), so chunk URLs are always correct
        // regardless of Splunk locale prefix or reverse-proxy path.
        chunkFilename: '[name].chunk.js',
        publicPath: '',
        path: path.resolve(__dirname),
        libraryTarget: 'amd'
    },
    resolve: {
        extensions: ['.js', '.jsx'],
        alias: {
            // Map panels need maplibre-gl, which drags in a heavy web-worker
            // bundle (blocked in the sandbox anyway). Stub it out — we drop
            // map visualizations from the preset at runtime so it's never used.
            'maplibre-gl$': false
        }
    },
    module: {
        rules: [
            // dashboard-core component CSS (maplibre, etc.) — inject at runtime.
            { test: /\.css$/, use: ['style-loader', 'css-loader'] },
            // fonts / images referenced by components — inline as data URIs so
            // the async chunk stays self-contained (no extra asset requests).
            { test: /\.(woff2?|ttf|eot|svg|png|jpe?g|gif|webp)$/, type: 'asset/inline' }
        ]
    },
    externals: [
        'api/SplunkVisualizationBase',
        'api/SplunkVisualizationUtils'
    ],
    optimization: {
        // Let webpack split live_render (+ its dependency graph: React,
        // dashboard-core, presets) into a separate async chunk — only fetched
        // when the user first toggles "Live render" on. The entry (visualization.js)
        // is still the single AMD module Splunk loads; only the async chunk(s)
        // are extra files.
        splitChunks: false,
        runtimeChunk: false
    },
    performance: { hints: false }
};
