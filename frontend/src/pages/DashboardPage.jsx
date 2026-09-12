import { useEffect, useState } from 'react'
import { getDashboardCategories, getDashboardSummary } from '../api.js'
import Banner from '../components/Banner.jsx'
import Field from '../components/Field.jsx'
import Money from '../components/Money.jsx'
import { formatMoney } from '../money.js'

export default function DashboardPage() {
  const [range, setRange] = useState({ start_date: '', end_date: '' })
  const [applied, setApplied] = useState(range)
  const [summary, setSummary] = useState(null)
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([getDashboardSummary(applied), getDashboardCategories(applied)])
      .then(([s, c]) => {
        if (!cancelled) {
          setSummary(s)
          setCategories(c)
        }
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [applied])

  const maxSpend = categories.reduce((m, c) => Math.max(m, c.amount), 0)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <form className="card flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); setApplied(range) }}>
        <Field id="start" label="Start date">
          <input id="start" type="date" className="input" value={range.start_date}
            onChange={(e) => setRange({ ...range, start_date: e.target.value })} />
        </Field>
        <Field id="end" label="End date">
          <input id="end" type="date" className="input" value={range.end_date}
            onChange={(e) => setRange({ ...range, end_date: e.target.value })} />
        </Field>
        <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Loading…' : 'Apply'}</button>
        <button type="button" className="btn-secondary" disabled={loading}
          onClick={() => { const empty = { start_date: '', end_date: '' }; setRange(empty); setApplied(empty) }}>Clear</button>
      </form>

      <Banner kind="error">{error}</Banner>

      {summary && (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[['Money In', summary.money_in], ['Money Out', summary.money_out], ['Net', summary.net]].map(([label, cents]) => (
            <div key={label} className="card">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
              <dd className="mt-1 text-xl font-semibold"><Money cents={cents} /></dd>
            </div>
          ))}
          <div className="card">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Transactions</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{summary.transaction_count}</dd>
          </div>
        </dl>
      )}

      <section className="card">
        <h2 className="mb-3 text-base font-semibold">Spending by category</h2>
        {!loading && categories.length === 0 ? (
          <p className="text-sm text-slate-500">No spending in this period yet. Import a statement to get started.</p>
        ) : (
          <ul className="space-y-2">
            {categories.map((c) => (
              <li key={c.category ?? '__none'} className="grid grid-cols-[minmax(8rem,1fr)_3fr_auto] items-center gap-3 text-sm">
                <span className={c.category ? '' : 'italic text-slate-500'}>{c.category ?? 'Uncategorised'}</span>
                <div className="h-2 rounded bg-slate-100" aria-hidden="true">
                  <div className="h-2 rounded bg-slate-700" style={{ width: `${maxSpend ? Math.round((c.amount / maxSpend) * 100) : 0}%` }} />
                </div>
                <span className="whitespace-nowrap tabular-nums text-slate-700">
                  {formatMoney(c.amount)} <span className="text-xs text-slate-400">({c.transaction_count})</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
