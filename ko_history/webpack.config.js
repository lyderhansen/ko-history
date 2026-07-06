const path = require('path');
const webpack = require('webpack');

module.exports = {
    mode: 'production',
    target: 'web',
    entry: path.resolve(__dirname, 'src/pages/wrapper/index.jsx'),
    output: {
        filename: 'wrapper.js',
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
        // Collapse dynamic-import chunks into the single page bundle so there
        // are no extra files to serve from Splunk static.
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ],
    performance: { hints: false },
};
