import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type BudgetPolicy,
  type BudgetScopeKind,
  type BudgetService,
  type ConcurrencyLimit,
  type EmployeeEngine,
  type EmployeeProfile,
  type LimitRef,
  type ManagedScope,
  type ModelCatalog,
  type PutBudgetPolicyBody,
  type OrganizationEngine,
  type RequestContext,
  type TaskEngine,
  type UsageRecordInput,
  type UsageSummary,
} from '@claude-company/contracts';
import { newId, type Tx } from '@claude-company/db';
import {
  budgetPolicy,
  budgetReservation,
  budgetWarningLog,
  usageLedger,
} from '@claude-company/db/schema/usage';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AppConfig } from '../config/config';
import { CONFIG } from '../config/infra.providers';
import { EventPublisher } from '../events/event-publisher';
import {
  EMPLOYEE_ENGINE,
  MODEL_CATALOG,
  ORGANIZATION_ENGINE,
  TASK_ENGINE,
} from '../engine-tokens';
import { inTenant } from '../tenancy/tenant-store';
import { periodOf } from './cost';
import { chartHasTeam, findNode, subtreeIds } from './org-tree';

type ScopeRef = { kind: 'company' | 'org_unit' | 'team' | 'ai_employee'; id: string };

/** Giới hạn hiệu lực của một scope sau khi áp mặc định. */
type EffectiveLimit = {
  scope: ScopeRef;
  tokenLimit: number | null;
  costLimit: number | null;
  warnThreshold: number;
};

type Totals = { tokens: number; cost: number };

const EPSILON = 1e-9;

/**
 * Budget Service lõi (R6, Nguyên tắc V): chặn *trước* khi tiêu. `reserve` kiểm tra mọi scope áp dụng cho nhân viên
 * (company → org_unit → team → ai_employee) và trần của task trong một transaction được khóa theo (công ty, kỳ),
 * nên hai run đồng thời không cùng vượt. Công ty chưa có `budget_policy` thì áp hạn mức mặc định từ cấu hình,
 * không bao giờ coi là không giới hạn.
 */
