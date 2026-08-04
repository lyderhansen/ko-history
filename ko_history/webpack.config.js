const path = require('path');
const webpack = require('webpack');

// One bundle per app page. Each entry name becomes <name>.js, which the
// matching appserver/templates/<name>.html loads by that path.
const entry = {
    wrapper: path.resolve(__dirname, 'src/pages/wrapper/index.jsx'),
    settings: path.resolve(__dirname, 'src/pages/settings/index.jsx'),
};

module.exports = {
    mode: 'production',
    target: 'web',
    entry,
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'appserver/static/pages'),
        // Normal IIFE bundle loaded via <script>; NOT an AMD module.
    },
    resolve: {
        extensions: ['.js', '.jsx'],
    },
    module: {
        rules: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: { presets: ['@babel/preset-env', '@babel/preset-react'] },
                },
            },
            { test: /\.css$/, use: ['style-loader', 'css-loader'] },
            { test: /\.(woff2?|ttf|eot|svg|png|jpe?g|gif|webp)$/, type: 'asset/inline' },
        ],
    },
    optimization: { minimize: true, splitChunks: false, runtimeChunk: false },
    plugins: [
        // Collapse dynamic-import chunks back into their page bundle so there are
        // no extra files to serve from Splunk static. The budget is one chunk per
        // entry, not one overall: with a lower limit this plugin will merge the
        // entry chunks themselves and each page ends up running both pages' code.
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: Object.keys(entry).length }),
    ],
    performance: { hints: false },
};
