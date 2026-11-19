import { useRef, useState } from 'react';
import { useBackend } from '@/extension/backend';
import { SessionFileError } from '@/portable/session';
import { importSessionFile, removeSessionFile, usePortableSession } from '@/portable/useSession';
import { settingsUi } from './settingsStyles';

/** "Exported 3 Nov", for the row's state: the file's age is the useful fact about it, not its name. */
function importedOn(exportedAt: number): string {
  const date = new Date(exportedAt);
  return `Exported ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/**
 * The session file row (Settings › YouTube Music): how a phone gets an
 * account at all. The extension can't be installed there, so the desktop
 * exports its YouTube session to a file (the extension's popup, "Use on a
 * phone"), and this imports it. The file is a credential: it's kept in
 * IndexedDB only and can be forgotten here.
 *
 * The desktop with the extension never needs this, so the row only appears
 * where the file is the backend (the relay) or nowhere yet.
 */export function PortableSessionIntegration() {
  const backend = useBackend();
  const status = usePortableSession();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (backend.kind === 'extension') return null;

  const pick = () => {
    setProblem(null);
    input.current?.click();
  };
  const chosen = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await importSessionFile(file);
      setProblem(null);
    } catch (error) {
      // A refused file explains itself; anything else is unexpected.
      setProblem(error instanceof SessionFileError ? error.message : 'Couldn’t read that file.');
    } finally {
      setBusy(false);
      // Choosing the same file again must still fire a change.
      if (input.current) input.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await removeSessionFile();
      setProblem(null);
    } finally {
      setBusy(false);
    }
  };

  const text =
    status.state === 'checking'
      ? 'Checking…'
      : status.state === 'present'
        ? importedOn(status.exportedAt)
        : 'No session yet';

  return (
    <>
      {/* Two rows on a phone: the label, then the state and its buttons, so nothing wraps mid-word. */}
      <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-[11px] type-title-3 max-md:pb-3">
        <span className="min-w-0">Session File</span>
        <span className="inline-flex items-center gap-1.5 justify-self-end text-right type-body-reduced text-secondary max-md:col-span-2 max-md:mt-1.5 max-md:w-full max-md:justify-start">
          <span className="min-w-0 truncate">{text}</span>
          <span className="ms-auto flex flex-none items-center gap-1.5 max-md:ms-0">
            <button className={settingsUi.inlineButton} onClick={pick} disabled={busy}>
              {status.state === 'present' ? 'Replace' : 'Import'}
            </button>
            {status.state === 'present' && (
              <button className={settingsUi.inlineButton} onClick={() => void remove()} disabled={busy}>
                Remove
              </button>
            )}
          </span>
        </span>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Session file"
        onChange={(event) => void chosen(event.currentTarget.files?.[0])}
      />
      {problem && <p className={settingsUi.rowProblem}>{problem}</p>}
      <p className={settingsUi.footer}>
        {status.state === 'present'
          ? 'The file holds your YouTube cookies, kept in this browser only. Remove it to forget it, or sign out of YouTube on your computer to make it useless.'
          : 'On a computer, open the BitChord extension and choose “Use on a phone” to export a session file. Import it here to use your account’s library, playlists and likes. Without one, browsing works but stays signed out.'}
      </p>
    </>
  );
}
