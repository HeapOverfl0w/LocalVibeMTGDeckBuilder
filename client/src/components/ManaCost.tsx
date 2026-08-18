interface ManaSymbol {
  type: 'text' | 'circle';
  value: string;
  hybrid: boolean;
  colors: string[];
}

// Maps the single-letter color codes to a display color.
const COLOR_MAP: Record<string, string> = {
  W: '#ffffff',
  U: '#3b6fd4',
  B: '#4a4a4a',
  R: '#d43b3b',
  G: '#3b9e3b',
  C: '#9a9a9a',
};

function parseManaCost(cost: string): ManaSymbol[] {
  const symbols: ManaSymbol[] = [];
  const regex = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cost)) !== null) {
    const inner = match[1];
    if (inner.includes('/P')) {
      // Phyrexian hybrid mana, e.g. {R/P} -> colored circle with a black dot in the middle.
      const color = inner.split('/')[0];
      symbols.push({ type: 'circle', value: color, hybrid: true, colors: [color] });
    } else if (/^[WUBRGC]$/.test(inner)) {
      symbols.push({ type: 'circle', value: inner, hybrid: false, colors: [inner] });
    } else if (/^[WUBRG]\/[WUBRG]$/.test(inner)) {
      // Two-color hybrid mana, e.g. {G/U} -> circle split between the two colors.
      const [a, b] = inner.split('/');
      symbols.push({ type: 'circle', value: inner, hybrid: false, colors: [a, b] });
    } else {
      // Numbers, X, Y, or anything else -> plain text without the brackets.
      symbols.push({ type: 'text', value: inner, hybrid: false, colors: [] });
    }
  }
  return symbols;
}

export default function ManaCost({ cost }: { cost: string }) {
  const symbols = parseManaCost(cost);
  return (
    <span className="mana-cost" aria-label={cost}>
      {symbols.map((s, i) =>
        s.type === 'circle' ? (
          <span
            key={i}
            className={`mana-circle${s.hybrid ? ' mana-hybrid' : ''}`}
            style={{
              background:
                s.colors.length === 2
                  ? `linear-gradient(to right, ${COLOR_MAP[s.colors[0]] || '#8a8a8a'} 50%, ${COLOR_MAP[s.colors[1]] || '#8a8a8a'} 50%)`
                  : COLOR_MAP[s.colors[0]] || '#8a8a8a',
            }}
          />
        ) : (
          <span key={i} className="mana-text">
            {s.value}
          </span>
        ),
      )}
    </span>
  );
}
