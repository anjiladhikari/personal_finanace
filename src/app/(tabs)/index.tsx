import { useMemo } from 'react';
import { View } from 'react-native';

import { dataScopeOf } from '@/db/appSettings';
import { useAppSettings } from '@/db/useAppSettings';
import { ExpenseForm } from '@/ui/ExpenseForm';
import { LoadingScreen } from '@/ui/LoadingScreen';
import { UnresolvedSubmissions } from '@/ui/UnresolvedSubmissions';

/**
 * Initial route. Renders from local data only; it must never wait for a
 * Google Sheets request.
 */
export default function AddExpenseScreen() {
  const settings = useAppSettings();
  const ready = settings.status === 'ready' ? settings.settings : null;
  const scope = useMemo(() => (ready === null ? null : dataScopeOf(ready)), [ready]);

  if (ready === null) return <LoadingScreen />;
  return (
    <View style={{ flex: 1 }} testID="add-expense-screen">
      <ExpenseForm currency={ready.currency} scope={scope} lastConfirmedSaveAt={ready.lastConfirmedSaveAt}>
        {scope === null ? null : <UnresolvedSubmissions scope={scope} currency={ready.currency} />}
      </ExpenseForm>
    </View>
  );
}
