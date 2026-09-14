// ---------------------------------------------------------------------------
// ImportDeckModal — import a deck from plain text. One card per line in the
// format "<count> <card name>" (e.g. "4 Twinflame"). The server resolves every
// name and is all-or-nothing: on success the full card list comes back and the
// modal closes; on failure the per-line errors are shown in the dialog and
// nothing is imported. Cancel / backdrop click / Escape close without importing.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DeckCard } from '../types';

interface ImportDeckModalProps {
  onImported: (cards: DeckCard[]) => void;
  onClose: () => void;
}

export default function ImportDeckModal({ onImported, onClose }: ImportDeckModalProps) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function submit(): Promise<void> {
    if (importing || text.trim() === '') return;
    setImporting(true);
    setErrors([]);
    try {
      const result = await api.importDeck(text);
      if (result.ok) {
        onImported(result.cards);
      } else {
        // Server found problems — show them and keep the dialog open.
        setErrors(
          result.errors.map((e) => (e.line > 0 ? `Line ${e.line}: ${e.message}` : e.message)),
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message !== 'Unauthorized') {
        setErrors([err.message]);
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="import-modal-backdrop" onClick={onClose} role="dialog" aria-label="Import deck">
      <div className="import-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="import-modal-title">Import Deck</h3>
        <p className="import-hint">
          One card per line: the count, a space, then the card name — e.g. <code>4 Twinflame</code>. Names match exactly or by prefix (
          <code>Twin</code> finds <code>Twinflame</code>); if a prefix matches several cards you'll be told to use a more specific name.
        </p>
        <textarea
          className="import-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setErrors([]);
          }}
          placeholder={'4 Twinflame\n1 Utopia Sprawl\n3 Forest'}
          autoFocus
        />
        {errors.length > 0 && (
          <div className="import-errors" role="alert">
            <div className="import-errors-title">Could not import — fix the problems below and try again:</div>
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="import-modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={importing || text.trim() === ''}>
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
