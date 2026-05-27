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

const modes = [
  {
    name: "contextual",
    enabledCalibrationGroups: ["coast", "inland", "morning", "evening"]
  },
  {
    name: "marginal",
    enabledCalibrationGroups: []
  }
];

function run(strategyName, rounds, seed, mode) {
  const core = new CalibrationGameCore({
    rng: seededRng(seed),
    enabledCalibrationGroups: mode.enabledCalibrationGroups
  });
  core.runStrategy(strategyName, rounds);
  return core.computeMetrics();
}

function percentile(values, level) {
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(level * sorted.length) - 1);
  return sorted[index];
}

function summarize(strategyName, rounds, mode) {
  const multicalibrationValues = [];
  const swapValues = [];
  const calibrationValues = [];

  for (let seed = 1; seed <= 60; seed += 1) {
    const metrics = run(strategyName, rounds, seed, mode);
    multicalibrationValues.push(metrics.multicalibrationError);
    swapValues.push(metrics.maxSwapRegret);
    calibrationValues.push(metrics.calibrationError);
  }

  return {
    mode: mode.name,
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
const summaryByKey = new Map();

for (const mode of modes) {
  for (const rounds of [10, 25, 50]) {
    for (const strategyName of strategies) {
      const summary = summarize(strategyName, rounds, mode);
      summaries.push(summary);
      summaryByKey.set(`${mode.name}:${strategyName}:${rounds}`, summary);

      const isReactive = strategyName === "reactive";
      const isContextual = mode.name === "contextual";
      const shortHorizonMcLimit = rounds === 10 ? (isContextual ? 0.4 : 0.52) : Infinity;
      const mediumMcLimit = rounds === 25 && !isReactive ? (isContextual ? 0.21 : 0.5) : Infinity;
      const mediumReactiveMcLimit = rounds === 25 && isReactive ? (isContextual ? 0.39 : 0.42) : Infinity;
      const longMcLimit = rounds === 50 && !isReactive ? (isContextual ? 0.2 : 0.35) : Infinity;
      const longReactiveMcLimit = rounds === 50 && isReactive ? (isContextual ? 0.33 : 0.32) : Infinity;
      const mcLimit = Math.min(
        shortHorizonMcLimit,
        mediumMcLimit,
        mediumReactiveMcLimit,
        longMcLimit,
        longReactiveMcLimit
      );

      const shortHorizonRegretLimit = rounds === 10 ? (isContextual ? 0.36 : 0.53) : Infinity;
      const mediumRegretLimit = rounds === 25 && !isReactive ? (isContextual ? 0.18 : 0.42) : Infinity;
      const mediumReactiveRegretLimit = rounds === 25 && isReactive ? 0.32 : Infinity;
      const longRegretLimit = rounds === 50 && !isReactive ? (isContextual ? 0.12 : 0.38) : Infinity;
      const longReactiveRegretLimit = rounds === 50 && isReactive ? 0.24 : Infinity;
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
          `p90 multicalibration error ${summary.mcP90.toFixed(3)} exceeds ${mcLimit.toFixed(3)} for ${mode.name} ${strategyName} at ${rounds} rounds`
        );
      }

      if (summary.swapP90 > regretLimit) {
        failed = true;
        console.error(
          `p90 swap regret ${summary.swapP90.toFixed(3)} exceeds ${regretLimit.toFixed(3)} for ${mode.name} ${strategyName} at ${rounds} rounds`
        );
      }

    }
  }
}

for (const strategyName of ["red-blue", "early-late"]) {
  const contextual = summaryByKey.get(`contextual:${strategyName}:50`);
  const marginal = summaryByKey.get(`marginal:${strategyName}:50`);
  if (contextual && marginal && contextual.swapP90 >= marginal.swapP90) {
    failed = true;
    console.error(
      `context groups should reduce 50-round swap regret for ${strategyName}; contextual ${contextual.swapP90.toFixed(3)}, marginal ${marginal.swapP90.toFixed(3)}`
    );
  }
}

console.table(summaries.map((summary) => ({
  mode: summary.mode,
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
