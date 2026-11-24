/** Minimal in-process notifications so screens re-read local data. */

type Listener = () => void;

function channel() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify(): void {
      for (const listener of [...listeners]) listener();
    },
  };
}

const settings = channel();
const submissions = channel();
const categories = channel();

export const onSettingsChanged = settings.subscribe;
export const notifySettingsChanged = settings.notify;

/** Pending/confirmed submissions changed (saved, sent, confirmed, failed). */
export const onSubmissionsChanged = submissions.subscribe;
export const notifySubmissionsChanged = submissions.notify;

/** Custom categories changed (created here, restored or backed up). */
export const onCategoriesChanged = categories.subscribe;
export const notifyCategoriesChanged = categories.notify;
