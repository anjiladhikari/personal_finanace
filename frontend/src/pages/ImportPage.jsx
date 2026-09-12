import { useEffect, useState } from 'react'
import { discardImport, finalizeImport, getCategories, prepareImport } from '../api.js'
import Banner from '../components/Banner.jsx'
import Field from '../components/Field.jsx'
import ReviewTable from '../components/ReviewTable.jsx'

const EDITABLE_TEXT = ['merchant', 'type', 'category', 'subcategory']

// Review state lives only in this component's memory (never in storage).
export default function ImportPage({ navigate }) {
  const [bank, setBank] = useState('commbank')
  const [file, setFile] = useState(null)
  const [categories, setCategories] = useState([])
  const [prepared, setPrepared] = useState(null) // {import_token, bank, statement_start_date, ...}
  const [items, setItems] = useState([])
  const [summary, setSummary] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    getCategories(false)
      .then((list) => setCategories(list.map((c) => c.name)))
      .catch((err) => setError(err.message))
  }, [])

  async function onPrepare(event) {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    setSummary(null)
    try {
      const response = await prepareImport(bank, file)
      setPrepared(response)
      setItems(response.review_items)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function updateItem(index, patch) {
    const cleaned = { ...patch }
    for (const field of EDITABLE_TEXT) {
      if (field in cleaned && cleaned[field] === '') cleaned[field] = null
    }
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...cleaned } : item)))
  }

  function approveAllPending() {
    setItems((current) => current.map((item) => (item.decision ? item : { ...item, decision: 'approved' })))
  }

  async function onFinalize() {
    setBusy(true)
    setError(null)
    try {
      const result = await finalizeImport(prepared.import_token, items)
      setSummary(result)
      setPrepared(null)
      setItems([])
      setFile(null)
    } catch (err) {
      setError(err.message) // review state is kept so the user can fix and retry
    } finally {
      setBusy(false)
    }
  }

  async function onDiscard() {
    setBusy(true)
    setError(null)
    try {
      await discardImport(prepared.import_token)
      setPrepared(null)
      setItems([])
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const counts = {
    approved: items.filter((i) => i.decision === 'approved').length,
    rejected: items.filter((i) => i.decision === 'rejected').length,
    pending: items.filter((i) => !i.decision).length,
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Import statement</h1>

      {!prepared && !summary && (
        <form onSubmit={onPrepare} className="card flex flex-col gap-4 sm:flex-row sm:items-end">
          <Field id="bank" label="Bank">
            <select id="bank" className="input" value={bank} onChange={(e) => setBank(e.target.value)} disabled={busy}>
              <option value="commbank">CommBank</option>
              <option value="ing">ING</option>
            </select>
          </Field>
          <Field id="file" label="Statement PDF" className="flex-1">
            <input id="file" type="file" accept="application/pdf,.pdf" className="input" disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </Field>
          <button type="submit" className="btn-primary" disabled={busy || !file}>
            {busy ? 'Preparing…' : 'Prepare Import'}
          </button>
        </form>
      )}

      <Banner kind="error">{error}</Banner>

      {summary && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold">Import completed</h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Parsed', summary.parsed_count], ['Saved', summary.saved_count], ['Rejected', summary.rejected_count],
              ['Undecided', summary.undecided_count], ['Internal', summary.internal_count],
              ['Duplicates', summary.duplicate_count], ['Conflicts', summary.conflict_count],
              ['Rules created', summary.rules_created],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md bg-slate-50 p-3">
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => navigate('transactions')}>Go to Transactions</button>
            <button type="button" className="btn-secondary" onClick={() => navigate('dashboard')}>Go to Dashboard</button>
            <button type="button" className="btn-secondary" onClick={() => setSummary(null)}>Import another</button>
          </div>
        </div>
      )}

      {prepared && (
        <section className="space-y-4">
          <div className="card flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-700">
              <span className="font-medium uppercase">{prepared.bank}</span> statement{' '}
              <span className="font-medium">{prepared.statement_start_date}</span> to{' '}
              <span className="font-medium">{prepared.statement_end_date}</span> ·{' '}
              <span className="font-medium">{prepared.parsed_count}</span> transactions parsed ·{' '}
              {counts.approved} approved, {counts.rejected} rejected, {counts.pending} pending
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={approveAllPending} disabled={busy || counts.pending === 0}>
                Approve all pending
              </button>
              <button type="button" className="btn-danger" onClick={onDiscard} disabled={busy}>Discard Import</button>
              <button type="button" className="btn-primary" onClick={onFinalize} disabled={busy}>
                {busy ? 'Working…' : 'Finalize Import'}
              </button>
            </div>
          </div>
          {items.length === 0 ? (
            <p className="text-sm text-slate-500">This statement contains no transactions.</p>
          ) : (
            <ReviewTable items={items} categories={categories} onChange={updateItem} disabled={busy} />
          )}
        </section>
      )}
    </div>
  )
}
