import { resolve } from 'path'

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: resolve(import.meta.dirname, '../..'),
  },
  // Vercel deployment configuration
  images: {
    unoptimized: true,
  },
}

export default nextConfig
