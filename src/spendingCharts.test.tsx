import { render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { pieDataItem } from 'react-native-gifted-charts';

import { breakdownByCategory } from '@/domain/analysis';
import { DEFAULT_CURRENCY } from '@/domain/money';
import { spendingChart } from '@/domain/spendingChart';
import { categoryColor, REMAINING_COLOR } from '@/ui/categoryColors';
import { CategoryBars, CategoryPie } from '@/ui/SpendingCharts';
import { spendingLayout } from '@/ui/useSpendingLayout';

// Record what the real pie is asked to draw, then draw it.
const mockPieData: pieDataItem[][] = [];
jest.mock('react-native-gifted-charts', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const actual = jest.requireActual<typeof import('react-native-gifted-charts')>('react-native-gifted-charts');
  return {
    ...actual,
    PieChart: (props: import('react-native-gifted-charts').PieChartPropsType) => {
      mockPieData.push(props.data);
      return React.createElement(actual.PieChart, props);
    },
  };
});

beforeEach(() => {
  mockPieData.length = 0;
});

const LONG = 'Children’s after-school activities, sport registrations and uniforms';

function chartOf(rows: Record<string, number>) {
  return spendingChart(breakdownByCategory(Object.entries(rows).map(([category, amountMinor]) => ({ category, amountMinor }))));
}

const SEVEN = { Bills: 70_000, Groceries: 60_000, Transport: 50_000, Health: 40_000, Shopping: 30_000, 'Eating out': 20_000, Other: 10_000 };

function barWidth(category: string) {
  return StyleSheet.flatten(screen.getByTestId(`bar-${category}`).props.style).width as string;
}

describe('bar chart', () => {
  test('one horizontal bar per category on a shared scale from zero, with exact amounts', async () => {
    const chart = chartOf({ Bills: 50_000, Groceries: 25_000, Transport: 5_000 });
    await render(<CategoryBars chart={chart} currency={DEFAULT_CURRENCY} compact={false} />);

    expect(screen.getByTestId('category-row-Bills')).toHaveTextContent('Bills$500.00 · 62.5%');
    expect(screen.getByTestId('category-row-Groceries')).toHaveTextContent('Groceries$250.00 · 31.3%');
    expect(screen.getByTestId('category-row-Transport')).toHaveTextContent('Transport$50.00 · 6.2%');
    expect([barWidth('Bills'), barWidth('Groceries'), barWidth('Transport')]).toEqual(['100.000%', '50.000%', '10.000%']);
    // The scale is visual only; each row already speaks its amount.
    expect(screen.getByTestId('bar-scale', { includeHiddenElements: true })).toHaveTextContent('$0.00$500.00');
    expect(screen.queryByTestId('bar-scale')).toBeNull();
    expect(screen.getByTestId('bar-Bills')).toHaveStyle({ backgroundColor: categoryColor('Bills') });
  });

  test('rows read as one sentence to a screen reader', async () => {
    await render(<CategoryBars chart={chartOf({ Bills: 50_000, Groceries: 25_000 })} currency={DEFAULT_CURRENCY} compact={false} />);
    expect(screen.getByLabelText('Bills: $500.00, 66.7 percent of total spent')).toBeOnTheScreen();
    expect(screen.getByLabelText('Groceries: $250.00, 33.3 percent of total spent')).toBeOnTheScreen();
  });

  test('one category fills the scale', async () => {
    await render(<CategoryBars chart={chartOf({ Bills: 12_345 })} currency={DEFAULT_CURRENCY} compact={false} />);
    expect(screen.getByTestId('category-row-Bills')).toHaveTextContent('Bills$123.45 · 100%');
    expect(barWidth('Bills')).toBe('100.000%');
  });

  test('seven categories are all drawn, largest first', async () => {
    await render(<CategoryBars chart={chartOf(SEVEN)} currency={DEFAULT_CURRENCY} compact={false} />);
    const rows = within(screen.getByTestId('bar-chart')).getAllByTestId(/^category-row-/);
    expect(rows.map((row) => row.props.testID)).toEqual(Object.keys(SEVEN).map((name) => `category-row-${name}`));
  });

  test('very unequal amounts: tiny bars stay visible and read "<0.1%", money stays exact', async () => {
    await render(<CategoryBars chart={chartOf({ Rent: 99_999_998, Gum: 1, Stamp: 1 })} currency={DEFAULT_CURRENCY} compact={false} />);
    expect(screen.getByTestId('category-row-Rent')).toHaveTextContent('Rent$999,999.98 · 100%');
    expect(screen.getByTestId('category-row-Gum')).toHaveTextContent('Gum$0.01 · <0.1%');
    expect(screen.getByLabelText('Gum: $0.01, less than 0.1 percent of total spent')).toBeOnTheScreen();
    expect(StyleSheet.flatten(screen.getByTestId('bar-Gum').props.style).minWidth).toBeGreaterThanOrEqual(3);
  });

  test('long labels are shown in full and may wrap; nothing truncates text', async () => {
    await render(<CategoryBars chart={chartOf({ [LONG]: 4_000, Bills: 1_000 })} currency={DEFAULT_CURRENCY} compact />);
    const label = screen.getByText(LONG);
    expect(label.props.numberOfLines).toBeUndefined();
    expect(label.props.allowFontScaling).not.toBe(false);
    expect(screen.getByLabelText(`${LONG}: $40.00, 80 percent of total spent`)).toBeOnTheScreen();
  });
});

