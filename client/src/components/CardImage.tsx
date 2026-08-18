import { useEffect, useState } from 'react';

type Status = 'loading' | 'loaded' | 'error';

interface CardImageProps {
  url?: string | null;
  alt: string;
}

/**
 * Renders a card image with a loading spinner until the image (or its URL)
 * is ready, and a placeholder if the image fails to load.
 */
export default function CardImage({ url, alt }: CardImageProps) {
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
        <span className="card-image-error-icon">⚠️</span>
        <span>No image</span>
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
