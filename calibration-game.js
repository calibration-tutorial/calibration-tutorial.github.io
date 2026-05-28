(function (global) {
  "use strict";

  const CALIBRATION_GROUPS = [
    {
      id: "coast",
      label: "Coast days",
      applies: (context) => context.region === "coast"
    },
    {
      id: "inland",
      label: "Inland days",
      applies: (context) => context.region === "inland"
    },
    {
      id: "morning",
      label: "Morning rounds",
      applies: (context) => context.period === "morning"
    },
    {
      id: "evening",
      label: "Evening rounds",
      applies: (context) => context.period === "evening"
    }
  ];

  const DEFAULT_OPTIONS = {
    objective: "decision",
    eta: 10,
    slackFactor: 0.2,
    splitBase: 0.3,
    maxDepth: 4,
    startDepth: 2,
    eviTieSlack: 0.02,
    targetDecay: 0.92,
    rng: Math.random
  };

  const OBJECTIVE_DEFAULTS = {
    calibration: {
      eta: 2.5,
      eviTieSlack: 0.005
    },
    decision: {
      eta: 10,
      eviTieSlack: 0.02
    }
  };

  const DECISION_MAKERS = [
    {
      id: "general",
      label: "Everyday commuter",
      scope: "All rounds",
      cost: 0.5,
      applies: () => true
    },
    {
      id: "coast",
      label: "Coastal walker",
      scope: "Coast rounds",
      cost: 0.35,
      applies: (context) => context.region === "coast"
    },
    {
      id: "inland",
      label: "Inland minimalist",
      scope: "Inland rounds",
      cost: 0.65,
      applies: (context) => context.region === "inland"
    },
    {
      id: "morning",
      label: "Morning cyclist",
      scope: "Morning rounds",
      cost: 0.45,
      applies: (context) => context.period === "morning"
    },
    {
      id: "evening",
      label: "Evening hiker",
      scope: "Evening rounds",
      cost: 0.55,
      applies: (context) => context.period === "evening"
    }
  ];

  const STRATEGIES = {
    "always-zero": {
      label: "Always dry",
      outcome: () => 0
    },
    "always-one": {
      label: "Always rain",
      outcome: () => 1
    },
    "red-blue": {
      label: "Coast rain",
      outcome: (_history, context) => context.region === "coast" ? 1 : 0
    },
    "early-late": {
      label: "Morning rain",
      outcome: (_history, context) => context.period === "morning" ? 1 : 0
    },
    alternating: {
      label: "Alternating",
      outcome: (_history, _context, roundIndex) => roundIndex % 2 === 0 ? 1 : 0
    },
    shift: {
      label: "Storm at 25",
      outcome: (_history, _context, roundIndex) => roundIndex < 25 ? 0 : 1
    },
    reactive: {
      label: "React to last",
      outcome: (history) => {
        const last = history[history.length - 1];
        return last && last.prediction < 0.55 ? 1 : 0;
      }
    }
  };

  class Bin {
    constructor(lo, hi, depth) {
      this.lo = lo;
      this.hi = hi;
      this.depth = depth;
      this.mass = 0;
      this.id = `${depth}:${lo.toFixed(5)}-${hi.toFixed(5)}`;
    }

    get mid() {
      return (this.lo + this.hi) / 2;
    }

    get width() {
      return this.hi - this.lo;
    }
  }

  class CalibrationGameCore {
    constructor(options = {}) {
      const objective = options.objective || DEFAULT_OPTIONS.objective;
      this.options = {
        ...DEFAULT_OPTIONS,
        ...(OBJECTIVE_DEFAULTS[objective] || {}),
        ...options,
        objective
      };
      this.rng = this.options.rng;
      this.reset();
    }

    reset() {
      this.bins = this.initialBins();
      this.scores = new Map();
      this.groupTargets = new Map();
      this.history = [];
      this.metricHistory = [];

      this.pending = this.prepareRound();
      return this.getState();
    }

    initialBins() {
      if (this.options.objective === "decision") {
        return this.decisionPartitionBins();
      }

      const bins = [];
      const count = 2 ** this.options.startDepth;
      for (let index = 0; index < count; index += 1) {
        bins.push(new Bin(index / count, (index + 1) / count, this.options.startDepth));
      }

      return bins;
    }

    decisionPartitionBins() {
      const thresholds = Array.from(new Set(DECISION_MAKERS.map((maker) => maker.cost)))
        .sort((left, right) => left - right);
      const edges = [0, ...thresholds, 1];
      const bins = [];

      for (let index = 0; index < edges.length - 1; index += 1) {
        bins.push(new Bin(edges[index], edges[index + 1], 0));
      }

      return bins;
    }

    contextAt(roundIndex) {
      return {
        region: roundIndex % 2 === 0 ? "coast" : "inland",
        period: Math.floor(roundIndex / 5) % 2 === 0 ? "morning" : "evening"
      };
    }

    activeDecisionMakers(context) {
      return DECISION_MAKERS.filter((maker) => maker.applies(context));
    }

    activeCalibrationGroups(context) {
      return CALIBRATION_GROUPS.filter((group) => group.applies(context));
    }

    calibrationGroupIds(context) {
      return this.activeCalibrationGroups(context).map((group) => group.id);
    }

    testGroupIds(context) {
      return ["overall", ...this.calibrationGroupIds(context)];
    }

    allTestGroupIds() {
      return [
        "overall",
        ...CALIBRATION_GROUPS.map((group) => group.id)
      ];
    }

    bestResponse(maker, prediction) {
      return prediction >= maker.cost ? "bring" : "leave";
    }

    decisionUtility(maker, action, outcome) {
      return action === "bring" ? outcome - maker.cost : 0;
    }

    calibrationGroupLabel(groupId) {
      if (groupId === "overall") {
        return "All forecasts";
      }

      const group = CALIBRATION_GROUPS.find((item) => item.id === groupId);
      return group ? group.label : groupId;
    }

    expertKey(groupId, bin, sign) {
      return `${groupId}|${bin.id}|${sign}`;
    }

    getScore(groupId, bin, sign) {
      return this.scores.get(this.expertKey(groupId, bin, sign)) || 0;
    }

    setScore(groupId, bin, sign, value) {
      this.scores.set(this.expertKey(groupId, bin, sign), Math.max(-40, Math.min(40, value)));
    }

    targetFor(context) {
      const activeGroupIds = ["overall", ...this.calibrationGroupIds(context)];
      let numerator = 0;
      let denominator = 0;

      for (const groupId of activeGroupIds) {
        const stats = this.groupTargets.get(groupId) || { sum: 0, count: 0 };
        const weight = groupId === "overall" ? 0.55 : 1;
        numerator += weight * ((stats.sum + 0.5) / (stats.count + 1));
        denominator += weight;
      }

      return numerator / denominator;
    }

    prepareRound() {
      const roundIndex = this.history.length;
      const context = this.contextAt(roundIndex);
      const solution = this.solveEvi(context);
      const sampledIndex = this.sampleIndex(solution.probs);

      return {
        roundNumber: roundIndex + 1,
        context,
        activeMakers: this.activeDecisionMakers(context).map((maker) => ({
          id: maker.id,
          label: maker.label,
          scope: maker.scope,
          cost: maker.cost
        })),
        decisionMakers: DECISION_MAKERS.map((maker) => ({
          id: maker.id,
          label: maker.label,
          scope: maker.scope,
          cost: maker.cost,
          active: maker.applies(context)
        })),
        activeCalibrationGroups: this.activeCalibrationGroups(context).map((group) => ({
          id: group.id,
          label: group.label
        })),
        sampledIndex,
        prediction: this.bins[sampledIndex].mid,
        distribution: solution.probs.map((probability, index) => ({
          probability,
          midpoint: this.bins[index].mid,
          lo: this.bins[index].lo,
          hi: this.bins[index].hi,
          depth: this.bins[index].depth
        })),
        expectedPrediction: solution.expectedPrediction,
        target: solution.target,
        eviValue: solution.eviValue
      };
    }

    solveEvi(context) {
      if (this.options.objective === "decision") {
        return this.solveDecisionEvi(context);
      }
      return this.solveCalibrationEvi(context);
    }

    solveCalibrationEvi(context) {
      const target = this.targetFor(context);
      const weightedExperts = [];
      let maxLogit = -Infinity;

      for (const bin of this.bins) {
        for (const groupId of this.testGroupIds(context)) {
          for (const sign of ["+", "-"]) {
            const logit = this.options.eta * this.getScore(groupId, bin, sign);
            weightedExperts.push({ bin, groupId, sign, logit });
            maxLogit = Math.max(maxLogit, logit);
          }
        }
      }

      let normalizer = 0;
      for (const expert of weightedExperts) {
        expert.weight = Math.exp(expert.logit - maxLogit);
        normalizer += expert.weight;
      }

      const lambdas = new Map();
      for (const expert of weightedExperts) {
        lambdas.set(this.expertKey(expert.groupId, expert.bin, expert.sign), expert.weight / normalizer);
      }

      const coefficients = this.bins.map((bin) => {
        let signedWeight = 0;
        let totalWeight = 0;

        for (const groupId of this.testGroupIds(context)) {
          const plus = lambdas.get(this.expertKey(groupId, bin, "+")) || 0;
          const minus = lambdas.get(this.expertKey(groupId, bin, "-")) || 0;
          signedWeight += plus - minus;
          totalWeight += plus + minus;
        }

        const slack = this.options.slackFactor * bin.width;
        return {
          bin,
          c0: signedWeight * (0 - bin.mid) - totalWeight * slack,
          c1: signedWeight * (1 - bin.mid) - totalWeight * slack
        };
      });

      return this.selectDistribution(coefficients, target);
    }

    decisionExpertKey(groupId, makerId, swap) {
      return `decision|${groupId}|${makerId}|${swap}`;
    }

    getDecisionScore(groupId, makerId, swap) {
      return this.scores.get(this.decisionExpertKey(groupId, makerId, swap)) || 0;
    }

    setDecisionScore(groupId, makerId, swap, value) {
      this.scores.set(this.decisionExpertKey(groupId, makerId, swap), Math.max(-40, Math.min(40, value)));
    }

    solveDecisionEvi(context) {
      const target = this.targetFor(context);
      const activeGroupIds = this.testGroupIds(context);
      const weightedExperts = [];
      let maxLogit = -Infinity;

      for (const groupId of activeGroupIds) {
        for (const maker of DECISION_MAKERS) {
          for (const swap of ["bring-to-leave", "leave-to-bring"]) {
            const logit = this.options.eta * this.getDecisionScore(groupId, maker.id, swap);
            weightedExperts.push({ groupId, maker, swap, logit });
            maxLogit = Math.max(maxLogit, logit);
          }
        }
      }

      let normalizer = 0;
      for (const expert of weightedExperts) {
        expert.weight = Math.exp(expert.logit - maxLogit);
        normalizer += expert.weight;
      }

      const lambdas = new Map();
      for (const expert of weightedExperts) {
        lambdas.set(
          this.decisionExpertKey(expert.groupId, expert.maker.id, expert.swap),
          expert.weight / normalizer
        );
      }

      const coefficients = this.bins.map((bin) => {
        let c0 = 0;
        let c1 = 0;

        for (const groupId of activeGroupIds) {
          for (const maker of DECISION_MAKERS) {
            const bringWeight = lambdas.get(this.decisionExpertKey(groupId, maker.id, "bring-to-leave")) || 0;
            const leaveWeight = lambdas.get(this.decisionExpertKey(groupId, maker.id, "leave-to-bring")) || 0;

            if (bin.mid >= maker.cost) {
              c0 += bringWeight * maker.cost;
              c1 += bringWeight * (maker.cost - 1);
            } else {
              c0 -= leaveWeight * maker.cost;
              c1 += leaveWeight * (1 - maker.cost);
            }
          }
        }

        return { bin, c0, c1 };
      });

      return this.selectDistribution(coefficients, target);
    }

    selectDistribution(coefficients, target) {
      const candidates = this.candidateDistributions(coefficients.length, coefficients);
      let minViolation = Infinity;
      const evaluated = candidates.map((candidate) => {
        const value = this.evaluateDistribution(candidate, coefficients);
        minViolation = Math.min(minViolation, value.violation);
        return { candidate, value };
      });

      const allowedViolation = Math.max(1e-9, minViolation + this.options.eviTieSlack);
      let best = null;

      for (const item of evaluated) {
        if (item.value.violation > allowedViolation) {
          continue;
        }

        const targetDistance = Math.abs(item.value.mean - target);
        const support = item.candidate.filter((entry) => entry[1] > 1e-9).length;
        const betterTarget = !best || targetDistance < best.targetDistance - 1e-10;
        const betterViolation = best && Math.abs(targetDistance - best.targetDistance) <= 1e-10 &&
          item.value.violation < best.value.violation - 1e-10;
        const simpler = best && Math.abs(targetDistance - best.targetDistance) <= 1e-10 &&
          Math.abs(item.value.violation - best.value.violation) <= 1e-10 &&
          support < best.support;

        if (betterTarget || betterViolation || simpler) {
          best = { ...item, targetDistance, support };
        }
      }

      const probs = Array(this.bins.length).fill(0);
      for (const [index, probability] of best.candidate) {
        probs[index] = probability;
      }

      return {
        probs,
        expectedPrediction: best.value.mean,
        target,
        eviValue: best.value.violation
      };
    }

    candidateDistributions(count, coefficients) {
      const candidates = [];

      for (let index = 0; index < count; index += 1) {
        candidates.push([[index, 1]]);
      }

      for (let left = 0; left < count; left += 1) {
        for (let right = left + 1; right < count; right += 1) {
          const leftCoeff = coefficients[left];
          const rightCoeff = coefficients[right];
          const denominator = (leftCoeff.c0 - rightCoeff.c0) - (leftCoeff.c1 - rightCoeff.c1);
          const alphas = [0, 0.25, 0.5, 0.75, 1];

          if (Math.abs(denominator) > 1e-12) {
            const crossing = (rightCoeff.c1 - rightCoeff.c0) / denominator;
            if (crossing >= 0 && crossing <= 1) {
              alphas.push(crossing);
            }
          }

          for (const alpha of alphas) {
            candidates.push([
              [left, alpha],
              [right, 1 - alpha]
            ].filter((entry) => entry[1] > 1e-9));
          }
        }
      }

      return candidates;
    }

    evaluateDistribution(candidate, coefficients) {
      let c0 = 0;
      let c1 = 0;
      let mean = 0;

      for (const [index, probability] of candidate) {
        c0 += probability * coefficients[index].c0;
        c1 += probability * coefficients[index].c1;
        mean += probability * coefficients[index].bin.mid;
      }

      return {
        c0,
        c1,
        mean,
        violation: Math.max(c0, c1)
      };
    }

    sampleIndex(probs) {
      const draw = this.rng();
      let cumulative = 0;

      for (let index = 0; index < probs.length; index += 1) {
        cumulative += probs[index];
        if (draw <= cumulative) {
          return index;
        }
      }

      return probs.length - 1;
    }

    submitOutcome(outcome) {
      const y = Number(outcome);
      const round = this.pending;

      this.recordBinMass(round);
      if (this.options.objective === "decision") {
        this.updateDecisionScores(round, y);
      } else {
        this.updateCalibrationScores(round, y);
      }

      this.decayTargets();
      for (const groupId of ["overall", ...this.calibrationGroupIds(round.context)]) {
        const stats = this.groupTargets.get(groupId) || { sum: 0, count: 0 };
        stats.sum += y;
        stats.count += 1;
        this.groupTargets.set(groupId, stats);
      }

      const record = {
        roundNumber: round.roundNumber,
        context: round.context,
        activeMakers: round.activeMakers,
        activeCalibrationGroups: round.activeCalibrationGroups,
        outcome: y,
        prediction: round.prediction,
        expectedPrediction: round.expectedPrediction,
        target: round.target,
        distribution: round.distribution
      };

      this.history.push(record);
      if (this.options.objective === "calibration") {
        this.splitBins();
      }
      const metrics = this.computeMetrics();
      this.metricHistory.push(metrics);
      this.pending = this.prepareRound();

      return {
        record,
        metrics,
        state: this.getState()
      };
    }

    recordBinMass(round) {
      for (let index = 0; index < this.bins.length; index += 1) {
        this.bins[index].mass += round.distribution[index].probability;
      }
    }

    updateCalibrationScores(round, y) {
      for (let index = 0; index < this.bins.length; index += 1) {
        const bin = this.bins[index];
        const probability = round.distribution[index].probability;
        const slack = this.options.slackFactor * bin.width;

        if (probability <= 0) {
          continue;
        }

        for (const groupId of this.testGroupIds(round.context)) {
          const plusUpdate = probability * (y - bin.mid - slack);
          const minusUpdate = probability * (bin.mid - y - slack);
          this.setScore(groupId, bin, "+", this.getScore(groupId, bin, "+") + plusUpdate);
          this.setScore(groupId, bin, "-", this.getScore(groupId, bin, "-") + minusUpdate);
        }
      }
    }

    updateDecisionScores(round, y) {
      for (const groupId of this.testGroupIds(round.context)) {
        for (const maker of DECISION_MAKERS) {
          let bringMass = 0;
          let leaveMass = 0;

          for (const entry of round.distribution) {
            if (entry.midpoint >= maker.cost) {
              bringMass += entry.probability;
            } else {
              leaveMass += entry.probability;
            }
          }

          this.setDecisionScore(
            groupId,
            maker.id,
            "bring-to-leave",
            this.getDecisionScore(groupId, maker.id, "bring-to-leave") + bringMass * (maker.cost - y)
          );
          this.setDecisionScore(
            groupId,
            maker.id,
            "leave-to-bring",
            this.getDecisionScore(groupId, maker.id, "leave-to-bring") + leaveMass * (y - maker.cost)
          );
        }
      }
    }

    decayTargets() {
      for (const stats of this.groupTargets.values()) {
        stats.sum *= this.options.targetDecay;
        stats.count *= this.options.targetDecay;
      }
    }

    splitBins() {
      const nextBins = [];

      for (const bin of this.bins) {
        const threshold = this.options.splitBase / (bin.width * bin.width);
        if (bin.depth < this.options.maxDepth && bin.mass >= threshold) {
          const leftChild = new Bin(bin.lo, bin.mid, bin.depth + 1);
          const rightChild = new Bin(bin.mid, bin.hi, bin.depth + 1);
          this.inheritScores(bin, leftChild);
          this.inheritScores(bin, rightChild);
          nextBins.push(leftChild);
          nextBins.push(rightChild);
        } else {
          nextBins.push(bin);
        }
      }

      this.bins = nextBins;
    }

    inheritScores(parent, child) {
      for (const groupId of this.allTestGroupIds()) {
        for (const sign of ["+", "-"]) {
          this.setScore(groupId, child, sign, this.getScore(groupId, parent, sign));
        }
      }
    }

    strategyOutcome(strategyName) {
      const strategy = STRATEGIES[strategyName];
      if (!strategy) {
        throw new Error(`Unknown strategy: ${strategyName}`);
      }
      return strategy.outcome(this.history, this.pending.context, this.history.length);
    }

    runStrategy(strategyName, rounds) {
      const results = [];
      for (let index = 0; index < rounds; index += 1) {
        results.push(this.submitOutcome(this.strategyOutcome(strategyName)));
      }
      return results;
    }

    computeMetrics() {
      const cellStats = new Map();
      const groupTotals = new Map();
      const makerStats = new Map();
      const totalRounds = Math.max(1, this.history.length);
      let umbrellaCount = 0;
      let decisionCount = 0;

      for (const record of this.history) {
        for (const groupId of this.testGroupIds(record.context)) {
          const key = `${groupId}|${record.prediction.toFixed(4)}`;
          const stats = cellStats.get(key) || {
            groupId,
            prediction: record.prediction,
            count: 0,
            residual: 0
          };
          stats.count += 1;
          stats.residual += record.outcome - record.prediction;
          cellStats.set(key, stats);
        }

        for (const maker of this.activeDecisionMakers(record.context)) {
          const action = this.bestResponse(maker, record.prediction);
          const bringUtility = this.decisionUtility(maker, "bring", record.outcome);
          const chosenUtility = this.decisionUtility(maker, action, record.outcome);
          const stats = makerStats.get(maker.id) || {
            maker,
            count: 0,
            brings: 0,
            bringToLeaveImprovement: 0,
            leaveToBringImprovement: 0
          };

          stats.count += 1;
          stats.brings += action === "bring" ? 1 : 0;

          if (action === "bring") {
            stats.bringToLeaveImprovement += 0 - chosenUtility;
          } else {
            stats.leaveToBringImprovement += bringUtility - chosenUtility;
          }

          makerStats.set(maker.id, stats);
          umbrellaCount += action === "bring" ? 1 : 0;
          decisionCount += 1;
        }
      }

      let worstCell = 0;
      let worstCellLabel = "n/a";
      for (const stats of cellStats.values()) {
        groupTotals.set(stats.groupId, (groupTotals.get(stats.groupId) || 0) + Math.abs(stats.residual));
        if (stats.count >= 2) {
          const cellError = Math.abs(stats.residual) / stats.count;
          if (cellError > worstCell) {
            worstCell = cellError;
            worstCellLabel = `${this.calibrationGroupLabel(stats.groupId)} @ ${formatProbability(stats.prediction)}`;
          }
        }
      }

      const overallCalibrationTotal = Array.from(cellStats.values())
        .filter((stats) => stats.groupId === "overall")
        .reduce((total, stats) => total + Math.abs(stats.residual), 0);
      const calibrationError = overallCalibrationTotal / totalRounds;
      let multicalibrationError = 0;
      let worstGroup = "n/a";

      for (const [groupId, value] of groupTotals.entries()) {
        const normalized = value / totalRounds;
        if (normalized > multicalibrationError) {
          multicalibrationError = normalized;
          worstGroup = this.calibrationGroupLabel(groupId);
        }
      }

      let maxSwapRegret = 0;
      let worstDecisionAgent = "n/a";

      for (const stats of makerStats.values()) {
        const denominator = Math.max(1, stats.count);
        const swapRegret = (
          Math.max(0, stats.bringToLeaveImprovement) +
          Math.max(0, stats.leaveToBringImprovement)
        ) / denominator;

        if (swapRegret > maxSwapRegret) {
          maxSwapRegret = swapRegret;
          worstDecisionAgent = stats.maker.label;
        }
      }

      return {
        round: this.history.length,
        calibrationError,
        multicalibrationError,
        maxSwapRegret,
        umbrellaRate: decisionCount ? umbrellaCount / decisionCount : 0,
        worstCell,
        worstCellLabel,
        worstGroup,
        worstDecisionAgent,
        activeBins: this.bins.length,
        decisionCount
      };
    }

    getState() {
      return {
        pending: this.pending,
        history: this.history.slice(),
        metrics: this.metricHistory[this.metricHistory.length - 1] || this.computeMetrics(),
        metricHistory: this.metricHistory.slice(),
        bins: this.bins.map((bin) => ({
          lo: bin.lo,
          hi: bin.hi,
          midpoint: bin.mid,
          depth: bin.depth,
          mass: bin.mass
        })),
        decisionMakers: DECISION_MAKERS.map((maker) => ({
          id: maker.id,
          label: maker.label,
          scope: maker.scope,
          cost: maker.cost
        })),
        calibrationGroups: CALIBRATION_GROUPS.map((group) => ({
          id: group.id,
          label: group.label
        })),
        strategies: STRATEGIES
      };
    }
  }

  function formatProbability(value) {
    return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  function createCalibrationGame(root, options = {}) {
    let core = new CalibrationGameCore(coreOptions());
    const elements = {
      round: root.querySelector("[data-game-round]"),
      status: root.querySelector("[data-game-status]"),
      context: root.querySelector("[data-game-context]"),
      agents: root.querySelector("[data-game-agents]"),
      agentNote: root.querySelector("[data-game-agent-note]"),
      calibrationGroups: root.querySelector("[data-game-calibration-groups]"),
      forecastLabel: root.querySelector("[data-game-forecast-label]"),
      forecast: root.querySelector("[data-game-forecast]"),
      expected: root.querySelector("[data-game-expected]"),
      target: root.querySelector("[data-game-target]"),
      distribution: root.querySelector("[data-game-distribution]"),
      tree: root.querySelector("[data-game-tree]"),
      last: root.querySelector("[data-game-last]"),
      calError: root.querySelector("[data-game-cal-error]"),
      mcError: root.querySelector("[data-game-mc-error]"),
      swapRegret: root.querySelector("[data-game-swap-regret]"),
      umbrellaRate: root.querySelector("[data-game-umbrella-rate]"),
      worstAgent: root.querySelector("[data-game-worst-agent]"),
      decisionCount: root.querySelector("[data-game-decision-count]"),
      worstCell: root.querySelector("[data-game-worst-cell]"),
      activeBins: root.querySelector("[data-game-active-bins]"),
      treeLabel: root.querySelector("[data-game-tree-label]"),
      algorithm: root.querySelector("[data-game-algorithm]"),
      algorithmNote: root.querySelector("[data-game-algorithm-note]"),
      behavior: root.querySelector("[data-game-behavior]"),
      modeNote: root.querySelector("[data-game-mode-note]"),
      advanced: root.querySelector("[data-game-advanced]"),
      run10: root.querySelector("[data-game-run='10']"),
      run50: root.querySelector("[data-game-run='50']"),
      reset: root.querySelector("[data-game-reset]"),
      outcomes: Array.from(root.querySelectorAll("[data-game-outcome]")),
      canvas: root.querySelector("[data-game-chart]")
    };

    elements.outcomes.forEach((button) => {
      button.addEventListener("click", () => {
        core.submitOutcome(Number(button.dataset.gameOutcome));
        render();
      });
    });

    elements.behavior.addEventListener("change", render);

    elements.algorithm.addEventListener("change", () => {
      resetCore();
      render();
    });

    elements.advanced.addEventListener("toggle", render);

    elements.run10.addEventListener("click", () => {
      runSelectedBehavior(10);
    });

    elements.run50.addEventListener("click", () => {
      runSelectedBehavior(50);
    });

    elements.reset.addEventListener("click", () => {
      resetCore();
      render();
    });

    function selectedObjectiveOptions() {
      return elements.algorithm.value === "calibration"
        ? { objective: "calibration" }
        : { objective: "decision" };
    }

    function coreOptions() {
      const selected = root.querySelector("[data-game-algorithm]");
      const objective = selected && selected.value === "calibration" ? "calibration" : "decision";
      return {
        ...options,
        objective
      };
    }

    function resetCore() {
      core = new CalibrationGameCore({
        ...options,
        ...selectedObjectiveOptions()
      });
    }

    function runSelectedBehavior(rounds) {
      const behavior = elements.behavior.value;
      if (behavior === "manual") {
        return;
      }
      core.runStrategy(behavior, rounds);
      render();
    }

    function render() {
      const state = core.getState();
      const pending = state.pending;
      const metrics = state.metrics;
      const last = state.history[state.history.length - 1];
      const autoMode = elements.behavior.value !== "manual";
      const decisionMode = core.options.objective === "decision";

      elements.round.textContent = String(pending.roundNumber);
      elements.context.innerHTML = [
        `<span>${pending.context.region === "coast" ? "Coast" : "Inland"}</span>`,
        `<span>${pending.context.period === "morning" ? "Morning" : "Evening"}</span>`
      ].join("");
      elements.calibrationGroups.innerHTML = [
        { label: "All forecasts" },
        ...state.calibrationGroups
      ].map((group) => `<span>${group.label}</span>`).join("");
      elements.agentNote.textContent = decisionMode
        ? "Swap regret is evaluated separately for each decision maker on its own rounds. Each has umbrella cost c and brings when p >= c; the forecaster trains on these threshold regions crossed with the context groups."
        : "Swap regret is evaluated separately for each decision maker on its own rounds. The ECE forecaster trains on prediction bins crossed with the context groups; swap regret is measured afterward for the agents below.";
      elements.algorithmNote.textContent = decisionMode
        ? "Decision calibration controls bring/leave threshold regions crossed with context groups."
        : "ECE multicalibration controls prediction-bin calibration residuals crossed with context groups.";
      renderAgents(pending.decisionMakers);

      const shownForecast = autoMode ? pending.prediction : last ? last.prediction : null;
      elements.status.textContent = autoMode
        ? "Auto: next forecast visible"
        : "Manual: next forecast hidden";
      elements.forecastLabel.textContent = autoMode
        ? "Next forecast"
        : last ? "Last forecast" : "Rain forecast";
      elements.forecast.textContent = shownForecast === null
        ? "Hidden"
        : formatProbability(shownForecast);
      elements.expected.textContent = formatProbability(pending.expectedPrediction);
      elements.target.textContent = formatProbability(pending.target);
      elements.calError.textContent = formatProbability(metrics.calibrationError);
      elements.mcError.textContent = formatProbability(metrics.multicalibrationError);
      elements.swapRegret.textContent = formatProbability(metrics.maxSwapRegret);
      elements.umbrellaRate.textContent = `${Math.round(metrics.umbrellaRate * 100)}%`;
      elements.worstAgent.textContent = `Worst agent: ${metrics.worstDecisionAgent}`;
      elements.decisionCount.textContent = `${metrics.decisionCount} decisions`;
      elements.worstCell.textContent = metrics.worstCellLabel === "n/a"
        ? "n/a"
        : `${metrics.worstCellLabel}: ${formatProbability(metrics.worstCell)}`;
      elements.activeBins.textContent = decisionMode
        ? `${metrics.activeBins} threshold regions`
        : `${metrics.activeBins} bins`;
      elements.treeLabel.textContent = decisionMode
        ? "Decision threshold partition"
        : "Adaptive prediction tree";
      elements.last.textContent = last
        ? `Round ${last.roundNumber}: rain forecast ${formatProbability(last.prediction)}, weather ${last.outcome ? "rain" : "dry"}`
        : autoMode
          ? "Run 10 or 50 rounds to simulate the selected weather pattern."
          : "Choose Dry or Rain to reveal this round's sampled forecast.";

      elements.outcomes.forEach((button) => {
        button.disabled = autoMode;
      });
      elements.run10.disabled = !autoMode;
      elements.run50.disabled = !autoMode;
      elements.modeNote.textContent = autoMode
        ? "Run buttons advance the selected automated weather pattern."
        : "Manual mode uses the Dry and Rain buttons one round at a time.";

      renderDistribution(pending.distribution);
      renderTree(state.bins, decisionMode);
      drawChart(elements.canvas, state.metricHistory);
    }

    function renderAgents(decisionMakers) {
      const header = `
        <div class="agent-row agent-head">
          <span>Agent</span>
          <span>Rounds</span>
          <span>Best response</span>
        </div>
      `;
      const rows = decisionMakers.map((maker) => `
        <div class="agent-row${maker.active ? "" : " is-inactive"}">
          <span class="agent-name">${maker.label}${maker.active ? '<span class="agent-active">active</span>' : ""}</span>
          <span>${maker.scope}</span>
          <span>bring if p >= ${formatProbability(maker.cost)}</span>
        </div>
      `).join("");
      elements.agents.innerHTML = header + rows;
    }

    function renderDistribution(distribution) {
      elements.distribution.innerHTML = distribution.map((entry) => {
        const width = Math.max(2, entry.probability * 100);
        const muted = entry.probability < 0.01 ? " is-muted" : "";
        return `
          <div class="dist-row${muted}">
            <span class="dist-label">${formatProbability(entry.midpoint)}</span>
            <span class="dist-track"><span class="dist-fill" style="width: ${width}%"></span></span>
            <span class="dist-prob">${Math.round(entry.probability * 100)}%</span>
          </div>
        `;
      }).join("");
    }

    function renderTree(bins, decisionMode) {
      if (decisionMode) {
        elements.tree.innerHTML = `
          <div class="tree-level" style="top: 52px;">
            ${bins.map((bin) => `
              <span class="tree-node is-leaf" style="left: ${bin.lo * 100}%; width: ${(bin.hi - bin.lo) * 100}%;">
                ${formatProbability(bin.midpoint)}
              </span>
            `).join("")}
          </div>
        `;
        return;
      }

      const maxDepth = Math.max(...bins.map((bin) => bin.depth), 0);
      const leafKeys = new Set(bins.map((bin) => `${bin.depth}:${bin.lo.toFixed(5)}`));
      const levels = [];

      for (let depth = 0; depth <= maxDepth; depth += 1) {
        const nodes = new Map();
        const scale = 2 ** depth;

        for (const bin of bins) {
          const index = Math.floor(bin.lo * scale + 1e-9);
          const lo = index / scale;
          const hi = (index + 1) / scale;
          nodes.set(`${depth}:${lo.toFixed(5)}`, {
            depth,
            lo,
            hi,
            midpoint: (lo + hi) / 2,
            isLeaf: leafKeys.has(`${depth}:${lo.toFixed(5)}`)
          });
        }

        levels.push(Array.from(nodes.values()).sort((left, right) => left.lo - right.lo));
      }

      elements.tree.innerHTML = levels.map((nodes, depth) => `
        <div class="tree-level" style="top: ${8 + depth * 24}px;">
          ${nodes.map((node) => `
            <span class="tree-node${node.isLeaf ? " is-leaf" : ""}" style="left: ${node.lo * 100}%; width: ${(node.hi - node.lo) * 100}%;">
              ${node.isLeaf ? formatProbability(node.midpoint) : ""}
            </span>
          `).join("")}
        </div>
      `).join("");
    }

    function drawChart(canvas, metricHistory) {
      if (!canvas) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const dpr = global.devicePixelRatio || 1;
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);

      const context = canvas.getContext("2d");
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const padLeft = 36;
      const padRight = 14;
      const padTop = 14;
      const padBottom = 26;
      const plotWidth = width - padLeft - padRight;
      const plotHeight = height - padTop - padBottom;
      const maxRound = Math.max(10, metricHistory.length);
      const maxValue = Math.max(
        0.5,
        ...metricHistory.flatMap((item) => [
          item.multicalibrationError,
          item.maxSwapRegret,
          item.calibrationError
        ])
      );

      context.strokeStyle = "#d9e0e8";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padLeft, padTop);
      context.lineTo(padLeft, padTop + plotHeight);
      context.lineTo(padLeft + plotWidth, padTop + plotHeight);
      context.stroke();

      context.fillStyle = "#596676";
      context.font = "12px system-ui, sans-serif";
      context.fillText("0", 12, padTop + plotHeight + 4);
      context.fillText(maxValue.toFixed(2), 8, padTop + 4);
      context.fillText(`${maxRound} rounds`, padLeft + plotWidth - 62, height - 6);

      drawSeries("calibrationError", "#b9811f");
      drawSeries("multicalibrationError", "#0f766e");
      drawSeries("maxSwapRegret", "#b64a4a");

      function drawSeries(key, color) {
        if (!metricHistory.length) {
          return;
        }

        context.strokeStyle = color;
        context.lineWidth = 2.5;
        context.beginPath();

        metricHistory.forEach((point, index) => {
          const x = padLeft + (plotWidth * index) / Math.max(1, maxRound - 1);
          const y = padTop + plotHeight - (plotHeight * point[key]) / maxValue;
          if (index === 0) {
            context.moveTo(x, y);
          } else {
            context.lineTo(x, y);
          }
        });

        context.stroke();
      }
    }

    render();
    global.render_game_to_text = () => {
      const state = core.getState();
      const pending = state.pending;
      return JSON.stringify({
        objective: core.options.objective,
        round: pending.roundNumber,
        context: pending.context,
        activeCalibrationGroups: pending.activeCalibrationGroups.map((group) => group.label),
        activeDecisionMakers: pending.decisionMakers
          .filter((maker) => maker.active)
          .map((maker) => maker.label),
        expectedPrediction: pending.expectedPrediction,
        target: pending.target,
        metrics: state.metrics
      });
    };
    global.advanceTime = () => {
      render();
      return global.render_game_to_text();
    };
    return core;
  }

  const api = {
    CalibrationGameCore,
    createCalibrationGame,
    calibrationGroups: CALIBRATION_GROUPS,
    strategies: STRATEGIES,
    formatProbability
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  global.CalibrationGame = api;

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll("[data-calibration-game]").forEach((root) => {
        createCalibrationGame(root);
      });
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
