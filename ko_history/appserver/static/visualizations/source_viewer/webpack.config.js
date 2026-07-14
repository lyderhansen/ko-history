var path = require('path');

module.exports = {
    entry: './src/visualization_source.js',
    target: 'web',
    output: {
        filename: 'visualization.js',
        path: path.resolve(__dirname),
        libraryTarget: 'amd'
    },
    resolve: { extensions: ['.js'] },
    externals: [
        'api/SplunkVisualizationBase',
        'api/SplunkVisualizationUtils'
    ],
    optimization: { splitChunks: false, runtimeChunk: false },
    performance: { hints: false }
};
