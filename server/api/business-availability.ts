import { problem, type Router } from '../http/core.ts';
import * as repo from '../db/repositories.ts';
import {
  created, guard, instantField, int, ok, optionalStr, requireBusiness, str, type AppEnv,
} from './context.ts';
import type { Weekday } from '../../lib/contracts/index.ts';
import { registerAssistantRoutes } from './assistant-actions.ts';

const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/**
 * API extensions that sit beside the large core route module. Staffing
 * availability landed first; the guarded Assistant now registers through the
 * same extension hook so main.ts keeps one stable composition point.
 */
export function registerBusinessAvailabilityRoutes(router: Router, env: AppEnv): void {
  router.get('/api/households/:householdId/business/availability',
    guard(env, { permission: 'business.read' }, async (ctx) => {
      const resolved = await requireBusiness(ctx);
      if (!resolved.ok) return resolved.reply;
      const [availability, timeOff] = await Promise.all([
        repo.listAvailability(ctx.env.db, ctx.actor.household.id, resolved.business.id),
        repo.listTimeOff(ctx.env.db, ctx.actor.household.id, resolved.business.id),
      ]);
      return ok({ availability, timeOff });
    }));

  router.post('/api/households/:householdId/business/availability',
    guard(env, { permission: 'employee.schedule' }, async (ctx) => {
      const resolved = await requireBusiness(ctx);
      if (!resolved.ok) return resolved.reply;

      const employeeId = str(ctx.req.body, 'employeeId', 80);
      const weekday = str(ctx.req.body, 'weekday', 2) as Weekday | null;
      const startMinute = int(ctx.req.body, 'startMinute');
      const endMinute = int(ctx.req.body, 'endMinute');
      const preferredWeeklyHours = int(ctx.req.body, 'preferredWeeklyHours');
      const availableRaw = ctx.req.body?.['available'];
      const available = availableRaw === false || availableRaw === 'false' || availableRaw === 'off' ? false : true;

      if (employeeId === null || weekday === null || !WEEKDAYS.includes(weekday)
        || startMinute === null || endMinute === null
        || startMinute < 0 || startMinute >= 1440 || endMinute <= startMinute || endMinute > 1440
        || (preferredWeeklyHours !== null && (preferredWeeklyHours < 0 || preferredWeeklyHours > 168))) {
        return problem(422, 'invalid', 'Choose an employee, weekday, and a valid availability window.');
      }

      const employees = await repo.listEmployees(ctx.env.db, ctx.actor.household.id, resolved.business.id);
      if (!employees.some((employee) => employee.id === employeeId)) {
        return problem(404, 'not_found', 'No such employee.');
      }

      const saved = await repo.insertAvailability(ctx.env.db, ctx.actor.household.id, {
        businessId: resolved.business.id,
        employeeId,
        weekday,
        startMinute,
        endMinute,
        available,
        ...(preferredWeeklyHours === null ? {} : { preferredWeeklyHours }),
      });
      return saved === null ? problem(404, 'not_found', 'No such business.') : created(saved);
    }));

  router.post('/api/households/:householdId/business/time-off',
    guard(env, { permission: 'employee.schedule' }, async (ctx) => {
      const resolved = await requireBusiness(ctx);
      if (!resolved.ok) return resolved.reply;

      const employeeId = str(ctx.req.body, 'employeeId', 80);
      const startsAt = instantField(ctx.req.body, 'startsAt', resolved.business.timezone);
      const endsAt = instantField(ctx.req.body, 'endsAt', resolved.business.timezone);
      const reason = optionalStr(ctx.req.body, 'reason', 500);

      if (employeeId === null || startsAt === null || endsAt === null || Date.parse(endsAt) <= Date.parse(startsAt)) {
        return problem(422, 'invalid', 'Choose an employee and a valid time-off window.');
      }
      const employees = await repo.listEmployees(ctx.env.db, ctx.actor.household.id, resolved.business.id);
      if (!employees.some((employee) => employee.id === employeeId)) {
        return problem(404, 'not_found', 'No such employee.');
      }

      const saved = await repo.insertTimeOff(ctx.env.db, ctx.actor.household.id, {
        businessId: resolved.business.id,
        employeeId,
        startsAt,
        endsAt,
        ...(reason === undefined ? {} : { reason }),
      });
      return saved === null ? problem(404, 'not_found', 'No such business.') : created(saved);
    }));

  registerAssistantRoutes(router, env);
}
