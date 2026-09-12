import { useEffect, useState } from 'react'
import { addCategory, getCategories, setCategoryActive } from '../api.js'
import Banner from '../components/Banner.jsx'
import Field from '../components/Field.jsx'

export default function CategoriesPage() {
  const [categories, setCategories] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  async function refresh() {
    setCategories(await getCategories(true))
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message))
  }, [])

  async function run(action, message) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      await refresh()
      setNotice(message)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Categories</h1>
      <form className="card flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => { e.preventDefault(); run(() => addCategory(name), `Category "${name.trim()}" added.`).then(() => setName('')) }}>
        <Field id="new-category" label="New category" className="flex-1">
          <input id="new-category" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="e.g. Travel" />
        </Field>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Add category'}</button>
      </form>
      <Banner kind="error">{error}</Banner>
      <Banner kind="success">{notice}</Banner>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="table">
          <thead className="bg-slate-50"><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}</td>
                <td>{c.active ? <span className="text-emerald-700">Active</span> : <span className="text-slate-500">Inactive</span>}</td>
                <td className="text-right">
                  <button type="button" className="btn-secondary" disabled={busy}
                    onClick={() => run(() => setCategoryActive(c.name, !c.active), `Category "${c.name}" ${c.active ? 'deactivated' : 'activated'}.`)}>
                    {c.active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
            {categories.length === 0 && <tr><td colSpan={3} className="py-8 text-center text-slate-500">No categories yet. Add one above.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
