/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  webpack: (config) => {
    // Increase chunk loading timeout for Tauri webview cold starts
    config.output.chunkLoadTimeout = 120000
    return config
  },
}

module.exports = nextConfig
