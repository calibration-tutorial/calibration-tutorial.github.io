const { CalibrationGameCore } = require("./calibration-game.js");

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1103515245 * state + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const strategies = [
  "always-zero",
  "always-one",
  "red-blue",
  "early-late",
  "alternating",
  "shift",
  "reactive"
];

function run(strategyName, rounds, seed) {
  const core = new CalibrationGameCore({ rng: seededRng(seed) });
  core.runStrategy(strategyName, rounds);
  return core.computeMetrics().multicalibrationError;
}

function percentile(values, level) {
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(level * sorted.length) - 1);
  return sorted[index];
}

function summarize(strategyName, rounds) {
  const values = [];
  for (let seed = 1; seed <= 60; seed += 1) {
    values.push(run(strategyName, rounds, seed));
  }
  return {
    strategy: strategyName,
    rounds,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: Math.max(...values)
  };
}

const summaries = [];
let failed = false;

for (const rounds of [10, 25, 50]) {
  for (const strategyName of strategies) {
    const summary = summarize(strategyName, rounds);
    summaries.push(summary);

    const isReactive = strategyName === "reactive";
    const shortHorizonLimit = rounds === 10 ? 0.42 : Infinity;
    const mediumLimit = rounds === 25 && !isReactive ? 0.28 : Infinity;
    const mediumReactiveLimit = rounds === 25 && isReactive ? 0.42 : Infinity;
    const longLimit = rounds === 50 && !isReactive ? 0.24 : Infinity;
    const longReactiveLimit = rounds === 50 && isReactive ? 0.34 : Infinity;
    const limit = Math.min(shortHorizonLimit, mediumLimit, mediumReactiveLimit, longLimit, longReactiveLimit);

    if (summary.p90 > limit) {
      failed = true;
      console.error(
        `p90 multicalibration error ${summary.p90.toFixed(3)} exceeds ${limit.toFixed(3)} for ${strategyName} at ${rounds} rounds`
      );
    }
  }
}

console.table(summaries.map((summary) => ({
  strategy: summary.strategy,
  rounds: summary.rounds,
  median: summary.median.toFixed(3),
  p90: summary.p90.toFixed(3),
  max: summary.max.toFixed(3)
})));

if (failed) {
  process.exitCode = 1;
}
