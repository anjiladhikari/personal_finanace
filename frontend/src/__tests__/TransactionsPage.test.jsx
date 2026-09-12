import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.js'
import TransactionsPage from '../pages/TransactionsPage.jsx'

vi.mock('../api.js', () => ({ getCategories: vi.fn(), getTransactions: vi.fn() }))

const ROWS = [
  { id: 2, bank: 'ing', date: '2026-01-06', raw_description: 'SALARY EXAMPLE', merchant: null, amount: 12345, balance: 20000,
    type: 'Income', category: null, subcategory: null, created_at: 'x' },
  { id: 1, bank: 'commbank', date: '2026-01-05', raw_description: 'EXAMPLE CAFE', merchant: 'Example Cafe', amount: -999,
    balance: 7655, type: 'Expense', category: 'Eating Out', subcategory: null, created_at: 'x' },
]

beforeEach(() => {
  api.getCategories.mockResolvedValue([{ id: 1, name: 'Eating Out', active: true }])
  api.getTransactions.mockResolvedValue(structuredClone(ROWS))
})

describe('TransactionsPage', () => {
  it('keeps money as integer cents from the API and only formats for display', async () => {
    render(<TransactionsPage />)
    expect(await screen.findByText('$123.45')).toBeInTheDocument()
    expect(screen.getByText('-$9.99')).toBeInTheDocument()
    const [params] = api.getTransactions.mock.calls[0]
    expect(params).toMatchObject({ limit: 50, offset: 0 })
    const [returned] = await api.getTransactions.mock.results[0].value
    expect(Number.isInteger(returned.amount)).toBe(true)
    expect(returned.amount).toBe(12345)
  })
})
