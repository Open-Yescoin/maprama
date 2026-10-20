// Expo config plugin entry: `plugins: [['@open-yescoin/maprama-react-native', { features: ['drops'] }]]`.
const plugin = require('./plugin/build');

module.exports = plugin.default || plugin;
