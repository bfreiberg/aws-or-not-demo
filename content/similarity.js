export function normalize(name) {
  return name.toLowerCase().trim().replace(/^(amazon|aws)\s+/, '').replace(/[^a-z0-9]/g, '');
}

export function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export function nameDistance(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return levenshtein(na, nb) / Math.max(na.length, nb.length, 1);
}

export function tooSimilar(name, others, threshold = 0.2) {
  return others.some((other) => nameDistance(name, other) <= threshold);
}
