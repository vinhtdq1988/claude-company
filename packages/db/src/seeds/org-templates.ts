import { orgTemplateDefinitionSchema, type OrgTemplateDefinition } from '@claude-company/contracts';
import { orgTemplate } from '../schema/organization';
import type { Seeder } from '../seed';

type TemplateSeed = { key: string; name: string; definition: OrgTemplateDefinition };

/** Cơ cấu mẫu chỉ là điểm khởi đầu: áp dụng sẽ sao chép thành bản ghi độc lập (FR-003). */
export const orgTemplates: readonly TemplateSeed[] = [
  {
    key: 'software_company',
    name: 'Công ty phần mềm',
    definition: {
      units: [
        { kind: 'department', name: 'Development' },
        { kind: 'department', name: 'BA' },
        { kind: 'department', name: 'QA' },
      ],
    },
  },
];

export const orgTemplateSeeder: Seeder = {
  name: 'org-templates',
  async run(db) {
    for (const template of orgTemplates) {
      const definition = orgTemplateDefinitionSchema.parse(template.definition);
      await db
        .insert(orgTemplate)
        .values({ key: template.key, name: template.name, definition })
        .onConflictDoUpdate({
          target: orgTemplate.key,
          set: { name: template.name, definition, updatedAt: new Date() },
        });
    }
  },
};
