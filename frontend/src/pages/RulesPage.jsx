import { useEffect, useState } from 'react'
import { getRules, setRuleActive } from '../api.js'
import Banner from '../components/Banner.jsx'

export default function RulesPage() {
  const [rules, setRules] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function refresh() {
    setRules(await getRules(true))
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message))
  }, [])

  async function toggle(rule) {
    setBusy(true)
    setError(null)
    try {
      await setRuleActive(rule.pattern, !rule.active)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Rules</h1>
        <p className="mt-1 text-sm text-slate-500">Rules are created by ticking “remember” while reviewing an import. They match as case-insensitive substrings of the bank description.</p>
      </div>
      <Banner kind="error">{error}</Banner>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="table">
          <thead className="bg-slate-50">
            <tr><th scope="col">Pattern</th><th scope="col">Merchant</th><th scope="col">Type</th><th scope="col">Category</th><th scope="col">Subcategory</th><th scope="col">Status</th><th scope="col"></th></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="min-w-64 max-w-md break-words font-mono text-xs">{r.pattern}</td>
                <td>{r.merchant ?? <span className="text-slate-400">—</span>}</td>
                <td>{r.type ?? <span className="text-slate-400">—</span>}</td>
                <td>{r.category}</td>
                <td>{r.subcategory ?? <span className="text-slate-400">—</span>}</td>
                <td>{r.active ? <span className="text-emerald-700">Active</span> : <span className="text-slate-500">Inactive</span>}</td>
                <td className="text-right">
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => toggle(r)}>{r.active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-slate-500">No remembered rules yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
