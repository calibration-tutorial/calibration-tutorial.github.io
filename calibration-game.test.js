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
  "care-setting",
  "vital-status",
  "alternating",
  "shift",
  "reactive",
  "contrarian"
];

function run(strategyName, rounds, seed) {
  const core = new CalibrationGameCore({
    rng: seededRng(seed)
  });
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
  const calibrationValues = [];

  for (let seed = 1; seed <= 60; seed += 1) {
    const metrics = run(strategyName, rounds, seed);
    multicalibrationValues.push(metrics.multicalibrationError);
    swapValues.push(metrics.maxSwapRegret);
    calibrationValues.push(metrics.calibrationError);
  }

  return {
    strategy: gameStrategies[strategyName].label,
    strategyName,
    rounds,
    mcMedian: percentile(multicalibrationValues, 0.5),
    mcP90: percentile(multicalibrationValues, 0.9),
    mcMax: Math.max(...multicalibrationValues),
    calP90: percentile(calibrationValues, 0.9),
    swapP90: percentile(swapValues, 0.9)
  };
}

const summaries = [];
let failed = false;

for (const rounds of [10, 25, 50]) {
  for (const strategyName of strategies) {
    const summary = summarize(strategyName, rounds);
    summaries.push(summary);

    const isReactive = strategyName === "reactive";
    const isContrarian = strategyName === "contrarian";
    const shortHorizonMcLimit = rounds === 10 && !isContrarian ? 0.48 : Infinity;
    const shortHorizonContrarianMcLimit = rounds === 10 && isContrarian ? 0.62 : Infinity;
    const mediumMcLimit = rounds === 25 && !isReactive && !isContrarian ? 0.255 : Infinity;
    const mediumReactiveMcLimit = rounds === 25 && isReactive ? 0.39 : Infinity;
    const mediumContrarianMcLimit = rounds === 25 && isContrarian ? 0.47 : Infinity;
    const longMcLimit = rounds === 50 && !isReactive && !isContrarian ? 0.305 : Infinity;
    const longReactiveMcLimit = rounds === 50 && isReactive ? 0.34 : Infinity;
    const longContrarianMcLimit = rounds === 50 && isContrarian ? 0.42 : Infinity;
    const mcLimit = Math.min(
      shortHorizonMcLimit,
      shortHorizonContrarianMcLimit,
      mediumMcLimit,
      mediumReactiveMcLimit,
      mediumContrarianMcLimit,
      longMcLimit,
      longReactiveMcLimit,
      longContrarianMcLimit
    );

    const shortHorizonRegretLimit = rounds === 10 && !isReactive && !isContrarian ? 0.43 : Infinity;
    const shortHorizonReactiveRegretLimit = rounds === 10 && isReactive ? 0.5 : Infinity;
    const shortHorizonContrarianRegretLimit = rounds === 10 && isContrarian ? 0.53 : Infinity;
    const mediumRegretLimit = rounds === 25 && !isReactive && !isContrarian ? 0.18 : Infinity;
    const mediumReactiveRegretLimit = rounds === 25 && isReactive ? 0.32 : Infinity;
    const mediumContrarianRegretLimit = rounds === 25 && isContrarian ? 0.43 : Infinity;
    const longRegretLimit = rounds === 50 && !isReactive && !isContrarian ? 0.12 : Infinity;
    const longReactiveRegretLimit = rounds === 50 && isReactive ? 0.24 : Infinity;
    const longContrarianRegretLimit = rounds === 50 && isContrarian ? 0.36 : Infinity;
    const regretLimit = Math.min(
      shortHorizonRegretLimit,
      shortHorizonReactiveRegretLimit,
      shortHorizonContrarianRegretLimit,
      mediumRegretLimit,
      mediumReactiveRegretLimit,
      mediumContrarianRegretLimit,
      longRegretLimit,
      longReactiveRegretLimit,
      longContrarianRegretLimit
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
  }
}

console.table(summaries.map((summary) => ({
  strategy: summary.strategy,
  rounds: summary.rounds,
  calP90: summary.calP90.toFixed(3),
  mcMedian: summary.mcMedian.toFixed(3),
  mcP90: summary.mcP90.toFixed(3),
  swapP90: summary.swapP90.toFixed(3),
  mcMax: summary.mcMax.toFixed(3)
})));

if (failed) {
  process.exitCode = 1;
}
