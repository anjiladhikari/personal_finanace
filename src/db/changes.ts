/** Minimal in-process notification so screens re-read settings after setup. */

type Listener = () => void;

const settingsListeners = new Set<Listener>();

export function onSettingsChanged(listener: Listener): () => void {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

export function notifySettingsChanged(): void {
  for (const listener of [...settingsListeners]) listener();
}
