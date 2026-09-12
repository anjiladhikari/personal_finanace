import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, finalizeImport, request } from '../api.js'

function mockFetch(status, body, contentType = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: { get: () => contentType },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('request', () => {
  it('surfaces the FastAPI detail string as a clean error', async () => {
    mockFetch(409, { detail: 'this PDF has already been imported' })
    await expect(request('/api/imports/prepare', { method: 'POST' })).rejects.toMatchObject({
      name: 'ApiError', status: 409, message: 'this PDF has already been imported',
    })
  })

  it('flattens FastAPI validation error lists', async () => {
    mockFetch(422, { detail: [{ loc: ['body', 'review_items'], msg: 'Field required', type: 'missing' }] })
    await expect(request('/api/x')).rejects.toThrow('review_items: Field required')
  })

  it('never surfaces raw HTML or tracebacks', async () => {
    mockFetch(500, '<html><body>Traceback (most recent call last) /Users/x/api.py</body></html>', 'text/html')
    const error = await request('/api/x').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toBe('Request failed (500)')
    expect(error.message).not.toMatch(/Traceback|\/Users/)
  })

  it('posts only review_items to the token endpoint', async () => {
    const fetchMock = mockFetch(200, { status: 'completed' })
    const items = [{ date: '2026-01-05', description: 'X', amount: -1, balance: 0, decision: 'approved' }]
    await finalizeImport('tok en', items)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:8000/api/imports/tok%20en/finalize')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ review_items: items })
  })
})
