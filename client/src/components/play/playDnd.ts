// ---------------------------------------------------------------------------
// Shared HTML5 drag & drop payload helpers (Phase 7, Step 7.3).
//
// Every draggable card (own hand / own table / own graveyard rows) writes the
// same JSON shape to `text/plain` on dragstart; every drop target parses it
// back. Kept in one module so sources and targets can't drift apart.
// ---------------------------------------------------------------------------

import type { DragEvent } from 'react';
import type { MoveFromZone } from '../../types';

export interface PlayDragPayload {
  instanceId: string;
  from: MoveFromZone;
}

const MIME = 'text/plain';

/**
 * The payload of the drag currently in flight, or null. `dataTransfer.getData`
 * is only readable on drop (not during dragover), so drop zones that need to
 * react live — e.g. showing a placement ghost — read this instead.
 */
let activePayload: PlayDragPayload | null = null;

/** Write the drag payload (call from onDragStart). */
export function setDragPayload(e: DragEvent, instanceId: string, from: MoveFromZone): void {
  e.dataTransfer.setData(MIME, JSON.stringify({ instanceId, from }));
  e.dataTransfer.effectAllowed = 'move';
  activePayload = { instanceId, from };
}

/** The in-flight drag payload (call during dragover). Null when no card drag is active. */
export function getActiveDrag(): PlayDragPayload | null {
  return activePayload;
}

/** Clear the in-flight payload (call from onDragEnd / after a drop). */
export function clearActiveDrag(): void {
  activePayload = null;
}

/** Parse + validate a drag payload (call from onDrop). Null if absent/invalid. */
export function getDragPayload(e: DragEvent): PlayDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlayDragPayload>;
    if (typeof parsed.instanceId !== 'string' || typeof parsed.from !== 'string') return null;
    if (parsed.from !== 'hand' && parsed.from !== 'table' && parsed.from !== 'graveyard') return null;
    return { instanceId: parsed.instanceId, from: parsed.from };
  } catch {
    return null;
  } finally {
    clearActiveDrag();
  }
}
