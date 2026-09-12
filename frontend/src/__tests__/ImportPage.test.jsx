import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.js'
import ImportPage from '../pages/ImportPage.jsx'

vi.mock('../api.js', () => ({
  getCategories: vi.fn(),
  prepareImport: vi.fn(),
  finalizeImport: vi.fn(),
  discardImport: vi.fn(),
}))

const ITEMS = [
  { date: '2026-01-05', description: 'EXAMPLE CAFE MELBOURNE', amount: -450, balance: 9550, merchant: null, type: null,
    category: null, subcategory: null, needs_review: true, is_internal: false, is_duplicate: false,
    transaction_hash: 'a'.repeat(64), occurrence: 1, in_database: false, in_batch: false, remember_choice: false, decision: null },
  { date: '2026-01-06', description: 'Transfer to own savings', amount: -5000, balance: 4550, merchant: null,
    type: 'Internal Transfer', category: 'Transfers', subcategory: null, needs_review: false, is_internal: true,
    is_duplicate: false, transaction_hash: 'b'.repeat(64), occurrence: 1, in_database: false, in_batch: false,
    remember_choice: false, decision: null },
]
const PREPARED = { import_token: 'tok123', bank: 'commbank', statement_start_date: '2026-01-01',
  statement_end_date: '2026-01-31', parsed_count: 2, review_items: ITEMS }

async function prepare(user) {
  const file = new File(['%PDF-1.4 synthetic'], 'statement.pdf', { type: 'application/pdf' })
  await user.upload(screen.getByLabelText('Statement PDF'), file)
  await user.click(screen.getByRole('button', { name: 'Prepare Import' }))
  await screen.findByText('EXAMPLE CAFE MELBOURNE')
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getCategories.mockResolvedValue([{ id: 1, name: 'Eating Out', active: true }, { id: 2, name: 'Transfers', active: true }])
  api.prepareImport.mockResolvedValue(structuredClone(PREPARED))
})

describe('ImportPage', () => {
  it('renders prepared review items with statement period and raw fields as text', async () => {
    const user = userEvent.setup()
    render(<ImportPage navigate={vi.fn()} />)
    await prepare(user)
    expect(api.prepareImport).toHaveBeenCalledWith('commbank', expect.any(File))
    expect(screen.getByText('2026-01-01')).toBeInTheDocument()
    expect(screen.getByText('2026-01-31')).toBeInTheDocument()
    const rows = screen.getAllByTestId(/review-row-/)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('2026-01-05')).toBeInTheDocument()
    expect(within(rows[0]).getByText('-$4.50')).toBeInTheDocument()
    // raw fields are text only: the only inputs in a row are the editable ones
    const controls = [...rows[0].querySelectorAll('input, select, textarea')].map((el) => el.id || el.type)
    expect(controls).toEqual(['row-0-merchant', 'row-0-type', 'row-0-category', 'row-0-subcategory', 'checkbox'])
    expect(within(rows[0]).queryByDisplayValue('2026-01-05')).toBeNull()
    expect(within(rows[0]).queryByDisplayValue('EXAMPLE CAFE MELBOURNE')).toBeNull()
    expect(within(rows[1]).getByText('Internal Transfer')).toBeInTheDocument()
  })

  it('offers categories from the API only', async () => {
    const user = userEvent.setup()
    render(<ImportPage navigate={vi.fn()} />)
    await prepare(user)
    const options = within(screen.getByLabelText('Category', { selector: '#row-0-category' })).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['— none —', 'Eating Out', 'Transfers'])
    expect(api.getCategories).toHaveBeenCalledWith(false)
  })

  it('edits only editable fields, records decisions/remember, and finalizes with exactly review_items', async () => {
    const user = userEvent.setup()
    api.finalizeImport.mockResolvedValue({ status: 'completed', parsed_count: 2, saved_count: 1, rejected_count: 1,
      undecided_count: 0, internal_count: 0, duplicate_count: 0, conflict_count: 0, rules_created: 1 })
    const navigate = vi.fn()
    render(<ImportPage navigate={navigate} />)
    await prepare(user)
    const row0 = screen.getAllByTestId(/review-row-/)[0]
    await user.type(within(row0).getByLabelText('Merchant'), 'Example Cafe')
    await user.type(within(row0).getByLabelText('Type'), 'Expense')
    await user.selectOptions(within(row0).getByLabelText('Category'), 'Eating Out')
    await user.type(within(row0).getByLabelText('Subcategory'), 'Coffee')
    await user.click(within(row0).getByRole('checkbox'))
    await user.click(within(row0).getByRole('button', { name: 'Approve' }))
    expect(within(row0).getByText('Approved')).toBeInTheDocument()
    const row1 = screen.getAllByTestId(/review-row-/)[1]
    await user.click(within(row1).getByRole('button', { name: 'Reject' }))
    expect(within(row1).getByText('Rejected')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Finalize Import' }))
    await screen.findByText('Import completed')
    expect(api.finalizeImport).toHaveBeenCalledTimes(1)
    const [token, sent] = api.finalizeImport.mock.calls[0]
    expect(token).toBe('tok123')
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({ ...ITEMS[0], merchant: 'Example Cafe', type: 'Expense', category: 'Eating Out',
      subcategory: 'Coffee', remember_choice: true, decision: 'approved' })
    expect(sent[1]).toEqual({ ...ITEMS[1], decision: 'rejected' })
    // success clears review state and shows the API summary
    expect(screen.queryAllByTestId(/review-row-/)).toHaveLength(0)
    expect(screen.getByText('Rules created').nextSibling).toHaveTextContent('1')
    await user.click(screen.getByRole('button', { name: 'Go to Transactions' }))
    expect(navigate).toHaveBeenCalledWith('transactions')
  })

  it('keeps every edit when finalize fails', async () => {
    const user = userEvent.setup()
    api.finalizeImport.mockRejectedValue(new Error('item 0: category "Nope" is inactive'))
    render(<ImportPage navigate={vi.fn()} />)
    await prepare(user)
    const row0 = screen.getAllByTestId(/review-row-/)[0]
    await user.type(within(row0).getByLabelText('Merchant'), 'Keep me')
    await user.click(within(row0).getByRole('button', { name: 'Approve' }))
    await user.click(screen.getByRole('button', { name: 'Finalize Import' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('category "Nope" is inactive')
    expect(screen.getAllByTestId(/review-row-/)).toHaveLength(2)
    expect(within(screen.getAllByTestId(/review-row-/)[0]).getByLabelText('Merchant')).toHaveValue('Keep me')
    expect(within(screen.getAllByTestId(/review-row-/)[0]).getByText('Approved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Finalize Import' })).toBeEnabled()
  })

  it('shows backend errors from prepare and discards via the API', async () => {
    const user = userEvent.setup()
    api.prepareImport.mockRejectedValueOnce(new Error('Invalid PDF upload'))
    render(<ImportPage navigate={vi.fn()} />)
    const file = new File(['junk'], 'statement.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByLabelText('Statement PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Prepare Import' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid PDF upload')

    api.discardImport.mockResolvedValue({ status: 'discarded' })
    await prepare(user)
    await user.click(screen.getByRole('button', { name: 'Discard Import' }))
    await waitFor(() => expect(screen.queryAllByTestId(/review-row-/)).toHaveLength(0))
    expect(api.discardImport).toHaveBeenCalledWith('tok123')
    expect(api.finalizeImport).not.toHaveBeenCalled()
  })
})
