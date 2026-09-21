const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAIN_SCHEDULE,
  MAKEUP_SCHEDULE,
  beijingDate,
  decideCheckin,
} = require('../makeup_gate');

const TODAY = '2026-09-21';

// 2026-09-21 07:40 UTC = 北京 15:40，同一天
const sameDayRun = (over = {}) => ({
  id: 111,
  created_at: '2026-09-21T07:40:00Z',
  status: 'completed',
  conclusion: 'success',
  ...over,
});

test('beijingDate converts UTC to the Beijing calendar day', () => {
  assert.equal(beijingDate('2026-09-21T07:40:00Z'), '2026-09-21');
  // 16:30 UTC 已是次日北京 00:30
  assert.equal(beijingDate('2026-09-21T16:30:00Z'), '2026-09-22');
  assert.equal(beijingDate(new Date('2026-09-20T23:00:00Z')), '2026-09-21');
});

test('manual dispatch always checks in', () => {
  const d = decideCheckin({
    eventName: 'workflow_dispatch',
    schedule: '',
    runId: '999',
    today: TODAY,
    runs: [],
  });

  assert.equal(d.shouldCheckin, true);
  assert.equal(d.isMakeup, false);
});

test('main schedule slot always checks in', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAIN_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [],
  });

  assert.equal(d.shouldCheckin, true);
  assert.equal(d.isMakeup, false);
});

test('makeup slot skips when the main run already succeeded today', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [sameDayRun({ status: 'completed', conclusion: 'success' })],
  });

  assert.equal(d.shouldCheckin, false);
  assert.equal(d.isMakeup, true);
});

test('makeup slot runs when today only has failed runs', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [
      sameDayRun({ id: 222, status: 'completed', conclusion: 'failure' }),
    ],
  });

  assert.equal(d.shouldCheckin, true);
  assert.equal(d.isMakeup, true);
  assert.match(d.reason, /222/);
});

test('makeup slot skips while the main run is still in progress', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [sameDayRun({ status: 'in_progress', conclusion: null })],
  });

  assert.equal(d.shouldCheckin, false);
});

test('makeup slot runs when there is no run at all today', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [
      // 昨天的成功 run 不算今天
      sameDayRun({ id: 333, created_at: '2026-09-20T07:40:00Z' }),
    ],
  });

  assert.equal(d.shouldCheckin, true);
});

test('makeup slot ignores its own in-flight run', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [
      sameDayRun({ id: 999, status: 'in_progress', conclusion: null }),
      sameDayRun({ id: 222, status: 'completed', conclusion: 'failure' }),
    ],
  });

  assert.equal(d.shouldCheckin, true);
});

test('makeup slot runs when today has a failure after an earlier success is absent', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [
      sameDayRun({ id: 222, status: 'completed', conclusion: 'failure' }),
      sameDayRun({ id: 223, status: 'completed', conclusion: 'cancelled' }),
    ],
  });

  assert.equal(d.shouldCheckin, true);
});

test('makeup slot succeeds-fast when any run today succeeded alongside failures', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: [
      sameDayRun({ id: 222, status: 'completed', conclusion: 'failure' }),
      sameDayRun({ id: 223, status: 'completed', conclusion: 'success' }),
    ],
  });

  assert.equal(d.shouldCheckin, false);
});

test('makeup slot runs conservatively when the run history could not be fetched', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: MAKEUP_SCHEDULE,
    runId: '999',
    today: TODAY,
    runs: null,
    runsFetchFailed: true,
  });

  assert.equal(d.shouldCheckin, true);
  assert.equal(d.isMakeup, true);
});

test('unknown cron checks in conservatively rather than silently skipping', () => {
  const d = decideCheckin({
    eventName: 'schedule',
    schedule: '0 5 * * *',
    runId: '999',
    today: TODAY,
    runs: [],
  });

  assert.equal(d.shouldCheckin, true);
});

test('manual dispatch with slot=auto checks in directly', () => {
  const d = decideCheckin({
    eventName: 'workflow_dispatch',
    schedule: '',
    slot: 'auto',
    runId: '999',
    today: TODAY,
    runs: [],
  });

  assert.equal(d.shouldCheckin, true);
  assert.equal(d.isMakeup, false);
});

test('manual dispatch with slot=makeup skips when the main run already succeeded', () => {
  const d = decideCheckin({
    eventName: 'workflow_dispatch',
    schedule: '',
    slot: 'makeup',
    runId: '999',
    today: TODAY,
    runs: [sameDayRun({ status: 'completed', conclusion: 'success' })],
  });

  assert.equal(d.shouldCheckin, false);
  assert.equal(d.isMakeup, true);
});

test('manual dispatch with slot=makeup runs when today only has failures', () => {
  const d = decideCheckin({
    eventName: 'workflow_dispatch',
    schedule: '',
    slot: 'makeup',
    runId: '999',
    today: TODAY,
    runs: [sameDayRun({ id: 222, status: 'completed', conclusion: 'failure' })],
  });

  assert.equal(d.shouldCheckin, true);
  assert.equal(d.isMakeup, true);
  assert.match(d.reason, /222/);
});
