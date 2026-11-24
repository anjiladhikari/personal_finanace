import { useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CATEGORY_NAME_MAX_LENGTH,
  pickerOrder,
  searchCategories,
  tidyCategoryName,
  validateCategoryName,
  type CategoryDefinition,
  type CategoryRegistry,
} from '@/domain/categories';
import type { CreateCategoryOutcome } from '@/sync/submissions';

import { Button } from './Button';
import { colourHex } from './categoryColors';
import { Icon } from './Icon';
import { radii, spacing, TOUCH_TARGET, typography, useTheme, useThemedStyles, type Theme } from './theme';

/** Share of the screen height the sheet takes when the keyboard is closed. */
export const SHEET_HEIGHT_RATIO = 0.68;

interface Props {
  readonly visible: boolean;
  readonly registry: CategoryRegistry;
  readonly selected: string | null;
  readonly onSelect: (name: string) => void;
  readonly onClose: () => void;
  readonly onCreate: (name: string) => Promise<CreateCategoryOutcome>;
}

type CreateProblem =
  | { readonly kind: 'blank' | 'too_long' | 'invalid_characters' | 'failed' }
  | { readonly kind: 'duplicate'; readonly existing: CategoryDefinition };

function problemText(problem: CreateProblem): string {
  switch (problem.kind) {
    case 'blank':
      return 'Enter a name for the category.';
    case 'too_long':
      return `Use ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`;
    case 'invalid_characters':
      return 'Use letters, numbers, spaces and punctuation only.';
    case 'failed':
      return 'Couldn’t save the category on this phone. Try again.';
    case 'duplicate':
      return `“${problem.existing.name}” already exists.`;
  }
}

function CategoryRow({ category, selected, onPress }: { readonly category: CategoryDefinition; readonly selected: boolean; readonly onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { colors, scheme } = useTheme();
  const tint = colourHex(category.colour, scheme);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={category.name}
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.pressed]}
      testID={`picker-category-${category.name}`}
    >
      <View style={[styles.rowIcon, { backgroundColor: `${tint}26` }]}>
        <Icon name={category.icon} color={tint} size={20} />
      </View>
      <Text style={[styles.rowName, selected && styles.rowNameSelected]}>{category.name}</Text>
      {selected ? <Icon name="check" color={colors.accent} size={22} /> : null}
    </Pressable>
  );
}

/**
 * "See more": every category in a bottom sheet over the form, with search
 * and "+ Add category". The sheet scrolls inside itself; the form below and
 * its draft are untouched. Android Back closes it.
 */
