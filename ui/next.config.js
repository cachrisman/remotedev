const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build version injected at build time for client_error telemetry
  env: {
    UI_BUILD_VERSION: process.env.UI_BUILD_VERSION || `${Date.now()}`,
  },
  // Explicitly set workspace root to silence lockfile detection warning
  outputFileTracingRoot: path.join(__dirname, '../'),
};

module.exports = nextConfig;
