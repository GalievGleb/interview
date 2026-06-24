export interface AnswerSections {
  main: string;
  keyPoints: string[];
  example: string | null;
  avoid: string | null;
}

const SECTION_RE =
  /^(?:\*\*)?(?:key points?|ключев(?:ые|ая)|основн(?:ые|ая)|example|пример|на практике|avoid(?: saying)?|не говорите|избегайте)(?:\*\*)?\s*:?\s*$/iu;

function isBulletLine(line: string): boolean {
  return /^[*\-•]\s+/.test(line.trim());
}

function stripBullet(line: string): string {
  return line.replace(/^[*\-•]\s+/, '').trim();
}

/** UI-only heuristic split of plain LLM text into interview-friendly blocks. */
export function parseAnswerSections(text: string): AnswerSections {
  const raw = text.trim();
  if (!raw) {
    return { main: '', keyPoints: [], example: null, avoid: null };
  }

  const lines = raw.split('\n');
  let current: 'main' | 'keyPoints' | 'example' | 'avoid' = 'main';
  const buckets: Record<'main' | 'keyPoints' | 'example' | 'avoid', string[]> = {
    main: [],
    keyPoints: [],
    example: [],
    avoid: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (SECTION_RE.test(trimmed)) {
      const lower = trimmed.toLowerCase();
      if (/key|ключ|основн/.test(lower)) current = 'keyPoints';
      else if (/example|пример|практик/.test(lower)) current = 'example';
      else if (/avoid|не говор|избег/.test(lower)) current = 'avoid';
      continue;
    }

    if (current === 'main' && isBulletLine(trimmed) && buckets.main.length > 0) {
      current = 'keyPoints';
    }

    if (current === 'keyPoints' && isBulletLine(trimmed)) {
      buckets.keyPoints.push(stripBullet(trimmed));
    } else if (current === 'example') {
      buckets.example.push(trimmed);
    } else if (current === 'avoid') {
      buckets.avoid.push(trimmed);
    } else if (current === 'main') {
      buckets.main.push(trimmed);
    } else if (isBulletLine(trimmed)) {
      buckets.keyPoints.push(stripBullet(trimmed));
    } else {
      buckets[current].push(trimmed);
    }
  }

  const bulletBlocks = raw.match(/(?:^|\n)([*\-•]\s+.+(?:\n[*\-•]\s+.+)*)/g);
  if (buckets.keyPoints.length === 0 && buckets.main.length > 0 && bulletBlocks) {
    const firstBlock = bulletBlocks[0];
    if (firstBlock && buckets.main.join('\n').length > 80) {
      const bullets = firstBlock
        .split('\n')
        .map((l) => stripBullet(l.trim()))
        .filter(Boolean);
      if (bullets.length >= 2) {
        buckets.keyPoints = bullets;
      }
    }
  }

  return {
    main: buckets.main.join('\n\n').trim(),
    keyPoints: buckets.keyPoints,
    example: buckets.example.join('\n\n').trim() || null,
    avoid: buckets.avoid.join('\n\n').trim() || null,
  };
}