export function CategoryPicker({ visible, registry, selected, onSelect, onClose, onCreate }: Props) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<CreateProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const ordered = useMemo(() => pickerOrder(registry), [registry]);
  const results = useMemo(() => searchCategories(ordered, query), [ordered, query]);

  const reset = () => {
    setQuery('');
    setMode('list');
    setName('');
    setProblem(null);
    setBusy(false);
  };
  const close = () => {
    reset();
    onClose();
  };
  const choose = (categoryName: string) => {
    reset();
    onSelect(categoryName);
  };
  const startCreate = () => {
    setName(tidyCategoryName(query).slice(0, CATEGORY_NAME_MAX_LENGTH));
    setProblem(null);
    setMode('create');
  };

  const create = async () => {
    if (busy) return;
    const validation = validateCategoryName(name, registry);
    if (!validation.ok) {
      setProblem(validation.error === 'duplicate' ? { kind: 'duplicate', existing: validation.existing } : { kind: validation.error });
      return;
    }
    setBusy(true);
    const outcome = await onCreate(validation.name);
    setBusy(false);
    if (outcome.kind === 'created') choose(outcome.category.name);
    else if (outcome.kind === 'duplicate') setProblem({ kind: 'duplicate', existing: outcome.existing });
    else setProblem({ kind: outcome.kind === 'invalid' ? outcome.error : 'failed' });
  };

  const length = [...tidyCategoryName(name)].length;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={[styles.backdropArea, { paddingTop: insets.top }]}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close categories" testID="picker-backdrop" />
        <View
          style={[styles.sheet, { height: Math.round(height * SHEET_HEIGHT_RATIO), paddingBottom: insets.bottom + spacing.md }]}
          accessibilityViewIsModal
          testID="category-picker"
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              {mode === 'list' ? 'Choose a category' : 'New category'}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close} style={styles.closeButton} testID="picker-close">
              <Icon name="close" color={colors.text} size={22} />
            </Pressable>
          </View>

          {mode === 'list' ? (
            <>
              <View style={styles.searchBox}>
                <Icon name="search" color={colors.textMuted} size={20} />
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search categories"
                  placeholderTextColor={colors.outline}
                  accessibilityLabel="Search categories"
                  autoCorrect={false}
                  returnKeyType="search"
                  testID="category-search"
                />
                {query === '' ? null : (
                  <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={styles.clear} testID="category-search-clear">
                    <Icon name="close" color={colors.textMuted} size={18} />
                  </Pressable>
                )}
              </View>
              <FlatList
                style={styles.list}
                data={results}
                keyExtractor={(item) => item.id}
                keyboardShouldPersistTaps="handled"
                // A few dozen rows: render them all at once so search results never pop in.
                initialNumToRender={80}
                renderItem={({ item }) => <CategoryRow category={item} selected={item.name === selected} onPress={() => choose(item.name)} />}
                ListEmptyComponent={
                  <View style={styles.empty} testID="picker-empty" accessibilityLiveRegion="polite">
                    <Text style={styles.emptyTitle}>No categories match “{query.trim()}”.</Text>
                    <Text style={styles.emptyBody}>Check the spelling, or add it as a new category.</Text>
                  </View>
                }
                testID="category-list"
              />
              <View style={styles.footer}>
                <Button variant="secondary" icon="plus" label="Add category" onPress={startCreate} testID="add-category" />
              </View>
            </>
          ) : (
            <>
              <View style={styles.createBody}>
                <Text style={styles.label} nativeID="new-category-label">
                  Category name
                </Text>
                <TextInput
                  style={[styles.nameInput, problem !== null && problem.kind !== 'failed' && styles.nameInputError]}
                  value={name}
                  onChangeText={(text) => {
                    setName(text);
                    setProblem(null);
                  }}
                  maxLength={CATEGORY_NAME_MAX_LENGTH}
                  autoFocus
                  autoCapitalize="sentences"
                  placeholder="For example, Kids’ activities"
                  placeholderTextColor={colors.outline}
                  accessibilityLabel="Category name"
                  returnKeyType="done"
                  onSubmitEditing={() => void create()}
                  testID="new-category-name"
                />
                <Text style={styles.counter} accessibilityLabel={`${length} of ${CATEGORY_NAME_MAX_LENGTH} characters`}>
                  {length}/{CATEGORY_NAME_MAX_LENGTH}
                </Text>
                {problem === null ? null : (
                  <View style={styles.problem} accessibilityLiveRegion="polite" testID="new-category-problem">
                    <View style={styles.problemRow}>
                      <Icon name="alert" color={colors.danger} size={18} />
                      <Text style={styles.problemText}>{problemText(problem)}</Text>
                    </View>
                    {problem.kind === 'duplicate' ? (
                      <Button
                        variant="secondary"
                        label={`Select “${problem.existing.name}”`}
                        onPress={() => choose(problem.existing.name)}
                        testID="select-existing-category"
                      />
                    ) : null}
                  </View>
                )}
              </View>
              <View style={styles.footer}>
                <Button label={busy ? 'Creating…' : 'Create & select'} onPress={() => void create()} disabled={busy} busy={busy} testID="create-category" />
                <Button variant="secondary" label="Cancel" onPress={() => setMode('list')} testID="cancel-create-category" />
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles({ colors, scheme }: Theme) {
  return StyleSheet.create({
    backdropArea: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { flex: 1, backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(24,44,36,0.4)' },
    sheet: {
      maxHeight: '100%',
      backgroundColor: colors.surface,
      borderTopLeftRadius: radii.lg + 4,
      borderTopRightRadius: radii.lg + 4,
      paddingHorizontal: spacing.lg,
      gap: spacing.md,
    },
    handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.outline, marginTop: spacing.sm },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    title: { ...typography.title, color: colors.text, flexShrink: 1 },
    closeButton: { width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', marginRight: -spacing.md },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: TOUCH_TARGET,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.background,
    },
    searchInput: { flex: 1, ...typography.body, color: colors.text, paddingVertical: spacing.sm },
    clear: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    list: { flex: 1 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: TOUCH_TARGET + 4,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderRadius: radii.md,
    },
    rowSelected: { backgroundColor: colors.accentSoft },
    pressed: { backgroundColor: colors.surfaceMuted },
    rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    rowName: { ...typography.body, color: colors.text, flex: 1 },
    rowNameSelected: { fontWeight: '700' },
    empty: { paddingVertical: spacing.xl, gap: spacing.xs, alignItems: 'center' },
    emptyTitle: { ...typography.bodyStrong, color: colors.text, textAlign: 'center' },
    emptyBody: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
    footer: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    createBody: { flex: 1, gap: spacing.sm },
    label: { ...typography.label, color: colors.textMuted },
    nameInput: {
      minHeight: TOUCH_TARGET + 4,
      borderWidth: 1,
      borderColor: colors.outline,
      borderRadius: radii.md,
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.background,
      ...typography.body,
      fontSize: 17,
      color: colors.text,
    },
    nameInputError: { borderColor: colors.danger, borderWidth: 2 },
    counter: { ...typography.caption, color: colors.textMuted, alignSelf: 'flex-end' },
    problem: { gap: spacing.sm },
    problemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    problemText: { ...typography.label, color: colors.danger, flexShrink: 1 },
  });
}
