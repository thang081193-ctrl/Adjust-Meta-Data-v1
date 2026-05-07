// src/decision-engine.js
// Multi-window ROAS classification.
// Core principle: never pause/scale based on a single window.
// Pause requires BOTH 3d AND 7d to be bad (so a single bad day doesn't kill a campaign).
// Scale requires 3d AND 7d AND all-time to be sustained (so a spike doesn't bait us).

export const DEFAULT_THRESHOLDS = {
  // Pause: both windows must be below their respective bars.
  pause3d: 0.20,        // 3d ROAS < 20%
  pause7d: 0.30,        // AND 7d ROAS < 30%

  // Scale: all three windows must be above their respective bars.
  scale3d: 1.00,        // 3d ROAS > 100%
  scale7d: 0.80,        // AND 7d ROAS > 80%
  scaleAllTime: 0.60,   // AND all-time ROAS > 60%

  // Noise detector: |D0 - 7d| / 7d > this -> flag as noisy day, do not action.
  noiseDeviation: 1.5,
};

/**
 * Classify a campaign into one of: 'pause', 'scale', 'noisy', 'hold'.
 * Returns reason codes so the UI can explain WHY (transparency for human review).
 *
 * @param {object} roas - { d0, d3, d7, allTime } as decimals (0.20 = 20%)
 * @param {object} [thresholds] - override defaults
 */
export function classify(roas, thresholds = DEFAULT_THRESHOLDS) {
  const { d0, d3, d7, allTime } = roas;

  // Guard: incomplete data should NEVER produce an action recommendation.
  if (d3 == null || d7 == null || allTime == null) {
    return { decision: 'hold', reason: 'incomplete_data', confidence: 0 };
  }

  // Check pause first.
  if (d3 < thresholds.pause3d && d7 < thresholds.pause7d) {
    return {
      decision: 'pause',
      reason: 'sustained_underperformance',
      confidence: scoreConfidence(d3, d7, thresholds.pause3d, thresholds.pause7d),
      details: `3d=${pct(d3)} < ${pct(thresholds.pause3d)} AND 7d=${pct(d7)} < ${pct(thresholds.pause7d)}`,
    };
  }

  // Check scale.
  if (
    d3 > thresholds.scale3d &&
    d7 > thresholds.scale7d &&
    allTime > thresholds.scaleAllTime
  ) {
    return {
      decision: 'scale',
      reason: 'sustained_outperformance',
      confidence: scoreConfidence(d3, d7, thresholds.scale3d, thresholds.scale7d),
      details: `3d=${pct(d3)} > ${pct(thresholds.scale3d)}, 7d=${pct(d7)} > ${pct(thresholds.scale7d)}, all=${pct(allTime)} > ${pct(thresholds.scaleAllTime)}`,
    };
  }

  // Detect noisy day - useful UX flag.
  if (d0 != null && d7 > 0) {
    const deviation = Math.abs(d0 - d7) / d7;
    if (deviation > thresholds.noiseDeviation) {
      return {
        decision: 'noisy',
        reason: 'today_deviates_from_baseline',
        confidence: 0.5,
        details: `D0=${pct(d0)} deviates ${(deviation * 100).toFixed(0)}% from 7d=${pct(d7)}`,
      };
    }
  }

  return { decision: 'hold', reason: 'no_signal', confidence: 0 };
}

function scoreConfidence(a, b, threshA, threshB) {
  // How far past the threshold are we, in both windows. Naive geometric mean.
  const distA = Math.abs(a - threshA) / Math.max(threshA, 0.01);
  const distB = Math.abs(b - threshB) / Math.max(threshB, 0.01);
  return Math.min(1, Math.sqrt(distA * distB));
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

/**
 * Batch-classify a list of campaigns. Returns groups for UI panel.
 */
export function classifyAll(campaigns, thresholds) {
  const groups = { pause: [], scale: [], noisy: [], hold: [] };
  for (const c of campaigns) {
    const result = classify(c.roas, thresholds);
    groups[result.decision].push({ ...c, classification: result });
  }
  return groups;
}