@Injectable()
export class UsageBudgetService implements BudgetService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly moduleRef: ModuleRef,
    @Inject(MODEL_CATALOG) private readonly models: Pick<ModelCatalog, 'hasModel'>,
    private readonly events: EventPublisher,
  ) {}

  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }
  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }
  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }

  async reserve(
    ctx: RequestContext,
    req: {
      runId: string;
      taskId: string;
      employeeId: string;
      modelId: string;
      estTokens: number;
      estCostUsd: number;
    },
  ): ReturnType<BudgetService['reserve']> {
    const employee = await this.employees.get(ctx, req.employeeId);
    const company = await this.organization.getCompany(ctx);
    const period = periodOf(new Date(), company.timezone);
    const scopes = await this.scopesOf(ctx, employee);
    const task = await this.tasks.get(ctx, req.taskId);

    return inTenant(ctx, async (tx) => {
      // Khóa theo (công ty, kỳ): đọc "đã dùng + đang giữ" và ghi reservation là một bước không bị chen ngang.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`budget:${ctx.companyId}:${period}`}, 0))`,
      );
      const limits = await this.effectiveLimits(tx, ctx, scopes);
      let tightest: { ref: LimitRef; remaining: number } | null = null;
      let remainingUsd = Number.POSITIVE_INFINITY;
      let remainingTokens = Number.POSITIVE_INFINITY;

      for (const limit of limits) {
        const totals = await this.scopeTotals(tx, ctx, limit.scope, period);
        if (limit.tokenLimit !== null) {
          const room = limit.tokenLimit - totals.tokens - req.estTokens;
          remainingTokens = Math.min(remainingTokens, limit.tokenLimit - totals.tokens);
          if (room < 0 && (!tightest || room < tightest.remaining)) {
            tightest = {
              remaining: room,
              ref: {
                scopeKind: limit.scope.kind,
                scopeId: limit.scope.id,
                kind: 'tokens',
                limit: limit.tokenLimit,
                used: totals.tokens,
              },
            };
          }
        }
        if (limit.costLimit !== null) {
          const room = limit.costLimit - totals.cost - req.estCostUsd;
          remainingUsd = Math.min(remainingUsd, limit.costLimit - totals.cost);
          if (room < -EPSILON && (!tightest || room < tightest.remaining)) {
            tightest = {
              remaining: room,
              ref: {
                scopeKind: limit.scope.kind,
                scopeId: limit.scope.id,
                kind: 'cost',
                limit: limit.costLimit,
                used: totals.cost,
              },
            };
          }
        }
      }

      // Trần riêng của task (FR-031): đã dùng + đang giữ + ước tính không vượt `token_cap`/`cost_cap`.
      if (task.tokenCap !== null || task.costCap !== null) {
        const used = await this.taskTotals(tx, ctx, req.taskId);
        if (task.tokenCap !== null) {
          const room = task.tokenCap - used.tokens - req.estTokens;
          remainingTokens = Math.min(remainingTokens, task.tokenCap - used.tokens);
          if (room < 0 && (!tightest || room < tightest.remaining)) {
            tightest = {
              remaining: room,
              ref: {
                scopeKind: 'task',
                scopeId: req.taskId,
                kind: 'tokens',
                limit: task.tokenCap,
                used: used.tokens,
              },
            };
          }
        }
        if (task.costCap !== null) {
          const room = task.costCap - used.cost - req.estCostUsd;
          remainingUsd = Math.min(remainingUsd, task.costCap - used.cost);
          if (room < -EPSILON && (!tightest || room < tightest.remaining)) {
            tightest = {
              remaining: room,
              ref: {
                scopeKind: 'task',
                scopeId: req.taskId,
                kind: 'cost',
                limit: task.costCap,
                used: used.cost,
              },
            };
          }
        }
      }

      if (tightest) return { ok: false as const, limitHit: tightest.ref };

      const reservationId = newId();
      await tx.insert(budgetReservation).values({
        id: reservationId,
        companyId: ctx.companyId,
        agentRunId: req.runId,
        taskId: req.taskId,
        aiEmployeeId: req.employeeId,
        scopes,
        period,
        reservedTokens: Math.ceil(req.estTokens),
        reservedCost: String(req.estCostUsd),
        status: 'held',
      });
      return {
        ok: true as const,
        reservationId,
        remainingUsd: Number.isFinite(remainingUsd) ? remainingUsd - req.estCostUsd : Infinity,
        remainingTokens: Number.isFinite(remainingTokens)
          ? remainingTokens - req.estTokens
          : Infinity,
      };
    });
  }

  async commit(
    ctx: RequestContext,
    reservationId: string,
    actual: UsageRecordInput,
  ): Promise<{ warnings: LimitRef[]; overage: boolean }> {
    const employeeReservation = await inTenant(ctx, (tx) =>
      tx
        .select()
        .from(budgetReservation)
        .where(
          and(
            eq(budgetReservation.companyId, ctx.companyId),
            eq(budgetReservation.id, reservationId),
          ),
        ),
    );
    const reservation = employeeReservation[0];
    if (!reservation) throw new DomainError('NOT_FOUND', 'Không tìm thấy reservation');
    const employee = await this.employees.get(ctx, reservation.aiEmployeeId);
    const scopes = reservation.scopes as ScopeRef[];
    const tokens =
      actual.inputTokens + actual.outputTokens + actual.cacheReadTokens + actual.cacheWriteTokens;

    return inTenant(ctx, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`budget:${ctx.companyId}:${reservation.period}`}, 0))`,
      );
      const limits = await this.effectiveLimits(tx, ctx, scopes);

      const [held] = await tx
        .select()
        .from(budgetReservation)
        .where(eq(budgetReservation.id, reservationId))
        .for('update');
      if (!held || held.status === 'released') {
        throw new DomainError('CONFLICT', 'Reservation đã được giải phóng');
      }
      // Một lời gọi đơn lẻ vượt phần đang giữ → ghi overage và để run-loop chặn lượt kế tiếp.
      const overage =
        tokens > held.reservedTokens || actual.costUsd > Number(held.reservedCost) + EPSILON;

      const inserted = await tx
        .insert(usageLedger)
        .values({
          companyId: ctx.companyId,
          agentRunId: held.agentRunId,
          taskId: held.taskId,
          aiEmployeeId: held.aiEmployeeId,
          orgUnitId: employee.homeOrgUnitId,
          teamIds: employee.teamIds,
          modelId: actual.modelId,
          inputTokens: actual.inputTokens,
          outputTokens: actual.outputTokens,
          cacheReadTokens: actual.cacheReadTokens,
          cacheWriteTokens: actual.cacheWriteTokens,
          costUsd: String(actual.costUsd),
          period: held.period,
          providerMessageId: actual.providerMessageId,
          isOverage: overage,
        })
        .onConflictDoNothing({ target: usageLedger.providerMessageId })
        .returning({ id: usageLedger.id });
      // `provider_message_id` đã có: usage này đã được ghi, không trừ reservation hay cảnh báo lần nữa.
      if (inserted.length === 0) return { warnings: [], overage: false };

      const remainingTokens = Math.max(0, held.reservedTokens - tokens);
      const remainingCost = Math.max(0, Number(held.reservedCost) - actual.costUsd);
      await tx
        .update(budgetReservation)
        .set({
          reservedTokens: remainingTokens,
          reservedCost: String(remainingCost),
          status: remainingTokens === 0 && remainingCost <= EPSILON ? 'committed' : 'held',
        })
        .where(eq(budgetReservation.id, reservationId));

      // Cảnh báo khi mức dùng (đã dùng, không tính phần giữ) đạt ngưỡng (R6). Mỗi (phạm vi, kỳ, loại, giới hạn,
      // ngưỡng) chỉ cảnh báo một lần nhờ `budget_warning_log`: chen ngang, giao lại, hay hạ ngưỡng xuống dưới mức
      // đang dùng đều không sinh cảnh báo trùng, còn đổi giới hạn hoặc ngưỡng thì được cảnh báo lại.
      const warnings: LimitRef[] = [];
      for (const limit of limits) {
        const used = await this.ledgerTotals(tx, ctx, limit.scope, held.period);
        const candidates: Array<{ kind: 'tokens' | 'cost'; limit: number | null; used: number }> = [
          { kind: 'tokens', limit: limit.tokenLimit, used: used.tokens },
          { kind: 'cost', limit: limit.costLimit, used: used.cost },
        ];
        for (const c of candidates) {
          if (c.limit === null || c.limit <= 0) continue;
          if (!reachedThreshold(c.used, c.limit, limit.warnThreshold)) continue;
          const first = await tx
            .insert(budgetWarningLog)
            .values({
              companyId: ctx.companyId,
              scopeKind: limit.scope.kind,
              scopeId: limit.scope.id,
              period: held.period,
              metric: c.kind,
              limitValue: String(c.limit),
              threshold: String(limit.warnThreshold),
            })
            .onConflictDoNothing()
            .returning({ id: budgetWarningLog.id });
          if (first.length === 0) continue;
          warnings.push({
            scopeKind: limit.scope.kind,
            scopeId: limit.scope.id,
            kind: c.kind,
            limit: c.limit,
            used: c.used,
          });
        }
      }
      return { warnings, overage };
    });
  }

  async release(ctx: RequestContext, reservationId: string): Promise<void> {
    await inTenant(ctx, (tx) =>
      tx
        .update(budgetReservation)
        .set({ status: 'released', reservedTokens: 0, reservedCost: '0' })
        .where(
          and(
            eq(budgetReservation.companyId, ctx.companyId),
            eq(budgetReservation.id, reservationId),
            eq(budgetReservation.status, 'held'),
          ),
        ),
    );
  }

  async releaseRun(ctx: RequestContext, runId: string): Promise<void> {
    await inTenant(ctx, (tx) =>
      tx
        .update(budgetReservation)
        .set({ status: 'released', reservedTokens: 0, reservedCost: '0' })
        .where(
          and(
            eq(budgetReservation.companyId, ctx.companyId),
            eq(budgetReservation.agentRunId, runId),
            eq(budgetReservation.status, 'held'),
          ),
        ),
    );
  }

  /** Model phải thuộc `allowed_models` của mọi scope có khai báo (US6-AS5). Scope không khai báo thì không hạn chế. */
  async isModelAllowed(ctx: RequestContext, employeeId: string, modelId: string): Promise<boolean> {
    const employee = await this.employees.get(ctx, employeeId);
    const allowed = await this.allowedModelsOf(ctx, await this.scopesOf(ctx, employee));
    return allowed === null || allowed.includes(modelId);
  }

  async allowedModelsFor(
    ctx: RequestContext,
    target: { homeOrgUnitId: string; teamIds?: string[]; employeeId?: string },
  ): Promise<string[] | null> {
    const chain = await this.organization.resolveOrgUnitChain(ctx, target.homeOrgUnitId);
    const scopes: ScopeRef[] = [
      { kind: 'company', id: ctx.companyId },
      ...chain.map((id) => ({ kind: 'org_unit' as const, id })),
      ...(target.teamIds ?? []).map((id) => ({ kind: 'team' as const, id })),
      ...(target.employeeId ? [{ kind: 'ai_employee' as const, id: target.employeeId }] : []),
    ];
    return this.allowedModelsOf(ctx, scopes);
  }

  async getConcurrencyLimits(ctx: RequestContext, employeeId: string): Promise<ConcurrencyLimit[]> {
    const employee = await this.employees.get(ctx, employeeId);
    const applicable = new Set((await this.scopesOf(ctx, employee)).map(key));
    const rows = await inTenant(ctx, (tx) =>
      tx.select().from(budgetPolicy).where(eq(budgetPolicy.companyId, ctx.companyId)),
    );
    return rows.flatMap((r) =>
      r.maxConcurrentTasks !== null &&
      r.scopeKind !== 'ai_employee' &&
      applicable.has(`${r.scopeKind}:${r.scopeId}`)
        ? [{ scopeKind: r.scopeKind, scopeId: r.scopeId, max: r.maxConcurrentTasks }]
        : [],
    );
  }

  // --- chính sách theo phạm vi (T168, T171) ---

  /** Chính sách của một phạm vi; chưa có bản ghi thì trả mặc định (`isDefault`). */
  async getPolicy(
    ctx: RequestContext,
    scopeKind: BudgetScopeKind,
    scopeId: string,
  ): Promise<BudgetPolicy> {
    await this.assertScopeExists(ctx, scopeKind, scopeId);
    const [row] = await inTenant(ctx, (tx) =>
      tx
        .select()
        .from(budgetPolicy)
        .where(
          and(
            eq(budgetPolicy.companyId, ctx.companyId),
            eq(budgetPolicy.scopeKind, scopeKind),
            eq(budgetPolicy.scopeId, scopeId),
          ),
        ),
    );
    if (!row) {
      const company = scopeKind === 'company';
      return {
        scopeKind,
        scopeId,
        monthlyTokenLimit: company ? this.config.DEFAULT_MONTHLY_TOKEN_LIMIT : null,
        monthlyCostLimit: company ? this.config.DEFAULT_MONTHLY_COST_LIMIT_USD : null,
        maxConcurrentTasks: null,
        allowedModels: null,
        warnThreshold: this.config.BUDGET_WARN_THRESHOLD,
        isDefault: true,
      };
    }
    return toPolicy(row);
  }

  /**
   * Thay chính sách của một phạm vi (PUT). Phạm vi `ai_employee` không nhận `maxConcurrentTasks`. Công ty luôn có
   * giới hạn token và chi phí (Nguyên tắc V): bỏ trống thì giữ giá trị hiện có hoặc mặc định, đặt `null` bị từ chối.
   * Ngưỡng cảnh báo bỏ trống thì giữ giá trị hiện có.
   */
  async upsertPolicy(
    ctx: RequestContext,
    scopeKind: BudgetScopeKind,
    scopeId: string,
    body: PutBudgetPolicyBody,
  ): Promise<BudgetPolicy> {
    if (scopeKind === 'ai_employee' && body.maxConcurrentTasks !== undefined) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Giới hạn đồng thời của nhân viên đặt qua PATCH /employees/{id}',
        { field: 'maxConcurrentTasks' },
      );
    }
    const current = await this.getPolicy(ctx, scopeKind, scopeId);
    const company = scopeKind === 'company';
    if (company) {
      for (const field of ['monthlyTokenLimit', 'monthlyCostLimit'] as const) {
        if (body[field] === null) {
          throw new DomainError('VALIDATION_FAILED', 'Công ty luôn phải có giới hạn token và chi phí', {
            field,
          });
        }
      }
    }
    for (const modelId of body.allowedModels ?? []) {
      if (!(await this.models.hasModel(modelId))) {
        throw new DomainError('VALIDATION_FAILED', 'Model không có trong danh mục cấu hình', {
          field: 'allowedModels',
          modelId,
        });
      }
    }

    const tokenLimit = company
      ? (body.monthlyTokenLimit ?? current.monthlyTokenLimit)
      : (body.monthlyTokenLimit ?? null);
    const costLimit = company
      ? (body.monthlyCostLimit ?? current.monthlyCostLimit)
      : (body.monthlyCostLimit ?? null);
    const stored = {
      monthlyTokenLimit: tokenLimit,
      monthlyCostLimit: costLimit === null ? null : String(costLimit),
      maxConcurrentTasks: scopeKind === 'ai_employee' ? null : (body.maxConcurrentTasks ?? null),
      allowedModels: body.allowedModels ?? null,
      warnThreshold: String(body.warnThreshold ?? current.warnThreshold),
    };
    const [row] = await inTenant(ctx, async (tx) => {
      const [saved] = await tx
        .insert(budgetPolicy)
        .values({ id: newId(), companyId: ctx.companyId, scopeKind, scopeId, ...stored })
        .onConflictDoUpdate({
          target: [budgetPolicy.companyId, budgetPolicy.scopeKind, budgetPolicy.scopeId],
          set: stored,
        })
        .returning();
      // Điều phối lập lịch lại task đang chờ slot khi giới hạn đồng thời được nới (T170, T174).
      await this.events.publish(tx, ctx, {
        type: 'budget.policy_changed',
        aggregateKind: 'budget_policy',
        aggregateId: scopeId,
        payload: { scopeKind, scopeId },
      });
      return [saved];
    });
    if (!row) throw new Error('Không lưu được chính sách ngân sách');
    return toPolicy(row);
  }

  async getUsage(
    ctx: RequestContext,
    filter: {
      employeeId?: string;
      taskId?: string;
      runId?: string;
      orgUnitId?: string;
      period?: string;
      groupBy?: 'employee' | 'task' | 'org_unit';
      scope?: ManagedScope;
    },
  ): Promise<UsageSummary> {
    const company = await this.organization.getCompany(ctx);
    // Theo task hoặc run thì cộng dồn mọi kỳ (trần `token_cap`/`cost_cap` áp cho cả vòng đời task).
    const period =
      filter.period ??
      (filter.taskId || filter.runId ? 'all' : periodOf(new Date(), company.timezone));
    let orgUnitIds: string[] | undefined;
    if (filter.orgUnitId) {
      const chart = await this.organization.getOrgChart(ctx);
      const node = findNode(chart.roots, filter.orgUnitId);
      orgUnitIds = node ? subtreeIds(node) : [];
    }
    const conditions = [eq(usageLedger.companyId, ctx.companyId)];
    if (period !== 'all') conditions.push(eq(usageLedger.period, period));
    if (filter.employeeId) conditions.push(eq(usageLedger.aiEmployeeId, filter.employeeId));
    if (filter.taskId) conditions.push(eq(usageLedger.taskId, filter.taskId));
    if (filter.runId) conditions.push(eq(usageLedger.agentRunId, filter.runId));
    if (orgUnitIds) {
      if (orgUnitIds.length === 0) return { period, tokens: 0, costUsd: 0, groups: [] };
      conditions.push(inArray(usageLedger.orgUnitId, orgUnitIds));
    }
    // Manager chỉ thấy chi tiêu của nhân viên trong phạm vi, kể cả nhân viên đã lưu trữ thuộc đơn vị mình quản lý
    // (ledger lưu đơn vị nhà tại thời điểm ghi).
    if (filter.scope && !filter.scope.companyWide) {
      const parts: SQL[] = [];
      if (filter.scope.employeeIds.length > 0) {
        parts.push(inArray(usageLedger.aiEmployeeId, filter.scope.employeeIds));
      }
      if (filter.scope.orgUnitIds.length > 0) {
        parts.push(inArray(usageLedger.orgUnitId, filter.scope.orgUnitIds));
      }
      if (parts.length === 0) return { period, tokens: 0, costUsd: 0, groups: [] };
      conditions.push(or(...parts) as SQL);
    }

    const tokensExpr = sql<string>`coalesce(sum(${usageLedger.inputTokens} + ${usageLedger.outputTokens} + ${usageLedger.cacheReadTokens} + ${usageLedger.cacheWriteTokens}), 0)`;
    const costExpr = sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)`;
    return inTenant(ctx, async (tx) => {
      const [total] = await tx
        .select({ tokens: tokensExpr, cost: costExpr })
        .from(usageLedger)
        .where(and(...conditions));
      const groupColumn =
        filter.groupBy === 'employee'
          ? usageLedger.aiEmployeeId
          : filter.groupBy === 'task'
            ? usageLedger.taskId
            : filter.groupBy === 'org_unit'
              ? usageLedger.orgUnitId
              : null;
      const groups = groupColumn
        ? await tx
            .select({ key: groupColumn, tokens: tokensExpr, cost: costExpr })
            .from(usageLedger)
            .where(and(...conditions))
            .groupBy(groupColumn)
        : [];
      return {
        period,
        tokens: Number(total?.tokens ?? 0),
        costUsd: Number(total?.cost ?? 0),
        groups: groups.map((g) => ({
          key: String(g.key),
          tokens: Number(g.tokens),
          costUsd: Number(g.cost),
        })),
      };
    });
  }

  // --- nội bộ ---

  /** Giao các `allowed_models` đã khai báo ở các scope; `null` nếu không scope nào khai báo. */
  private async allowedModelsOf(
    ctx: RequestContext,
    scopes: readonly ScopeRef[],
  ): Promise<string[] | null> {
    const rows = await inTenant(ctx, (tx) =>
      tx
        .select({
          kind: budgetPolicy.scopeKind,
          id: budgetPolicy.scopeId,
          allowed: budgetPolicy.allowedModels,
        })
        .from(budgetPolicy)
        .where(eq(budgetPolicy.companyId, ctx.companyId)),
    );
    const applicable = new Set(scopes.map(key));
    const lists = rows
      .filter((r) => applicable.has(`${r.kind}:${r.id}`) && r.allowed !== null)
      .map((r) => r.allowed as string[]);
    if (lists.length === 0) return null;
    return lists.reduce((acc, list) => acc.filter((m) => list.includes(m)));
  }

  /** Phạm vi phải tồn tại và còn hoạt động trong công ty của người gọi. */
  private async assertScopeExists(
    ctx: RequestContext,
    scopeKind: BudgetScopeKind,
    scopeId: string,
  ): Promise<void> {
    const missing = () => new DomainError('NOT_FOUND', 'Không tìm thấy phạm vi');
    switch (scopeKind) {
      case 'company':
        if (scopeId !== ctx.companyId) throw missing();
        return;
      case 'org_unit':
        if (!(await this.organization.getOrgUnit(ctx, scopeId))) throw missing();
        return;
      case 'team': {
        const chart = await this.organization.getOrgChart(ctx);
        if (!chartHasTeam(chart.roots, scopeId)) throw missing();
        return;
      }
      case 'ai_employee': {
        const employee = await this.employees.get(ctx, scopeId).catch(() => null);
        if (!employee || employee.status === 'archived') throw missing();
        return;
      }
    }
  }

  /** Scope áp dụng cho nhân viên: company, đơn vị nhà và tổ tiên, các team, chính nhân viên. */
  private async scopesOf(ctx: RequestContext, employee: EmployeeProfile): Promise<ScopeRef[]> {
    const chain = await this.organization.resolveOrgUnitChain(ctx, employee.homeOrgUnitId);
    return [
      { kind: 'company', id: ctx.companyId },
      ...chain.map((id) => ({ kind: 'org_unit' as const, id })),
      ...employee.teamIds.map((id) => ({ kind: 'team' as const, id })),
      { kind: 'ai_employee', id: employee.id },
    ];
  }

  /** Giới hạn của từng scope; công ty không có policy thì dùng mặc định từ cấu hình (không bao giờ vô hạn). */
  private async effectiveLimits(
    tx: Tx,
    ctx: RequestContext,
    scopes: readonly ScopeRef[],
  ): Promise<EffectiveLimit[]> {
    const rows = await tx
      .select()
      .from(budgetPolicy)
      .where(eq(budgetPolicy.companyId, ctx.companyId));
    const byScope = new Map(rows.map((r) => [`${r.scopeKind}:${r.scopeId}`, r]));
    const limits: EffectiveLimit[] = [];
    for (const scope of scopes) {
      const row = byScope.get(key(scope));
      if (scope.kind === 'company') {
        limits.push({
          scope,
          tokenLimit: row ? (row.monthlyTokenLimit ?? null) : this.config.DEFAULT_MONTHLY_TOKEN_LIMIT,
          costLimit: row
            ? row.monthlyCostLimit === null
              ? null
              : Number(row.monthlyCostLimit)
            : this.config.DEFAULT_MONTHLY_COST_LIMIT_USD,
          warnThreshold: row ? Number(row.warnThreshold) : this.config.BUDGET_WARN_THRESHOLD,
        });
        continue;
      }
      if (!row) continue;
      limits.push({
        scope,
        tokenLimit: row.monthlyTokenLimit ?? null,
        costLimit: row.monthlyCostLimit === null ? null : Number(row.monthlyCostLimit),
        warnThreshold: Number(row.warnThreshold),
      });
    }
    return limits;
  }

  /** Đã dùng (ledger) + đang giữ (reservation `held`) của một scope trong kỳ. */
  private async scopeTotals(
    tx: Tx,
    ctx: RequestContext,
    scope: ScopeRef,
    period: string,
  ): Promise<Totals> {
    const spent = await this.ledgerTotals(tx, ctx, scope, period);
    const scopeJson = JSON.stringify([{ kind: scope.kind, id: scope.id }]);
    const [held] = await tx
      .select({
        tokens: sql<string>`coalesce(sum(${budgetReservation.reservedTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${budgetReservation.reservedCost}), 0)`,
      })
      .from(budgetReservation)
      .where(
        and(
          eq(budgetReservation.companyId, ctx.companyId),
          eq(budgetReservation.period, period),
          eq(budgetReservation.status, 'held'),
          sql`${budgetReservation.scopes} @> ${scopeJson}::jsonb`,
        ),
      );
    return {
      tokens: spent.tokens + Number(held?.tokens ?? 0),
      cost: spent.cost + Number(held?.cost ?? 0),
    };
  }

  private async ledgerTotals(
    tx: Tx,
    ctx: RequestContext,
    scope: ScopeRef,
    period: string,
  ): Promise<Totals> {
    const conditions = [eq(usageLedger.companyId, ctx.companyId), eq(usageLedger.period, period)];
    if (scope.kind === 'ai_employee') conditions.push(eq(usageLedger.aiEmployeeId, scope.id));
    if (scope.kind === 'team') conditions.push(sql`${scope.id}::uuid = any(${usageLedger.teamIds})`);
    if (scope.kind === 'org_unit') {
      // Ledger lưu đơn vị nhà (department); scope có thể là division nên mở rộng ra mọi đơn vị con.
      const chart = await this.organization.getOrgChart(ctx);
      const node = findNode(chart.roots, scope.id);
      const ids = node ? subtreeIds(node) : [scope.id];
      conditions.push(inArray(usageLedger.orgUnitId, ids));
    }
    const [row] = await tx
      .select({
        tokens: sql<string>`coalesce(sum(${usageLedger.inputTokens} + ${usageLedger.outputTokens} + ${usageLedger.cacheReadTokens} + ${usageLedger.cacheWriteTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)`,
      })
      .from(usageLedger)
      .where(and(...conditions));
    return { tokens: Number(row?.tokens ?? 0), cost: Number(row?.cost ?? 0) };
  }

  private async taskTotals(tx: Tx, ctx: RequestContext, taskId: string): Promise<Totals> {
    const [spent] = await tx
      .select({
        tokens: sql<string>`coalesce(sum(${usageLedger.inputTokens} + ${usageLedger.outputTokens} + ${usageLedger.cacheReadTokens} + ${usageLedger.cacheWriteTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)`,
      })
      .from(usageLedger)
      .where(and(eq(usageLedger.companyId, ctx.companyId), eq(usageLedger.taskId, taskId)));
    const [held] = await tx
      .select({
        tokens: sql<string>`coalesce(sum(${budgetReservation.reservedTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${budgetReservation.reservedCost}), 0)`,
      })
      .from(budgetReservation)
      .where(
        and(
          eq(budgetReservation.companyId, ctx.companyId),
          eq(budgetReservation.taskId, taskId),
          eq(budgetReservation.status, 'held'),
        ),
      );
    return {
      tokens: Number(spent?.tokens ?? 0) + Number(held?.tokens ?? 0),
      cost: Number(spent?.cost ?? 0) + Number(held?.cost ?? 0),
    };
  }
}

function key(scope: ScopeRef): string {
  return `${scope.kind}:${scope.id}`;
}

function toPolicy(row: typeof budgetPolicy.$inferSelect): BudgetPolicy {
  return {
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    monthlyTokenLimit: row.monthlyTokenLimit ?? null,
    monthlyCostLimit: row.monthlyCostLimit === null ? null : Number(row.monthlyCostLimit),
    maxConcurrentTasks: row.maxConcurrentTasks ?? null,
    allowedModels: row.allowedModels ?? null,
    warnThreshold: Number(row.warnThreshold),
    isDefault: false,
  };
}

/** Đã dùng ≥ `limit × threshold` (dung sai số học cho chi phí thập phân). */
function reachedThreshold(used: number, limit: number, threshold: number): boolean {
  return used >= limit * threshold - EPSILON;
}
