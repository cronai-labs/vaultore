'use strict';

var cronParser = require('cron-parser');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var cronParser__default = /*#__PURE__*/_interopDefault(cronParser);

// src/scheduler/index.ts
var WorkflowScheduler = class {
  workflows = /* @__PURE__ */ new Map();
  interval = null;
  onTick;
  tickIntervalMs;
  constructor(options) {
    this.tickIntervalMs = options?.tickIntervalMs ?? 60 * 1e3;
    this.onTick = options?.onTick;
  }
  register(path, cronExpression) {
    const nextRun = computeNextRun(cronExpression);
    const entry = {
      path,
      cronExpression,
      nextRun,
      enabled: true
    };
    this.workflows.set(path, entry);
    return entry;
  }
  unregister(path) {
    this.workflows.delete(path);
  }
  list() {
    return Array.from(this.workflows.values());
  }
  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.tickIntervalMs);
  }
  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
  tick() {
    const now = /* @__PURE__ */ new Date();
    const due = [];
    for (const workflow of this.workflows.values()) {
      if (!workflow.enabled) continue;
      if (workflow.nextRun <= now) {
        due.push(workflow);
        workflow.lastRun = now;
        workflow.nextRun = computeNextRun(workflow.cronExpression, now);
      }
    }
    if (due.length > 0) {
      this.onTick?.(due);
    }
    return due;
  }
};
function computeNextRun(cronExpression, baseDate = /* @__PURE__ */ new Date()) {
  const interval = cronParser__default.default.parseExpression(cronExpression, { currentDate: baseDate });
  return interval.next().toDate();
}

exports.WorkflowScheduler = WorkflowScheduler;
exports.computeNextRun = computeNextRun;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map