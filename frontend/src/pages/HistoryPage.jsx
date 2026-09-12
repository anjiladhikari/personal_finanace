import { useEffect, useState } from 'react'
import { getCoverage, getHistoryIntegrity } from '../api.js'
import Banner from '../components/Banner.jsx'
import Field from '../components/Field.jsx'

export default function HistoryPage() {
  const [integrity, setIntegrity] = useState(null)
  const [form, setForm] = useState({ ids: '', expected_start: '', expected_end: '' })
  const [coverage, setCoverage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    getHistoryIntegrity().then(setIntegrity).catch((err) => setError(err.message))
  }, [])

  async function checkCoverage(event) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setCoverage(null)
    try {
      const import_ids = form.ids.split(/[\s,]+/).filter(Boolean).map(Number)
      setCoverage(await getCoverage({
        import_ids,
        expected_start: form.expected_start || null,
        expected_end: form.expected_end || null,
      }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">History</h1>

      <section className="card space-y-2">
        <h2 className="text-base font-semibold">Import integrity</h2>
        {integrity ? (
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><dt className="text-slate-500">Completed imports</dt><dd className="font-semibold tabular-nums">{integrity.integrity.completed_import_count}</dd></div>
            <div><dt className="text-slate-500">Import records</dt><dd className={integrity.integrity.valid ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}>{integrity.integrity.valid ? 'Valid' : `${integrity.integrity.problems.length} with problems`}</dd></div>
            <div><dt className="text-slate-500">Stored transactions</dt><dd className="font-semibold tabular-nums">{integrity.totals.stored_transaction_count}</dd></div>
            <div><dt className="text-slate-500">Approved vs stored</dt><dd className={integrity.totals.matches ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}>{integrity.totals.matches ? 'Match' : `Mismatch (${integrity.totals.sum_approved_count} approved)`}</dd></div>
          </dl>
        ) : <p className="text-sm text-slate-500">Loading…</p>}
        {integrity && !integrity.integrity.valid && (
          <ul className="list-disc pl-5 text-sm text-rose-700">
            {integrity.integrity.problems.map((p) => <li key={p.import_id}>Import {p.import_id}: {p.problems.join('; ')}</li>)}
          </ul>
        )}
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="text-base font-semibold">Date coverage</h2>
          <p className="mt-1 text-sm text-slate-500">Enter the import IDs that belong to one account. Statements are never grouped automatically.</p>
        </div>
        <form onSubmit={checkCoverage} className="grid grid-cols-1 gap-3 md:grid-cols-4 md:items-end">
          <Field id="ids" label="Import IDs (comma separated)" className="md:col-span-2">
            <input id="ids" className="input" value={form.ids} onChange={(e) => setForm({ ...form, ids: e.target.value })} placeholder="1, 2, 3" disabled={busy} />
          </Field>
          <Field id="exp-start" label="Expected start (optional)">
            <input id="exp-start" type="date" className="input" value={form.expected_start} onChange={(e) => setForm({ ...form, expected_start: e.target.value })} disabled={busy} />
          </Field>
          <Field id="exp-end" label="Expected end (optional)">
            <input id="exp-end" type="date" className="input" value={form.expected_end} onChange={(e) => setForm({ ...form, expected_end: e.target.value })} disabled={busy} />
          </Field>
          <button type="submit" className="btn-primary md:col-span-4 md:justify-self-start" disabled={busy || !form.ids.trim()}>{busy ? 'Checking…' : 'Check coverage'}</button>
        </form>
        <Banner kind="error">{error}</Banner>
        {coverage && (
          <div className="space-y-3 text-sm">
            <p>
              <span className="font-medium uppercase">{coverage.bank}</span> · {coverage.statement_count} statements ·{' '}
              {coverage.actual_start} to {coverage.actual_end} · {coverage.covered_days} days covered ·{' '}
              {coverage.parsed_transaction_count} parsed / {coverage.saved_transaction_count} saved
            </p>
            {coverage.expected_period_complete !== null && (
              <Banner kind={coverage.expected_period_complete ? 'success' : 'error'}>
                Expected period {coverage.expected_start} to {coverage.expected_end}: {coverage.expected_period_complete ? 'fully covered' : `${coverage.gap_days} day(s) missing`}
              </Banner>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <h3 className="font-medium">Gaps {coverage.has_gaps ? `(${coverage.gap_days} days)` : ''}</h3>
                {coverage.gaps.length ? (
                  <ul className="list-disc pl-5">{coverage.gaps.map((g) => <li key={g.start}>{g.start} to {g.end}</li>)}</ul>
                ) : <p className="text-slate-500">No gaps.</p>}
              </div>
              <div>
                <h3 className="font-medium">Overlaps</h3>
                {coverage.overlaps.length ? (
                  <ul className="list-disc pl-5">{coverage.overlaps.map((o) => <li key={`${o.import_ids.join('-')}-${o.start}`}>Imports {o.import_ids.join(' & ')}: {o.start} to {o.end}</li>)}</ul>
                ) : <p className="text-slate-500">No overlaps.</p>}
              </div>
            </div>
            <div>
              <h3 className="font-medium">Statements</h3>
              <ul className="list-disc pl-5">{coverage.periods.map((p) => <li key={p.import_id}>Import {p.import_id}: {p.start} to {p.end}</li>)}</ul>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
