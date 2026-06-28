interface Props {
  score: number; // 0..100
  label?: string;
  size?: number;
  tone?: 'green' | 'blue' | 'amber' | 'red';
}

const TONE_HEX: Record<NonNullable<Props['tone']>, string> = {
  green: '#16a34a',
  blue: '#2563eb',
  amber: '#d97706',
  red: '#dc2626',
};

/** Circular readiness gauge for the Preparation dashboard. */
export default function ReadinessRing({ score, label, size = 132, tone = 'green' }: Props) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  const color = TONE_HEX[tone];

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#efeae2" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
        />
      </svg>
      <div className="absolute flex flex-col items-center leading-none">
        <span className="text-[28px] font-bold" style={{ color: 'var(--prep-ink)' }}>
          {clamped}
          <span className="text-[15px] font-semibold" style={{ color: 'var(--prep-ink-faint)' }}>
            %
          </span>
        </span>
        {label && (
          <span className="mt-1 text-[12px] font-semibold" style={{ color }}>
            {label}
          </span>
        )}
      </div>
    </div>
  );
}
