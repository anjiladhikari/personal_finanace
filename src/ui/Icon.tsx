import type { ColorValue } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import type { CategoryIconKey } from '@/domain/categories';

/**
 * A small outline icon set on a 24 × 24 grid (2 px strokes, round ends),
 * drawn for this app with react-native-svg. Icons are decorative: the text
 * beside them carries the meaning, so they are hidden from screen readers.
 */
export type IconName =
  | CategoryIconKey
  | 'calendar'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'check'
  | 'check-circle'
  | 'add'
  | 'chart'
  | 'bars'
  | 'pie'
  | 'refresh'
  | 'alert'
  | 'clock'
  | 'user'
  | 'search'
  | 'close'
  | 'plus'
  | 'grid';


function shapes(name: IconName, color: ColorValue) {
  const dot = { fill: color, stroke: 'none' } as const;
  switch (name) {
    case 'groceries':
      return [
        <Path key="a" d="M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2" />,
        <Circle key="b" cx={9} cy={19} r={1.5} />,
        <Circle key="c" cx={17} cy={19} r={1.5} />,
      ];
    case 'eating-out':
      return [
        <Path key="a" d="M5 3v5a3 3 0 0 0 6 0V3M8 3v18" />,
        <Path key="b" d="M18 21V3c-2.2 1.4-3.5 4-3.5 7.5V13H18" />,
      ];
    case 'transport':
      return [
        <Rect key="a" x={4} y={3} width={16} height={14} rx={3} />,
        <Path key="b" d="M4 10h16M7 17v3M17 17v3" />,
        <Circle key="c" cx={8} cy={13.5} r={1} {...dot} />,
        <Circle key="d" cx={16} cy={13.5} r={1} {...dot} />,
      ];
    case 'bills':
      return [<Path key="a" d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />];
    case 'shopping':
      return [<Path key="a" d="M5 8h14l-1 12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1zM9 8V6a3 3 0 0 1 6 0v2" />];
    case 'health':
      return [
        <Path key="a" d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z" />,
        <Path key="b" d="M8 12h2l1.2-2 1.8 4 1.2-2H16" />,
      ];
    case 'other':
      return [
        <Circle key="a" cx={12} cy={12} r={9} />,
        <Circle key="b" cx={8} cy={12} r={1.2} {...dot} />,
        <Circle key="c" cx={12} cy={12} r={1.2} {...dot} />,
        <Circle key="d" cx={16} cy={12} r={1.2} {...dot} />,
      ];
    case 'calendar':
      return [<Rect key="a" x={3} y={5} width={18} height={16} rx={2} />, <Path key="b" d="M3 10h18M8 3v4M16 3v4" />];
    case 'chevron-left':
      return [<Path key="a" d="M15 6l-6 6 6 6" />];
    case 'chevron-right':
      return [<Path key="a" d="M9 6l6 6-6 6" />];
    case 'chevron-down':
      return [<Path key="a" d="M6 9l6 6 6-6" />];
    case 'check':
      return [<Path key="a" d="M5 12.5l4.5 4.5L19 7" />];
    case 'check-circle':
      return [<Circle key="a" cx={12} cy={12} r={9} />, <Path key="b" d="M8 12.5l3 3 5-6" />];
    case 'add':
      return [<Circle key="a" cx={12} cy={12} r={9} />, <Path key="b" d="M12 8v8M8 12h8" />];
    case 'chart':
      return [<Path key="a" d="M4 20h16M7 16v-5M12 16V6M17 16V9" />];
    case 'bars':
      return [<Path key="a" d="M4 6h11M4 12h16M4 18h7" />];
    case 'pie':
      return [<Path key="a" d="M12 3a9 9 0 1 0 9 9h-9z" />, <Path key="b" d="M15 3.5A9 9 0 0 1 20.5 9H15z" />];
    case 'refresh':
      return [<Path key="a" d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5" />];
    case 'alert':
      return [<Path key="a" d="M12 4l9 16H3zM12 10v4" />, <Circle key="b" cx={12} cy={17} r={1} {...dot} />];
    case 'clock':
      return [<Circle key="a" cx={12} cy={12} r={9} />, <Path key="b" d="M12 7v5l3 2" />];
    case 'user':
      return [<Circle key="a" cx={12} cy={8} r={4} />, <Path key="b" d="M4 21a8 8 0 0 1 16 0" />];
    case 'home':
      return [<Path key="a" d="M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-5h4v5" />];
    case 'bolt':
      return [<Path key="a" d="M13 3L5 13h6l-1 8 8-10h-6z" />];
    case 'phone':
      return [<Rect key="a" x={7} y={3} width={10} height={18} rx={2} />, <Path key="b" d="M11 18h2" />];
    case 'shield':
      return [<Path key="a" d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6zM9 12l2 2 4-4" />];
    case 'wrench':
      return [<Path key="a" d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.5-.5-.5-2.5z" />];
    case 'fuel':
      return [<Path key="a" d="M4 21V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16M3 21h11M4 10h9M13 9h2l2 2v6.5a1.5 1.5 0 0 0 3 0V8l-3-3" />];
    case 'car':
      return [
        <Path key="a" d="M4 16v-3l2-6h12l2 6v3zM4 13h16" />,
        <Circle key="b" cx={7.5} cy={17.5} r={1.5} />,
        <Circle key="c" cx={16.5} cy={17.5} r={1.5} />,
      ];
    case 'ticket':
      return [<Path key="a" d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM14 7v10" />];
    case 'repeat':
      return [<Path key="a" d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4" />];
    case 'plane':
      return [<Path key="a" d="M21 3L3 10.5l7 2.5 2.5 7zM10 13l11-10" />];
    case 'sparkle':
      return [
        <Path key="a" d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z" />,
        <Path key="b" d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z" />,
      ];
    case 'dumbbell':
      return [<Path key="a" d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12" />];
    case 'graduation':
      return [<Path key="a" d="M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5M22 9v5" />];
    case 'family':
      return [
        <Circle key="a" cx={9} cy={7} r={3} />,
        <Path key="b" d="M3 20a6 6 0 0 1 12 0" />,
        <Circle key="c" cx={17} cy={9} r={2} />,
        <Path key="d" d="M15.5 14.5A4.5 4.5 0 0 1 21 19" />,
      ];
    case 'paw':
      return [
        <Circle key="a" cx={6} cy={11} r={1.8} />,
        <Circle key="b" cx={9.5} cy={6.5} r={1.8} />,
        <Circle key="c" cx={14.5} cy={6.5} r={1.8} />,
        <Circle key="d" cx={18} cy={11} r={1.8} />,
        <Path key="e" d="M12 12c-3 0-5 3.5-5 5.5S9 20 12 20s5-.5 5-2.5S15 12 12 12z" />,
      ];
    case 'gift':
      return [
        <Rect key="a" x={3} y={8} width={18} height={4} rx={1} />,
        <Path key="b" d="M5 12v8h14v-8M12 8v12M12 8C10 4 6.5 5 7.5 8M12 8c2-4 5.5-3 4.5 0" />,
      ];
    case 'percent':
      return [<Path key="a" d="M19 5L5 19" />, <Circle key="b" cx={7} cy={7} r={2.5} />, <Circle key="c" cx={17} cy={17} r={2.5} />];
    case 'landmark':
      return [<Path key="a" d="M3 9l9-5 9 5zM5 9v9M10 9v9M14 9v9M19 9v9M3 21h18" />];
    case 'briefcase':
      return [<Rect key="a" x={3} y={7} width={18} height={13} rx={2} />, <Path key="b" d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18" />];
    case 'tag':
      return [<Path key="a" d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />, <Circle key="b" cx={7.5} cy={7.5} r={1.5} {...dot} />];
    case 'search':
      return [<Circle key="a" cx={11} cy={11} r={7} />, <Path key="b" d="M20 20l-4-4" />];
    case 'close':
      return [<Path key="a" d="M6 6l12 12M18 6L6 18" />];
    case 'plus':
      return [<Path key="a" d="M12 5v14M5 12h14" />];
    case 'grid':
      return [
        <Rect key="a" x={4} y={4} width={6} height={6} rx={1.5} />,
        <Rect key="b" x={14} y={4} width={6} height={6} rx={1.5} />,
        <Rect key="c" x={4} y={14} width={6} height={6} rx={1.5} />,
        <Rect key="d" x={14} y={14} width={6} height={6} rx={1.5} />,
      ];
  }
}

export function Icon({ name, color, size = 24 }: { readonly name: IconName; readonly color: ColorValue; readonly size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexShrink: 0 }}
      testID={`icon-${name}`}
    >
      {shapes(name, color)}
    </Svg>
  );
}
