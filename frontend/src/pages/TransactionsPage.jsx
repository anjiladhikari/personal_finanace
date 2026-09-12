import { useEffect, useState } from 'react'
import { getCategories, getTransactions } from '../api.js'
import Banner from '../components/Banner.jsx'
import Field from '../components/Field.jsx'
import Money from '../components/Money.jsx'

const PAGE_SIZE = 50
const EMPTY = { bank: '', start_date: '', end_date: '', category: '' }

export default function TransactionsPage() {
  const [filters, setFilters] = useState(EMPTY)
  const [applied, setApplied] = useState(EMPTY)
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    getCategories(true).then((list) => setCategories(list.map((c) => c.name))).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getTransactions({ ...applied, limit: PAGE_SIZE, offset })
      .then((data) => !cancelled && setRows(data))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [applied, offset])

  function apply(event) {
    event.preventDefault()
    setOffset(0)
    setApplied(filters)
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Transactions</h1>

      <form onSubmit={apply} className="card grid grid-cols-2 gap-3 md:grid-cols-6 md:items-end">
        <Field id="f-bank" label="Bank">
          <select id="f-bank" className="input" value={filters.bank} onChange={(e) => setFilters({ ...filters, bank: e.target.value })}>
            <option value="">All</option>
            <option value="commbank">CommBank</option>
            <option value="ing">ING</option>
          </select>
        </Field>
        <Field id="f-start" label="Start date">
          <input id="f-start" type="date" className="input" value={filters.start_date} onChange={(e) => setFilters({ ...filters, start_date: e.target.value })} />
        </Field>
        <Field id="f-end" label="End date">
          <input id="f-end" type="date" className="input" value={filters.end_date} onChange={(e) => setFilters({ ...filters, end_date: e.target.value })} />
        </Field>
        <Field id="f-category" label="Category">
          <select id="f-category" className="input" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
            <option value="">All</option>
            {categories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <button type="submit" className="btn-primary" disabled={loading}>Apply</button>
        <button type="button" className="btn-secondary" disabled={loading} onClick={() => { setFilters(EMPTY); setApplied(EMPTY); setOffset(0) }}>Clear</button>
      </form>

      <Banner kind="error">{error}</Banner>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="table">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col">Date</th><th scope="col">Description</th><th scope="col">Merchant</th>
              <th scope="col" className="text-right">Amount</th><th scope="col">Type</th><th scope="col">Category</th>
              <th scope="col">Subcategory</th><th scope="col">Bank</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="whitespace-nowrap text-slate-700">{t.date}</td>
                <td className="min-w-64 max-w-md break-words">{t.raw_description}</td>
                <td className="whitespace-nowrap">{t.merchant ?? <span className="text-slate-400">—</span>}</td>
                <td className="text-right"><Money cents={t.amount} data-cents={t.amount} /></td>
                <td className="whitespace-nowrap">{t.type ?? <span className="text-slate-400">—</span>}</td>
                <td className="whitespace-nowrap">{t.category ?? <span className="text-slate-400">—</span>}</td>
                <td className="whitespace-nowrap">{t.subcategory ?? <span className="text-slate-400">—</span>}</td>
                <td className="uppercase text-slate-600">{t.bank}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="py-8 text-center text-slate-500">No transactions{offset ? ' on this page' : ' yet'}.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>{loading ? 'Loading…' : `Showing ${rows.length ? offset + 1 : 0}–${offset + rows.length}`}</span>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
          <button type="button" className="btn-secondary" disabled={loading || rows.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
        </div>
      </div>
    </div>
  )
}
