#!/usr/bin/env node
// Fixture-driven screenshots of the review panel in headless Chrome.
//
//   node apps/desktop-ui/components/review/dev/screenshots.mjs [outDir]
//   # CHROMIUM_BIN=/path/to/chrome to pick a browser
//
// Builds the app's Tailwind CSS (scoped to the kit's sources), bundles
// screenshot-entry.jsx with esbuild (API/SSE aliased to fixture stand-ins),
// renders each scenario at 1180×760 and writes review-<scenario>.png
// (default: docs/reports/revamp-2026-10-26). Nothing touches a network.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const uiDir = resolve(here, '../../..')
const repoRoot = resolve(uiDir, '../..')
const outDir = resolve(process.argv[2] ?? join(repoRoot, 'docs/reports/revamp-2026-10-26'))
const work = mkdtempSync(join(tmpdir(), 'openlinear-review-shots-'))
const SCENARIOS = (process.env.REVIEW_SHOTS_SCENARIOS ?? 'unified,split,states').split(',').filter(Boolean)
const ENTRY = process.env.REVIEW_SHOTS_ENTRY ?? 'screenshot-entry.jsx'
const WIDTH = 1180
const HEIGHT = 760

const chrome = process.env.CHROMIUM_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((path) => existsSync(path))
if (!chrome) throw new Error('No Chrome/Chromium found; set CHROMIUM_BIN')

try {
  // 1. Tailwind, scoped to what the panel renders.
  const css = join(work, 'app.css')
  execFileSync(join(uiDir, 'node_modules/.bin/tailwindcss'), [
    '-c', join(uiDir, 'tailwind.config.ts'),
    '-i', join(uiDir, 'app/globals.css'),
    '-o', css,
    '--content', `${uiDir}/components/{review,execution,ui}/**/*.{ts,tsx,jsx}`,
  ], { cwd: uiDir, stdio: 'pipe' })
  const fonts = pathToFileURL(join(uiDir, 'public/fonts')).href
  writeFileSync(css, readFileSync(css, 'utf8').replaceAll("url('/fonts/", `url('${fonts}/`))

  // 2. Bundle the fixture app (esbuild comes from the sidecar's toolchain).
  const esbuild = createRequire(join(repoRoot, 'apps/sidecar/package.json'))('esbuild')
  const aliases = {
    '@/lib/api/review': join(here, 'screenshot-api.mjs'),
    '@/providers/sse-provider': join(here, 'screenshot-sse.mjs'),
  }
  await esbuild.build({
    entryPoints: [join(here, ENTRY)],
    bundle: true,
    outfile: join(work, 'bundle.js'),
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    minify: true,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'alias',
      setup(build) {
        build.onResolve({ filter: /^@\// }, async (args) => {
          if (aliases[args.path]) return { path: aliases[args.path] }
          const resolved = await build.resolve(`./${args.path.slice(2)}`, { resolveDir: uiDir, kind: args.kind })
          return { path: resolved.path }
        })
      },
    }],
  })

  // 3. One page + screenshot per scenario.
  for (const scenario of SCENARIOS) {
    const html = join(work, `${scenario}.html`)
    writeFileSync(html, `<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="app.css">
<style>html,body{margin:0;background:rgb(10 10 10)}#root{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
/* Virtual time never advances CSS transitions: render end states. */
*,*::before,*::after{transition:none!important;animation:none!important}</style></head>
<body class="font-sans antialiased"><div id="root"></div><script>window.__REVIEW_SCENARIO=${JSON.stringify(scenario)}</script><script src="bundle.js"></script></body></html>`)
    const png = join(work, `review-${scenario}.png`)
    const result = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(work, `profile-${scenario}`)}`, '--force-device-scale-factor=1', '--allow-file-access-from-files',
      `--window-size=${WIDTH},${HEIGHT}`, '--virtual-time-budget=5000', `--screenshot=${png}`, pathToFileURL(html).href,
    ], { encoding: 'utf8', timeout: 60_000 })
    if (!existsSync(png)) throw new Error(`Chrome produced no screenshot for ${scenario}: ${result.stderr?.slice(-400)}`)
    const target = join(outDir, `review-${scenario}.png`)
    copyFileSync(png, target)
    const kb = Math.round(statSync(target).size / 1024)
    console.log(`${target} ${kb} KB`)
    if (kb >= 300) throw new Error(`${target} is ${kb} KB (limit 300 KB)`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
