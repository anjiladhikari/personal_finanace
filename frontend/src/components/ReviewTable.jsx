import Money from './Money.jsx'

export const TYPE_SUGGESTIONS = ['Expense', 'Income', 'Internal Transfer', 'Friends / Personal Transfers']

// Display-only hint; the backend recomputes internal status from the final type.
export function looksInternal(type) {
  return typeof type === 'string' && type.trim().toLowerCase() === 'internal transfer'
}

function DecisionBadge({ decision }) {
  const styles = {
    approved: 'bg-emerald-100 text-emerald-800',
    rejected: 'bg-rose-100 text-rose-800',
    pending: 'bg-slate-100 text-slate-600',
  }
  const key = decision || 'pending'
  const label = { approved: 'Approved', rejected: 'Rejected', pending: 'Pending' }[key]
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${styles[key]}`}>{label}</span>
}

// Editable review rows. Raw fields (date, description, amount) are rendered as text only.
export default function ReviewTable({ items, categories, onChange, disabled }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <datalist id="type-suggestions">
        {TYPE_SUGGESTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <table className="table">
        <thead className="bg-slate-50">
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Description</th>
            <th scope="col" className="text-right">Amount</th>
            <th scope="col">Merchant</th>
            <th scope="col">Type</th>
            <th scope="col">Category</th>
            <th scope="col">Subcategory</th>
            <th scope="col">Internal</th>
            <th scope="col">Remember</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const id = `row-${index}`
            const internal = looksInternal(item.type)
            return (
              <tr key={item.transaction_hash || index} data-testid={`review-row-${index}`}>
                <td className="whitespace-nowrap text-slate-700">{item.date}</td>
                <td className="min-w-64 max-w-md">
                  <div className="break-words text-slate-900">{item.description}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {item.is_duplicate && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">duplicate — will not be saved</span>
                    )}
                    {item.needs_review && !item.is_duplicate && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">no rule matched</span>
                    )}
                  </div>
                </td>
                <td className="text-right">
                  <Money cents={item.amount} />
                </td>
                <td className="min-w-40">
                  <label htmlFor={`${id}-merchant`} className="sr-only">Merchant</label>
                  <input id={`${id}-merchant`} className="input" value={item.merchant ?? ''} disabled={disabled}
                    onChange={(e) => onChange(index, { merchant: e.target.value })} />
                </td>
                <td className="min-w-40">
                  <label htmlFor={`${id}-type`} className="sr-only">Type</label>
                  <input id={`${id}-type`} className="input" list="type-suggestions" value={item.type ?? ''} disabled={disabled}
                    onChange={(e) => onChange(index, { type: e.target.value })} />
                </td>
                <td className="min-w-40">
                  <label htmlFor={`${id}-category`} className="sr-only">Category</label>
                  <select id={`${id}-category`} className="input" value={item.category ?? ''} disabled={disabled}
                    onChange={(e) => onChange(index, { category: e.target.value })}>
                    <option value="">— none —</option>
                    {categories.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    {item.category && !categories.includes(item.category) && (
                      <option value={item.category}>{item.category} (inactive)</option>
                    )}
                  </select>
                </td>
                <td className="min-w-36">
                  <label htmlFor={`${id}-subcategory`} className="sr-only">Subcategory</label>
                  <input id={`${id}-subcategory`} className="input" value={item.subcategory ?? ''} disabled={disabled}
                    onChange={(e) => onChange(index, { subcategory: e.target.value })} />
                </td>
                <td className="whitespace-nowrap">
                  {internal ? (
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800">Internal Transfer</span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td>
                  <label className="flex items-center gap-1 text-xs text-slate-600">
                    <input type="checkbox" checked={Boolean(item.remember_choice)} disabled={disabled}
                      onChange={(e) => onChange(index, { remember_choice: e.target.checked })} />
                    remember
                  </label>
                </td>
                <td className="whitespace-nowrap">
                  <div className="flex flex-col items-start gap-1">
                    <DecisionBadge decision={item.decision} />
                    <div className="flex gap-1">
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={disabled || item.decision === 'approved'}
                        onClick={() => onChange(index, { decision: 'approved' })}>Approve</button>
                      <button type="button" className="btn-danger px-2 py-1 text-xs" disabled={disabled || item.decision === 'rejected'}
                        onClick={() => onChange(index, { decision: 'rejected' })}>Reject</button>
                    </div>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
