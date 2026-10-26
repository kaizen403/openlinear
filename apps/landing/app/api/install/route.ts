import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const installScriptPath = fileURLToPath(new URL('../../../../../install.sh', import.meta.url))

export async function GET() {
  const installScript = await readFile(installScriptPath, 'utf8')

  return new Response(installScript, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
