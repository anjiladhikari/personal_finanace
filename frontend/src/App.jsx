import { useEffect, useState } from 'react'
import DashboardPage from './pages/DashboardPage.jsx'
import ImportPage from './pages/ImportPage.jsx'
import TransactionsPage from './pages/TransactionsPage.jsx'
import CategoriesPage from './pages/CategoriesPage.jsx'
import RulesPage from './pages/RulesPage.jsx'
import HistoryPage from './pages/HistoryPage.jsx'

const PAGES = [
  { key: 'dashboard', label: 'Dashboard', component: DashboardPage },
  { key: 'import', label: 'Import', component: ImportPage },
  { key: 'transactions', label: 'Transactions', component: TransactionsPage },
  { key: 'categories', label: 'Categories', component: CategoriesPage },
  { key: 'rules', label: 'Rules', component: RulesPage },
  { key: 'history', label: 'History', component: HistoryPage },
]

function pageFromHash() {
  const key = window.location.hash.replace(/^#\/?/, '')
  return PAGES.some((p) => p.key === key) ? key : 'dashboard'
}

export function navigate(key) {
  window.location.hash = `#/${key}`
}

export default function App() {
  const [page, setPage] = useState(pageFromHash)

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const Current = PAGES.find((p) => p.key === page).component

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-base font-semibold tracking-tight">Personal Finance</span>
          <nav aria-label="Main" className="flex flex-wrap gap-1">
            {PAGES.map((p) => (
              <a
                key={p.key}
                href={`#/${p.key}`}
                aria-current={p.key === page ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${
                  p.key === page ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                {p.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Current navigate={navigate} />
      </main>
    </div>
  )
}