describe('pie chart', () => {
  test('draws the same totals as the bars, coloured by category', async () => {
    const chart = chartOf({ Bills: 50_000, Groceries: 25_000 });
    await render(<CategoryPie chart={chart} currency={DEFAULT_CURRENCY} compact={false} radius={120} />);

    expect(mockPieData.at(-1)).toEqual([
      { value: 50_000, color: categoryColor('Bills') },
      { value: 25_000, color: categoryColor('Groceries') },
    ]);
    expect(screen.getByTestId('pie-chart')).toHaveAccessibleName('Pie chart of spending by category. Bills 66.7 percent, Groceries 33.3 percent.');
    expect(screen.getByTestId('category-row-Bills')).toHaveTextContent('Bills$500.00 · 66.7%');
    expect(screen.getByTestId('category-row-Groceries')).toHaveTextContent('Groceries$250.00 · 33.3%');
  });

  test('one category is a single full slice', async () => {
    await render(<CategoryPie chart={chartOf({ Bills: 12_345 })} currency={DEFAULT_CURRENCY} compact={false} radius={120} />);
    expect(mockPieData.at(-1)).toEqual([{ value: 12_345, color: categoryColor('Bills') }]);
    expect(screen.getByTestId('pie-chart')).toHaveAccessibleName('Pie chart of spending by category. Bills 100 percent.');
  });

  test('seven categories: four slices plus "Remaining categories"; the list keeps all seven', async () => {
    await render(<CategoryPie chart={chartOf(SEVEN)} currency={DEFAULT_CURRENCY} compact={false} radius={120} />);

    expect(mockPieData.at(-1)).toEqual([
      { value: 70_000, color: categoryColor('Bills') },
      { value: 60_000, color: categoryColor('Groceries') },
      { value: 50_000, color: categoryColor('Transport') },
      { value: 40_000, color: categoryColor('Health') },
      { value: 60_000, color: REMAINING_COLOR },
    ]);
    expect(screen.getByTestId('pie-remaining')).toHaveTextContent('Remaining categories$600.00 · 21.4%');
    const breakdown = screen.getByTestId('pie-breakdown');
    for (const [name, amount] of Object.entries(SEVEN)) {
      expect(within(breakdown).getByTestId(`category-row-${name}`)).toHaveTextContent(new RegExp(`\\$${(amount / 100).toFixed(2)}`));
    }
    expect(screen.getByLabelText('Shopping, in remaining categories: $300.00, 10.7 percent of total spent')).toBeOnTheScreen();
    expect(screen.getByTestId('pie-chart')).toHaveAccessibleName(
      'Pie chart of spending by category. Bills 25 percent, Groceries 21.4 percent, Transport 17.9 percent, Health 14.3 percent, Remaining categories 21.4 percent.',
    );
  });

  test('very unequal amounts keep exact values in the list', async () => {
    await render(<CategoryPie chart={chartOf({ Rent: 99_999_998, Gum: 1, Stamp: 1 })} currency={DEFAULT_CURRENCY} compact={false} radius={120} />);
    expect(mockPieData.at(-1)?.map((slice) => slice.value)).toEqual([99_999_998, 1, 1]);
    expect(screen.getByTestId('category-row-Stamp')).toHaveTextContent('Stamp$0.01 · <0.1%');
  });

  test('a category keeps its colour whatever its rank, period or chart type', async () => {
    await render(<CategoryPie chart={chartOf({ Groceries: 900, Bills: 100 })} currency={DEFAULT_CURRENCY} compact={false} radius={120} />);
    await render(<CategoryPie chart={chartOf({ Bills: 900, Groceries: 100 })} currency={DEFAULT_CURRENCY} compact={false} radius={120} />);
    const [first, second] = mockPieData.slice(-2);
    expect(first?.find((slice) => slice.value === 100)?.color).toBe(categoryColor('Bills'));
    expect(second?.find((slice) => slice.value === 900)?.color).toBe(categoryColor('Bills'));

    await render(<CategoryBars chart={chartOf({ Bills: 900, Groceries: 100 })} currency={DEFAULT_CURRENCY} compact={false} />);
    expect(screen.getByTestId('bar-Bills')).toHaveStyle({ backgroundColor: categoryColor('Bills') });
  });

  test('the pie is hidden from touch and from the screen reader except for its summary', async () => {
    await render(<CategoryPie chart={chartOf({ Bills: 1, Groceries: 1 })} currency={DEFAULT_CURRENCY} compact={false} radius={120} />);
    const pie = screen.getByTestId('pie-chart');
    expect(pie.props.accessible).toBe(true);
    expect(pie.props.accessibilityRole).toBe('image');
    const drawing = pie.children[0] as { props: Record<string, unknown> };
    expect(drawing.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(drawing.props.pointerEvents).toBe('none');
  });
});

describe('narrow screens and large text', () => {
  test('a 320 dp phone at 200 % text stacks the amount under the name and fits the pie', async () => {
    const layout = spendingLayout(320, 2);
    await render(<CategoryPie chart={chartOf({ [LONG]: 4_000, Bills: 1_000 })} currency={DEFAULT_CURRENCY} compact={layout.compact} radius={layout.pieRadius} />);

    const nameAndAmount = screen.getByText(LONG).parent;
    expect(nameAndAmount).not.toBeNull();
    expect(nameAndAmount).toHaveStyle({ flexDirection: 'column' });
    expect(within(screen.getByTestId(`category-row-${LONG}`)).getByText('$40.00 · 80%')).toBeOnTheScreen();
    expect(layout.pieRadius * 2).toBeLessThanOrEqual(320 - 64);
  });
});

test('a wide phone with default text keeps name and amount on one line where they fit', async () => {
  const layout = spendingLayout(480, 1);
  await render(<CategoryBars chart={chartOf({ Bills: 1_000 })} currency={DEFAULT_CURRENCY} compact={layout.compact} />);
  expect(screen.getByText('Bills').parent).toHaveStyle({ flexDirection: 'row', flexWrap: 'wrap' });
});
