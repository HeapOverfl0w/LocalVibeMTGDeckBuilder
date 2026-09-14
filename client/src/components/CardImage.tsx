import { useEffect, useState } from 'react';
import ManaCost from './ManaCost';

type Status = 'loading' | 'loaded' | 'error';

interface CardImageProps {
  url?: string | null;
  alt: string;
  /** When provided, rendered as mana circles under the name in the error placeholder. */
  manaCost?: string;
}

/**
 * Renders a card image with a loading spinner until the image (or its URL)
 * is ready, and a placeholder if the image fails to load. The placeholder
 * keeps the card name (and mana cost, when known) visible so a broken image
 * never hides what the card is.
 */
export default function CardImage({ url, alt, manaCost }: CardImageProps) {
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    if (!url) {
      setStatus('loading');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    // Preload the image so we know exactly when it is ready to display.
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setStatus('loaded');
    };
    img.onerror = () => {
      if (!cancelled) setStatus('error');
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (status === 'error') {
    return (
      <div className="card-image-placeholder card-image-error" role="img" aria-label={alt}>
        {/* Name + mana cost stay visible at the top so a broken image never hides what the card is. */}
        <span className="card-image-error-name">{alt}</span>
        {manaCost ? (
          <span className="card-image-error-cost">
            <ManaCost cost={manaCost} />
          </span>
        ) : null}
        <div className="card-image-error-body">
          <span className="card-image-error-icon">⚠️</span>
          <span>No image</span>
        </div>
      </div>
    );
  }

  if (status === 'loading' || !url) {
    return (
      <div className="card-image-placeholder" role="img" aria-label={`Loading ${alt}`}>
        <span className="spinner" />
      </div>
    );
  }

  return <img src={url} alt={alt} />;
}
