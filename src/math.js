/** Small, dependency-free calculations shared by the fixtures and product. */
export function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stringSeed(text) {
  let value = 2166136261;
  for (const character of String(text)) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

export function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

const logFactorials = [0];
function logFactorial(n) {
  for (let i = logFactorials.length; i <= n; i++) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  return logFactorials[n];
}
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

export function selectionDistribution(total, own, selected) {
  if (![total, own, selected].every(Number.isInteger) || total < 0 || own < 0 || own > total || selected < 0 || selected > total) {
    throw new RangeError('Require integer counts with 0 ≤ own ≤ total and 0 ≤ selected ≤ total.');
  }
  if (total === 0) return [1];
  const probabilities = Array(selected + 1).fill(0);
  const lower = Math.max(0, selected - (total - own));
  const upper = Math.min(own, selected);
  const denominator = logChoose(total, selected);
  for (let x = lower; x <= upper; x++) probabilities[x] = Math.exp(logChoose(own, x) + logChoose(total - own, selected - x) - denominator);
  const sum = probabilities.reduce((a, b) => a + b, 0);
  return probabilities.map(p => p / sum);
}

export function selectionTail(other, own, cap, minimum = 1) {
  if (![other, own, cap, minimum].every(Number.isInteger) || other < 0 || own < 0 || cap < 1 || minimum < 1) {
    throw new RangeError('Use nonnegative integer Supplier counts and positive integer cap and threshold.');
  }
  const total = other + own;
  const selected = Math.min(cap, total);
  if (own < minimum || selected < minimum) return 0;
  if (Math.max(0, selected - other) >= minimum) return 1;
  // A short complement product is stable even for very large scenario counts.
  let zero = 1;
  if (other >= selected) {
    for (let i = 0; i < selected; i++) zero *= (other - i) / (total - i);
  } else zero = 0;
  // Only the support check above establishes certainty. A rounded complement
  // must not turn a very high finite chance into a guaranteed 100%.
  if (minimum === 1) return Math.max(0, Math.min(1-Number.EPSILON, 1 - zero));
  const distribution = selectionDistribution(total, own, selected);
  return Math.max(0, Math.min(1-Number.EPSILON, distribution.slice(minimum).reduce((a, b) => a + b, 0)));
}

export function exposureScenario(reference, own, minimum = 1) {
  const count = Math.max(0, Math.min(100000, Math.round(Number(own) || 0)));
  const other = reference.totalEligible - reference.ownEligible;
  const total = other + count;
  const selected = Math.min(reference.selectionCap, total);
  return {
    ownEligible: count,
    otherEligible: other,
    totalEligible: total,
    selected,
    minimum,
    selectionChance: selectionTail(other, count, reference.selectionCap, minimum),
    expectedPositions: total ? selected * count / total : 0
  };
}

export function countForTarget(reference, target, minimum = 1) {
  if(!Number.isFinite(target)||target<=0||target>1||!Number.isInteger(minimum)||minimum<1)throw new RangeError('Use a target greater than 0 and at most 1, and a positive integer selection minimum.');
  if (minimum > reference.selectionCap) return null;
  const other = reference.totalEligible - reference.ownEligible;
  if(target===1)return other+minimum<=reference.selectionCap?minimum:null;
  let high = Math.max(1, reference.ownEligible);
  while (selectionTail(other, high, reference.selectionCap, minimum) < target && high < 100000) high *= 2;
  high = Math.min(100000, high);
  if (selectionTail(other, high, reference.selectionCap, minimum) < target) return null;
  let low = 0;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (selectionTail(other, mid, reference.selectionCap, minimum) >= target) high = mid;
    else low = mid + 1;
  }
  return low;
}

export function dayBootstrap(daily, seed, repetitions = 2000) {
  const random = seededRandom(seed);
  const actual = daily.reduce((sum, d) => sum + d.actual, 0);
  const reference = daily.reduce((sum, d) => sum + d.reference, 0);
  const draws = [];
  if (daily.length < 2 || reference <= 0) return {point: reference > 0 ? actual / reference : null, interval: null, definedDraws: 0, repetitions};
  for (let repetition = 0; repetition < repetitions; repetition++) {
    let a = 0, b = 0;
    for (let i = 0; i < daily.length; i++) {
      const day = daily[Math.floor(random() * daily.length)];
      a += day.actual;
      b += day.reference;
    }
    if (b > 0) draws.push(a / b);
  }
  const low = quantile(draws, .025), high = quantile(draws, .975);
  // Identical paired ratios produce a valid collapsed empirical interval. It
  // describes these observations; it does not certify future certainty.
  const stable = low !== null && high !== null && Number.isFinite(low) && Number.isFinite(high) && draws.length >= repetitions * .95;
  return {point: actual / reference, interval: stable ? [low, high] : null, definedDraws: draws.length, repetitions};
}
