const path = require("node:path")

/** @type {import('next').NextConfig} */
const isTauriBuild = process.env.BUILD_FOR_TAURI === "1"
const isElectronBuild = process.env.BUILD_FOR_ELECTRON === "1"
const isDesktopBuild = isTauriBuild || isElectronBuild

const nextConfig = {
  reactStrictMode: true,
  ...(isDesktopBuild
    ? {
        output: "export",
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : {}),
  typescript: {
    ignoreBuildErrors: false,
  },
  experimental: {
    cpus: process.env.CI ? 1 : undefined,
  },
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  webpack: (config) => {
    config.output.chunkLoadTimeout = 120000
    return config
  },
}

module.exports = nextConfig
