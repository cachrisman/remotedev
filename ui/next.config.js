/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build version injected at build time for client_error telemetry
  env: {
    UI_BUILD_VERSION: process.env.UI_BUILD_VERSION || `${Date.now()}`,
  },
};

module.exports = nextConfig;
