import { formatMoney } from '../money.js'

// Displays integer cents; colour only, the value itself is untouched.
export default function Money({ cents, className = '' }) {
  const tone = cents > 0 ? 'text-emerald-700' : cents < 0 ? 'text-slate-900' : 'text-slate-500'
  return <span className={`whitespace-nowrap tabular-nums ${tone} ${className}`}>{formatMoney(cents)}</span>
}
