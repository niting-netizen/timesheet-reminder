import { describe, expect, it } from 'vitest';
import {
  HOUR, dailyTargetSeconds, evaluate, formatHours, isoDate, plannedSends, targetSeconds, weekWindow, workingDays,
} from '../../shared/calc';
import { defaultSettings } from '../../shared/defaults';

const week = () => defaultSettings().week;
const h = (n: number) => Math.round(n * HOUR);

describe('targets (spec §9)', () => {
  it('standard week is 5 days × 8 h = 40 h', () => {
    expect(workingDays(week())).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expect(dailyTargetSeconds(week())).toBe(h(8));
    expect(targetSeconds(week())).toBe(h(40));
  });
  it('one approved leave day or public holiday gives 32 h', () => {
    expect(targetSeconds(week(), { approvedDaysOff: 1 })).toBe(h(32));
  });
  it('weekly hours change recalculates daily and weekly target (scenario 27)', () => {
    const w = { ...week(), weeklyHours: 45 };
    expect(dailyTargetSeconds(w)).toBe(h(9));
    expect(targetSeconds(w, { approvedDaysOff: 1 })).toBe(h(36));
  });
  it('Mon–Sat 48 h gives 6 days at 8 h (scenario 26)', () => {
    const w = { ...week(), endDay: 'SAT' as const, weeklyHours: 48 };
    expect(workingDays(w)).toHaveLength(6);
    expect(dailyTargetSeconds(w)).toBe(h(8));
  });
  it('daily override wins over the derived value', () => {
    expect(dailyTargetSeconds({ ...week(), dailyOverride: 7.5 })).toBe(h(7.5));
  });
  it('target never goes below zero', () => {
    expect(targetSeconds(week(), { approvedDaysOff: 9 })).toBe(0);
  });
});

describe('status (spec §17 scenarios 1–5, 9)', () => {
  const ev = (logged: number, target = 40, sourcesComplete = true) =>
    evaluate({ loggedSeconds: h(logged), targetSeconds: h(target), sourcesComplete });

  it('exactly 40 h is complete', () => expect(ev(40).status).toBe('complete'));
  it('39.5 h leaves 0.5 h pending', () => {
    expect(ev(39.5).status).toBe('pending');
    expect(formatHours(ev(39.5).pendingSeconds)).toBe('0.5');
  });
  it('33.8 h leaves 6.2 h pending', () => expect(formatHours(ev(33.8).pendingSeconds)).toBe('6.2'));
  it('zero worklogs is pending with 40 h', () => {
    expect(ev(0).status).toBe('pending');
    expect(formatHours(ev(0).pendingSeconds)).toBe('40');
  });
  it('32 h against an adjusted 32 h target is complete', () => expect(ev(32, 32).status).toBe('complete'));
  it('a missing source is never complete or pending', () => {
    expect(ev(40, 40, false).status).toBe('source_missing');
    expect(ev(10, 40, false).status).toBe('source_missing');
  });
  it('completion is capped at 100%', () => expect(ev(45).completionPct).toBe(100));
});

describe('week window in the company timezone (scenario 13)', () => {
  it('a late Sunday UTC instant is already Monday in IST', () => {
    // 2026-11-15 20:00 UTC = 2026-11-16 01:30 IST (Monday)
    const w = weekWindow(week(), new Date('2026-11-15T20:00:00Z'));
    expect(isoDate(w.start)).toBe('2026-11-16');
    expect(isoDate(w.end)).toBe('2026-11-20');
    expect(w.isoWeek).toBe(47);
  });
  it('the same instant is still the previous week in UTC', () => {
    const w = weekWindow({ ...week(), timezone: 'UTC' }, new Date('2026-11-15T20:00:00Z'));
    expect(isoDate(w.start)).toBe('2026-11-09');
    expect(w.isoWeek).toBe(46);
  });
});

describe('send plan', () => {
  it('defaults give Thu/Fri reminders and pending lists at 1, 3, 5 and 7 PM', () => {
    const plan = plannedSends(defaultSettings());
    expect(plan.map((p) => `${p.day} ${p.time} ${p.eventId}`)).toEqual([
      'THU 11:00 R1', 'FRI 11:00 R2', 'FRI 13:00 R3', 'FRI 15:00 REPEAT', 'FRI 17:00 REPEAT', 'FRI 19:00 REPEAT',
    ]);
  });
  it('max reminders caps the number of pending reports (scenario 17)', () => {
    const s = defaultSettings();
    s.schedule.maxReminders = 2;
    expect(plannedSends(s).filter((p) => p.reportNumber).length).toBe(2);
  });
  it('sends outside allowed hours or working days are flagged', () => {
    const s = defaultSettings();
    s.schedule.events[0]!.day = 'SAT';
    s.schedule.windowTo = '16:00';
    const plan = plannedSends(s);
    expect(plan.find((p) => p.eventId === 'R1')?.skipReason).toBe('not_working_day');
    expect(plan.find((p) => p.time === '17:00')?.skipReason).toBe('outside_window');
  });
});
