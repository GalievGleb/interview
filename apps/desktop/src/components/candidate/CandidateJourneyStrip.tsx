import { Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { CandidateJourneyStep } from '../../lib/candidateJourney';

interface Props {
  steps: CandidateJourneyStep[];
  ariaLabel: string;
  compact?: boolean;
}

export default function CandidateJourneyStrip({ steps, ariaLabel, compact = false }: Props) {
  const style = { '--journey-steps': steps.length } as CSSProperties;
  return (
    <ol className={`candidate-journey-strip ${compact ? 'is-compact' : ''}`} aria-label={ariaLabel} style={style}>
      {steps.map((step, index) => (
        <li className={`is-${step.status}`} key={step.id} aria-current={step.status === 'current' ? 'step' : undefined}>
          <span className="candidate-journey-strip__marker" aria-hidden="true">
            {step.status === 'done' ? <Check size={13} /> : index + 1}
          </span>
          <span className="candidate-journey-strip__copy">
            <strong>{step.label}</strong>
            {!compact && <small>{step.description}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}
