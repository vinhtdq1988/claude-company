import { z } from 'zod';
import { memberRefSchema, uuidSchema, type MemberRef } from './common';

const nameSchema = z.string().trim().min(1).max(120);

export const orgUnitKindSchema = z.enum(['division', 'department']);
export type OrgUnitKind = z.infer<typeof orgUnitKindSchema>;

export type Company = {
  id: string;
  name: string;
  timezone: string;
  templateKey: string | null;
  archivedAt: string | null;
};

export type OrgUnit = {
  id: string;
  kind: OrgUnitKind;
  parentId: string | null;
  name: string;
  sortOrder: number;
  archivedAt: string | null;
};

export type Team = {
  id: string;
  orgUnitId: string;
  name: string;
  sortOrder: number;
  archivedAt: string | null;
};

export type TeamMembershipRef = { teamId: string; memberKind: 'ai' | 'human'; memberId: string };

export type OrgChartTeam = Team & {
  managerMemberId: string | null;
  employeeCount: number;
  /** Thành viên hiện tại của team, để màn hình gán thành viên giữ nguyên người đã có khi lưu. */
  members: MemberRef[];
};

export type OrgChartNode = OrgUnit & {
  managerMemberId: string | null;
  /** Nhân viên có `home_org_unit_id` trong đơn vị này hoặc đơn vị con. */
  employeeCount: number;
  teams: OrgChartTeam[];
  children: OrgChartNode[];
};

export type OrgChart = { companyId: string; roots: OrgChartNode[] };

export type UpsertOrgUnitInput = {
  id?: string;
  kind?: OrgUnitKind;
  parentId?: string | null;
  name?: string;
  sortOrder?: number;
};

export type UpsertTeamInput = {
  id?: string;
  orgUnitId?: string;
  name?: string;
  sortOrder?: number;
};

/** Mục cản trở khi archive đơn vị (US1-AS4): chỉ rõ cần xử lý gì trước. */
export type OrgUnitBlockers = {
  childUnits: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; title: string }>;
};

export type TeamBlockers = {
  members: Array<{ kind: 'ai' | 'human'; id: string }>;
  tasks: Array<{ id: string; title: string }>;
};

/** Cây đơn vị của một cơ cấu mẫu. Áp dụng = sao chép thành bản ghi độc lập (FR-003). */
export type OrgTemplateUnit = {
  kind: OrgUnitKind;
  name: string;
  teams?: string[];
  children?: OrgTemplateUnit[];
};

export const orgTemplateUnitSchema: z.ZodType<OrgTemplateUnit> = z.lazy(() =>
  z.object({
    kind: orgUnitKindSchema,
    name: nameSchema,
    teams: z.array(nameSchema).optional(),
    children: z.array(orgTemplateUnitSchema).optional(),
  }),
);

export const orgTemplateDefinitionSchema = z.object({
  units: z.array(orgTemplateUnitSchema).min(1),
});
export type OrgTemplateDefinition = z.infer<typeof orgTemplateDefinitionSchema>;

export type OrgTemplateSummary = { key: string; name: string };

// --- Body của các endpoint Organization (contracts/rest-api.md) ---

export const createCompanySchema = z.object({
  name: nameSchema,
  templateKey: z.string().trim().min(1).max(64).optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const createOrgUnitSchema = z.object({
  kind: orgUnitKindSchema,
  parentId: uuidSchema.nullish(),
  name: nameSchema,
});
export type CreateOrgUnitInput = z.infer<typeof createOrgUnitSchema>;

export const updateOrgUnitSchema = z
  .object({
    name: nameSchema.optional(),
    parentId: uuidSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateOrgUnitInput = z.infer<typeof updateOrgUnitSchema>;

export const createTeamSchema = z.object({ orgUnitId: uuidSchema, name: nameSchema });
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z
  .object({
    name: nameSchema.optional(),
    orgUnitId: uuidSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const setTeamMembersSchema = z.object({
  members: z.array(memberRefSchema).max(200),
});
export type SetTeamMembersInput = z.infer<typeof setTeamMembersSchema>;

export const assignManagerSchema = z.object({
  targetKind: z.enum(['org_unit', 'team']),
  targetId: uuidSchema,
  managerMemberId: uuidSchema,
});
export type AssignManagerInput = z.infer<typeof assignManagerSchema>;
