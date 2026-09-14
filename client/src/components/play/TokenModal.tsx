// ---------------------------------------------------------------------------
// TokenModal (Phase 10, Step 10.8) — create a token on your table. Three text
// boxes: Name (required), Power and Toughness (optional — some tokens have no
// P/T, but if one is given both are). OK creates the token (rendered without
// an image — name on top, "X/Y" power/toughness at the bottom when present);
// Cancel / backdrop click / Escape close without creating.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

interface TokenModalProps {
  onCreate: (name: string, power: string, toughness: string) => void;
  onClose: () => void;
}

export default function TokenModal({ onCreate, onClose }: TokenModalProps) {
  const [name, setName] = useState('');
  const [power, setPower] = useState('');
  const [toughness, setToughness] = useState('');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const trimmedPower = power.trim();
  const trimmedToughness = toughness.trim();
  // Name required; P/T optional but must be set together.
  const valid = name.trim() !== '' && (trimmedPower === '') === (trimmedToughness === '');

  function submit(): void {
    if (!valid) return;
    onCreate(name.trim(), trimmedPower, trimmedToughness);
  }

  return (
    <div className="token-modal-backdrop" onClick={onClose} role="dialog" aria-label="Add a token">
      <div className="token-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="token-modal-title">New Token</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="token-field">
            <span className="token-field-label">Name</span>
            <input
              className="token-input"
              type="text"
              value={name}
              maxLength={60}
              placeholder="e.g. Doomed Soldier"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="token-pt-row">
            <label className="token-field">
              <span className="token-field-label">Power</span>
              <input
                className="token-input"
                type="text"
                value={power}
                maxLength={10}
                placeholder="e.g. 2"
                onChange={(e) => setPower(e.target.value)}
              />
            </label>
            <label className="token-field">
              <span className="token-field-label">Toughness</span>
              <input
                className="token-input"
                type="text"
                value={toughness}
                maxLength={10}
                placeholder="e.g. 2"
                onChange={(e) => setToughness(e.target.value)}
              />
            </label>
          </div>
          <p className="token-hint">Leave power and toughness blank for tokens that have none.</p>
          <div className="token-modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!valid}>
              OK
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
