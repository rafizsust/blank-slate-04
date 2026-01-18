export function roundIELTSOverallBand(rawAverage: number): number {
  // IELTS rounding convention:
  // - Round to nearest 0.5.
  // - If average ends in .25, round up to .5.
  // - If average ends in .75, round up to next whole band.
  if (!Number.isFinite(rawAverage)) return 0;

  const avg = Math.max(0, Math.min(9, rawAverage));
  const floor = Math.floor(avg);
  const fraction = avg - floor;

  if (fraction < 0.25) return floor;
  if (fraction < 0.75) return floor + 0.5;
  return floor + 1;
}

export function computeSpeakingOverallBandFromCriteria(criteria: {
  fluency: number;
  lexical: number;
  grammar: number;
  pronunciation: number;
}): number {
  const scores = [criteria.fluency, criteria.lexical, criteria.grammar, criteria.pronunciation]
    .map((n) => (Number.isFinite(n) ? n : 0));
  const avg = scores.reduce((a, b) => a + b, 0) / 4;
  return roundIELTSOverallBand(avg);
}
