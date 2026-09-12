// The only place the backend URL and HTTP details live.
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function detailMessage(detail) {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc, msg, ...}]
    return detail.map((d) => (d.loc ? `${d.loc.slice(1).join('.')}: ${d.msg}` : d.msg)).join('; ')
  }
  return null
}

export async function request(path, { method = 'GET', json, formData, params } = {}) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
  }
  const init = { method, headers: {} }
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(json)
  } else if (formData) {
    init.body = formData
  }
  let response
  try {
    response = await fetch(url, init)
  } catch {
    throw new ApiError('Cannot reach the backend. Is the API running?', 0)
  }
  let body = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null // never surface raw HTML or plain-text error pages
    }
  }
  if (!response.ok) {
    const message = (body && detailMessage(body.detail)) || `Request failed (${response.status})`
    throw new ApiError(message, response.status)
  }
  return body
}

// --- endpoints -----------------------------------------------------------

export const getHealth = () => request('/api/health')

export function prepareImport(bank, file) {
  const formData = new FormData()
  formData.append('bank', bank)
  formData.append('file', file)
  return request('/api/imports/prepare', { method: 'POST', formData })
}

export const finalizeImport = (token, reviewItems) =>
  request(`/api/imports/${encodeURIComponent(token)}/finalize`, { method: 'POST', json: { review_items: reviewItems } })

export const discardImport = (token) => request(`/api/imports/${encodeURIComponent(token)}`, { method: 'DELETE' })

export const getCategories = (includeInactive = false) =>
  request('/api/categories', { params: { include_inactive: includeInactive } })

export const addCategory = (name) => request('/api/categories', { method: 'POST', json: { name } })

export const setCategoryActive = (name, active) =>
  request(`/api/categories/${encodeURIComponent(name)}/${active ? 'activate' : 'deactivate'}`, { method: 'PATCH' })

export const getRules = (includeInactive = false) => request('/api/rules', { params: { include_inactive: includeInactive } })

export const setRuleActive = (pattern, active) =>
  request(`/api/rules/${encodeURIComponent(pattern)}/${active ? 'activate' : 'deactivate'}`, { method: 'PATCH' })

export const getTransactions = (params) => request('/api/transactions', { params })

export const getDashboardSummary = (params) => request('/api/dashboard/summary', { params })

export const getDashboardCategories = (params) => request('/api/dashboard/categories', { params })

export const getHistoryIntegrity = () => request('/api/history/integrity')

export const getCoverage = (body) => request('/api/history/coverage', { method: 'POST', json: body })
