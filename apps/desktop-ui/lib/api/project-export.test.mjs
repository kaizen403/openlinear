import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const api = vi.hoisted(() => ({ apiFetchRaw: null }))
vi.mock('./fetch', async (original) => ({ ...(await original()), apiFetchRaw: (...args) => api.apiFetchRaw(...args) }))

const { downloadProjectExport } = await import('./project-export.ts')
const { fileNameFromDisposition } = await import('../download.ts')

describe('FE-16 project export download', () => {
  let clicked = []
  beforeEach(() => {
    clicked = []
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake')
    globalThis.URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { clicked.push(this.download) })
  })
  afterEach(() => vi.restoreAllMocks())

  it('saves the export under the server-chosen file name and reports the size', async () => {
    api.apiFetchRaw = vi.fn(async () => new Response(JSON.stringify({ format: 'openlinear.project-export', taskCount: 3, truncated: false }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="openlinear-eng-2026-10-27.json"' },
    }))
    const result = await downloadProjectExport('p-1')
    expect(api.apiFetchRaw).toHaveBeenCalledWith('/api/projects/p-1/export')
    expect(result).toEqual({ fileName: 'openlinear-eng-2026-10-27.json', taskCount: 3, truncated: false })
    expect(clicked).toEqual(['openlinear-eng-2026-10-27.json'])
  })

  it('surfaces the server error instead of saving an error body', async () => {
    api.apiFetchRaw = vi.fn(async () => new Response(JSON.stringify({ error: 'You do not have access to this project', code: 'OWNERSHIP_REQUIRED' }), { status: 403 }))
    await expect(downloadProjectExport('p-1')).rejects.toThrow('You do not have access to this project')
    expect(clicked).toEqual([])
  })

  it('never takes a path from the Content-Disposition header', () => {
    expect(fileNameFromDisposition('attachment; filename="../../etc/passwd"', 'fallback.json')).toBe('fallback.json')
    expect(fileNameFromDisposition(null, 'fallback.json')).toBe('fallback.json')
  })
})
