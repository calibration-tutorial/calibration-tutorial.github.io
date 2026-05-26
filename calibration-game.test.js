const { CalibrationGameCore, strategies: gameStrategies } = require("./calibration-game.js");

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
  return core.computeMetrics();
}

function percentile(values, level) {
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(level * sorted.length) - 1);
  return sorted[index];
}

function summarize(strategyName, rounds) {
  const multicalibrationValues = [];
  const swapValues = [];
  const decisionValues = [];

  for (let seed = 1; seed <= 60; seed += 1) {
    const metrics = run(strategyName, rounds, seed);
    multicalibrationValues.push(metrics.multicalibrationError);
    swapValues.push(metrics.maxSwapRegret);
    decisionValues.push(metrics.maxDecisionRegret);
  }

  return {
    strategy: gameStrategies[strategyName].label,
    rounds,
    mcMedian: percentile(multicalibrationValues, 0.5),
    mcP90: percentile(multicalibrationValues, 0.9),
    mcMax: Math.max(...multicalibrationValues),
    swapP90: percentile(swapValues, 0.9),
    decisionP90: percentile(decisionValues, 0.9)
  };
}

const summaries = [];
let failed = false;

for (const rounds of [10, 25, 50]) {
  for (const strategyName of strategies) {
    const summary = summarize(strategyName, rounds);
    summaries.push(summary);

    const isReactive = strategyName === "reactive";
    const shortHorizonMcLimit = rounds === 10 ? 0.32 : Infinity;
    const mediumMcLimit = rounds === 25 && !isReactive ? 0.18 : Infinity;
    const mediumReactiveMcLimit = rounds === 25 && isReactive ? 0.24 : Infinity;
    const longMcLimit = rounds === 50 && !isReactive ? 0.15 : Infinity;
    const longReactiveMcLimit = rounds === 50 && isReactive ? 0.18 : Infinity;
    const mcLimit = Math.min(
      shortHorizonMcLimit,
      mediumMcLimit,
      mediumReactiveMcLimit,
      longMcLimit,
      longReactiveMcLimit
    );

    const shortHorizonRegretLimit = rounds === 10 ? 0.35 : Infinity;
    const mediumRegretLimit = rounds === 25 && !isReactive ? 0.18 : Infinity;
    const mediumReactiveRegretLimit = rounds === 25 && isReactive ? 0.32 : Infinity;
    const longRegretLimit = rounds === 50 && !isReactive ? 0.12 : Infinity;
    const longReactiveRegretLimit = rounds === 50 && isReactive ? 0.22 : Infinity;
    const regretLimit = Math.min(
      shortHorizonRegretLimit,
      mediumRegretLimit,
      mediumReactiveRegretLimit,
      longRegretLimit,
      longReactiveRegretLimit
    );

    if (summary.mcP90 > mcLimit) {
      failed = true;
      console.error(
        `p90 multicalibration error ${summary.mcP90.toFixed(3)} exceeds ${mcLimit.toFixed(3)} for ${strategyName} at ${rounds} rounds`
      );
    }

    if (summary.swapP90 > regretLimit) {
      failed = true;
      console.error(
        `p90 swap regret ${summary.swapP90.toFixed(3)} exceeds ${regretLimit.toFixed(3)} for ${strategyName} at ${rounds} rounds`
      );
    }

    if (summary.decisionP90 > regretLimit) {
      failed = true;
      console.error(
        `p90 decision regret ${summary.decisionP90.toFixed(3)} exceeds ${regretLimit.toFixed(3)} for ${strategyName} at ${rounds} rounds`
      );
    }
  }
}

console.table(summaries.map((summary) => ({
  strategy: summary.strategy,
  rounds: summary.rounds,
  mcMedian: summary.mcMedian.toFixed(3),
  mcP90: summary.mcP90.toFixed(3),
  swapP90: summary.swapP90.toFixed(3),
  decisionP90: summary.decisionP90.toFixed(3),
  mcMax: summary.mcMax.toFixed(3)
})));

if (failed) {
  process.exitCode = 1;
}
