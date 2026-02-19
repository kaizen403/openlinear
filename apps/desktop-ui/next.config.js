/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: process.env.NEXT_IGNORE_BUILD_ERRORS === "1",
  },
  experimental: {
    cpus: process.env.CI ? 1 : undefined,
  },
  turbopack: {},
  webpack: (config) => {
    // Increase chunk loading timeout for Tauri webview cold starts
    config.output.chunkLoadTimeout = 120000
    return config
  },
}

module.exports = nextConfig
