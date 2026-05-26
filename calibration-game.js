(function (global) {
  "use strict";

  const DEFAULT_OPTIONS = {
    eta: 2.5,
    slackFactor: 0.2,
    splitBase: 0.3,
    maxDepth: 4,
    startDepth: 2,
    eviTieSlack: 0.005,
    targetDecay: 0.92,
    rng: Math.random
  };

  const DECISION_MAKERS = [
    {
      id: "general",
      label: "General lender",
      threshold: 0.5,
      applies: () => true
    },
    {
      id: "red",
      label: "Red outreach",
      threshold: 0.35,
      applies: (context) => context.color === "red"
    },
    {
      id: "blue",
      label: "Blue reviewer",
      threshold: 0.65,
      applies: (context) => context.color === "blue"
    },
    {
      id: "early",
      label: "Early triage",
      threshold: 0.45,
      applies: (context) => context.phase === "early"
    },
    {
      id: "late",
      label: "Late triage",
      threshold: 0.55,
      applies: (context) => context.phase === "late"
    }
  ];

  const STRATEGIES = {
    "always-zero": {
      label: "Always 0",
      outcome: () => 0
    },
    "always-one": {
      label: "Always 1",
      outcome: () => 1
    },
    "red-blue": {
      label: "Red -> 1",
      outcome: (_history, context) => context.color === "red" ? 1 : 0
    },
    "early-late": {
      label: "Early -> 1",
      outcome: (_history, context) => context.phase === "early" ? 1 : 0
    },
    alternating: {
      label: "Alternating",
      outcome: (_history, _context, roundIndex) => roundIndex % 2 === 0 ? 1 : 0
    },
    shift: {
      label: "Shift at 25",
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
      this.options = { ...DEFAULT_OPTIONS, ...options };
      this.rng = this.options.rng;
      this.reset();
    }

    reset() {
      this.bins = [];
      this.scores = new Map();
      this.groupTargets = new Map();
      this.history = [];
      this.metricHistory = [];

      const count = 2 ** this.options.startDepth;
      for (let index = 0; index < count; index += 1) {
        this.bins.push(new Bin(index / count, (index + 1) / count, this.options.startDepth));
      }

      this.pending = this.prepareRound();
      return this.getState();
    }

    contextAt(roundIndex) {
      return {
        color: roundIndex % 2 === 0 ? "red" : "blue",
        phase: Math.floor(roundIndex / 5) % 2 === 0 ? "early" : "late"
      };
    }

    activeDecisionMakers(context) {
      return DECISION_MAKERS.filter((maker) => maker.applies(context));
    }

    decisionGroupIds(context, prediction) {
      return this.activeDecisionMakers(context).map((maker) => {
        const action = this.bestResponse(maker, prediction);
        return `${maker.id}:${action}`;
      });
    }

    testGroupIds(context, prediction) {
      return ["overall", ...this.decisionGroupIds(context, prediction)];
    }

    allTestGroupIds() {
      return [
        "overall",
        ...DECISION_MAKERS.flatMap((maker) => [`${maker.id}:grant`, `${maker.id}:deny`])
      ];
    }

    bestResponse(maker, prediction) {
      return prediction >= maker.threshold ? "grant" : "deny";
    }

    decisionUtility(maker, action, outcome) {
      return action === "grant" ? outcome - maker.threshold : 0;
    }

    decisionGroupLabel(groupId) {
      if (groupId === "overall") {
        return "All forecasts";
      }

      const [makerId, action] = groupId.split(":");
      const maker = DECISION_MAKERS.find((item) => item.id === makerId);
      const makerLabel = maker ? maker.label : makerId;
      return `${makerLabel}: ${action}`;
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
      const activeMakers = this.activeDecisionMakers(context);
      let numerator = 0;
      let denominator = 0;

      for (const maker of activeMakers) {
        const stats = this.groupTargets.get(maker.id) || { sum: 0, count: 0 };
        const weight = maker.id === "general" ? 0.45 : 1;
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
          threshold: maker.threshold
        })),
        decisionGroups: this.decisionGroupIds(context, this.bins[sampledIndex].mid),
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
      const target = this.targetFor(context);
      const weightedExperts = [];
      let maxLogit = -Infinity;

      for (const bin of this.bins) {
        for (const groupId of this.testGroupIds(context, bin.mid)) {
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

        for (const groupId of this.testGroupIds(context, bin.mid)) {
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

      for (let index = 0; index < this.bins.length; index += 1) {
        const bin = this.bins[index];
        const probability = round.distribution[index].probability;
        const slack = this.options.slackFactor * bin.width;
        bin.mass += probability;

        if (probability <= 0) {
          continue;
        }

        for (const groupId of this.testGroupIds(round.context, bin.mid)) {
          const plusUpdate = probability * (y - bin.mid - slack);
          const minusUpdate = probability * (bin.mid - y - slack);
          this.setScore(groupId, bin, "+", this.getScore(groupId, bin, "+") + plusUpdate);
          this.setScore(groupId, bin, "-", this.getScore(groupId, bin, "-") + minusUpdate);
        }
      }

      this.decayTargets();
      for (const maker of this.activeDecisionMakers(round.context)) {
        const stats = this.groupTargets.get(maker.id) || { sum: 0, count: 0 };
        stats.sum += y;
        stats.count += 1;
        this.groupTargets.set(maker.id, stats);
      }

      const record = {
        roundNumber: round.roundNumber,
        context: round.context,
        activeMakers: round.activeMakers,
        decisionGroups: this.decisionGroupIds(round.context, round.prediction),
        outcome: y,
        prediction: round.prediction,
        expectedPrediction: round.expectedPrediction,
        target: round.target,
        distribution: round.distribution
      };

      this.history.push(record);
      this.splitBins();
      const metrics = this.computeMetrics();
      this.metricHistory.push(metrics);
      this.pending = this.prepareRound();

      return {
        record,
        metrics,
        state: this.getState()
      };
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
      let grantCount = 0;
      let decisionCount = 0;

      for (const record of this.history) {
        for (const groupId of this.testGroupIds(record.context, record.prediction)) {
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
          const grantUtility = this.decisionUtility(maker, "grant", record.outcome);
          const chosenUtility = this.decisionUtility(maker, action, record.outcome);
          const stats = makerStats.get(maker.id) || {
            maker,
            count: 0,
            grants: 0,
            utility: 0,
            fixedGrantUtility: 0,
            grantToDenyImprovement: 0,
            denyToGrantImprovement: 0
          };

          stats.count += 1;
          stats.grants += action === "grant" ? 1 : 0;
          stats.utility += chosenUtility;
          stats.fixedGrantUtility += grantUtility;

          if (action === "grant") {
            stats.grantToDenyImprovement += 0 - chosenUtility;
          } else {
            stats.denyToGrantImprovement += grantUtility - chosenUtility;
          }

          makerStats.set(maker.id, stats);
          grantCount += action === "grant" ? 1 : 0;
          decisionCount += 1;
        }
      }

      let worstCell = 0;
      let worstCellLabel = "n/a";
      for (const stats of cellStats.values()) {
        if (stats.groupId !== "overall") {
          groupTotals.set(stats.groupId, (groupTotals.get(stats.groupId) || 0) + Math.abs(stats.residual));
        }
        if (stats.count >= 2) {
          const cellError = Math.abs(stats.residual) / stats.count;
          if (stats.groupId !== "overall" && cellError > worstCell) {
            worstCell = cellError;
            worstCellLabel = `${this.decisionGroupLabel(stats.groupId)} @ ${formatProbability(stats.prediction)}`;
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
          worstGroup = this.decisionGroupLabel(groupId);
        }
      }

      let maxDecisionRegret = 0;
      let maxSwapRegret = 0;
      let worstDecisionAgent = "n/a";

      for (const stats of makerStats.values()) {
        const denominator = Math.max(1, stats.count);
        const bestFixedUtility = Math.max(0, stats.fixedGrantUtility);
        const decisionRegret = Math.max(0, bestFixedUtility - stats.utility) / denominator;
        const swapRegret = (
          Math.max(0, stats.grantToDenyImprovement) +
          Math.max(0, stats.denyToGrantImprovement)
        ) / denominator;

        if (decisionRegret > maxDecisionRegret) {
          maxDecisionRegret = decisionRegret;
        }

        if (swapRegret > maxSwapRegret) {
          maxSwapRegret = swapRegret;
          worstDecisionAgent = stats.maker.label;
        }
      }

      return {
        round: this.history.length,
        calibrationError,
        multicalibrationError,
        maxDecisionRegret,
        maxSwapRegret,
        grantRate: decisionCount ? grantCount / decisionCount : 0,
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
        decisionMakers: DECISION_MAKERS,
        strategies: STRATEGIES
      };
    }
  }

  function formatProbability(value) {
    return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  function createCalibrationGame(root, options = {}) {
    const core = new CalibrationGameCore(options);
    const elements = {
      round: root.querySelector("[data-game-round]"),
      context: root.querySelector("[data-game-context]"),
      groups: root.querySelector("[data-game-groups]"),
      forecast: root.querySelector("[data-game-forecast]"),
      expected: root.querySelector("[data-game-expected]"),
      target: root.querySelector("[data-game-target]"),
      distribution: root.querySelector("[data-game-distribution]"),
      last: root.querySelector("[data-game-last]"),
      calError: root.querySelector("[data-game-cal-error]"),
      mcError: root.querySelector("[data-game-mc-error]"),
      decisionRegret: root.querySelector("[data-game-decision-regret]"),
      swapRegret: root.querySelector("[data-game-swap-regret]"),
      grantRate: root.querySelector("[data-game-grant-rate]"),
      worstAgent: root.querySelector("[data-game-worst-agent]"),
      decisionCount: root.querySelector("[data-game-decision-count]"),
      worstCell: root.querySelector("[data-game-worst-cell]"),
      activeBins: root.querySelector("[data-game-active-bins]"),
      behavior: root.querySelector("[data-game-behavior]"),
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

    elements.run10.addEventListener("click", () => {
      runSelectedBehavior(10);
    });

    elements.run50.addEventListener("click", () => {
      runSelectedBehavior(50);
    });

    elements.reset.addEventListener("click", () => {
      core.reset();
      render();
    });

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

      elements.round.textContent = String(pending.roundNumber);
      elements.context.innerHTML = [
        `<span>${pending.context.color === "red" ? "Red" : "Blue"}</span>`,
        `<span>${pending.context.phase === "early" ? "Early" : "Late"}</span>`
      ].join("");
      elements.groups.innerHTML = pending.activeMakers
        .map((maker) => `<span>${maker.label} ${formatProbability(maker.threshold)}</span>`)
        .join("");
      elements.forecast.textContent = "Locked";
      elements.expected.textContent = formatProbability(pending.expectedPrediction);
      elements.target.textContent = formatProbability(pending.target);
      elements.calError.textContent = formatProbability(metrics.calibrationError);
      elements.mcError.textContent = formatProbability(metrics.multicalibrationError);
      elements.decisionRegret.textContent = formatProbability(metrics.maxDecisionRegret);
      elements.swapRegret.textContent = formatProbability(metrics.maxSwapRegret);
      elements.grantRate.textContent = `${Math.round(metrics.grantRate * 100)}%`;
      elements.worstAgent.textContent = `Worst: ${metrics.worstDecisionAgent}`;
      elements.decisionCount.textContent = `${metrics.decisionCount} decisions`;
      elements.worstCell.textContent = metrics.worstCellLabel === "n/a"
        ? "n/a"
        : `${metrics.worstCellLabel}: ${formatProbability(metrics.worstCell)}`;
      elements.activeBins.textContent = `${metrics.activeBins} bins`;
      elements.last.textContent = last
        ? `Round ${last.roundNumber}: forecast ${formatProbability(last.prediction)}, outcome ${last.outcome}`
        : "No completed rounds yet";

      elements.outcomes.forEach((button) => {
        button.disabled = autoMode;
      });
      elements.run10.disabled = !autoMode;
      elements.run50.disabled = !autoMode;

      renderDistribution(pending.distribution);
      drawChart(elements.canvas, state.metricHistory);
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
    return core;
  }

  const api = {
    CalibrationGameCore,
    createCalibrationGame,
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
