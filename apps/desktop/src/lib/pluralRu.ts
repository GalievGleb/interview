/**
 * Russian plural form picker: pluralRu(1, 'тема', 'темы', 'тем') → 'тема'.
 * Handles 11–14 ("11 тем"), 2–4 ("2 темы"), everything else ("5 тем").
 */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  if (abs >= 11 && abs <= 14) return many;
  switch (abs % 10) {
    case 1:
      return one;
    case 2:
    case 3:
    case 4:
      return few;
    default:
      return many;
  }
}
