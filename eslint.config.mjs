// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Engine trong apps/api/src/engines/<tên> và schema bảng do engine đó sở hữu (packages/db/src/schema/<tên>.ts).
// Engine chỉ giao tiếp với engine khác qua @claude-company/contracts (Nguyên tắc VI).
const ENGINE_SCHEMAS = {
  organization: ['organization'],
  employee: ['employee'],
  task: ['task'],
  orchestration: ['orchestration'],
  memory: ['memory'],
  communication: ['communication'],
  permission: ['permission'],
  gamification: ['gamification'],
  'office-simulation': ['office'],
};
const ALL_SCHEMAS = Object.values(ENGINE_SCHEMAS).flat();

const ANTHROPIC = {
  group: ['@anthropic-ai/*'],
  message:
    'Chỉ packages/model-gateway/src/providers/** được import @anthropic-ai/* (Nguyên tắc VI).',
};
const PIXI = {
  group: ['pixi.js', 'pixi.js/*', '@pixi/*'],
  message:
    'Chỉ apps/web/src/office/renderer-pixi/** được import pixi.js (renderer có thể thay thế).',
};
const AUTH_SCHEMA = {
  group: ['@claude-company/db/schema/auth', '**/schema/auth', '**/schema/auth.ts'],
  message: 'Bảng user chỉ do apps/api/src/platform/auth/** truy cập (IdentityDirectory).',
};
const ANY_SCHEMA = {
  group: ['@claude-company/db/schema', '@claude-company/db/schema/*', '**/db/src/schema/*'],
  message: 'apps/worker chỉ gọi interface engine, không import schema bảng.',
};

/** @param {string} engine */
const otherEngines = (engine) =>
  Object.keys(ENGINE_SCHEMAS)
    .filter((e) => e !== engine)
    .map((e) => ({
      group: [`**/engines/${e}/**`, `../${e}`, `../${e}/**`, `../../${e}`, `../../${e}/**`],
      message: `Engine ${engine} không import nội bộ của engine ${e}; dùng interface trong @claude-company/contracts.`,
    }));

/** @param {string} engine */
const foreignSchemas = (engine) =>
  ALL_SCHEMAS.filter((s) => !(ENGINE_SCHEMAS[engine] ?? []).includes(s)).map((s) => ({
    group: [`@claude-company/db/schema/${s}`, `**/schema/${s}`, `**/schema/${s}.ts`],
    message: `Engine ${engine} chỉ import schema bảng do mình sở hữu.`,
  }));

/** @param {object[]} patterns */
const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/*.d.ts',
    'packages/db/migrations/**',
    'ref/**',
    '.specify/**',
    '.claude/**',
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Mặc định: cấm @anthropic-ai/*, pixi.js và schema auth.
  {
    files: ['**/*.{ts,tsx,mts}'],
    rules: restrict([ANTHROPIC, PIXI, AUTH_SCHEMA]),
  },

  // Provider là nơi duy nhất được import SDK Anthropic.
  {
    files: ['packages/model-gateway/src/providers/**'],
    rules: restrict([PIXI, AUTH_SCHEMA]),
  },

  // Renderer PixiJS là nơi duy nhất được import pixi.js.
  {
    files: ['apps/web/src/office/renderer-pixi/**'],
    rules: restrict([ANTHROPIC, AUTH_SCHEMA]),
  },

  // platform/auth là nơi duy nhất được import schema auth.
  {
    files: ['apps/api/src/platform/auth/**'],
    rules: restrict([ANTHROPIC, PIXI]),
  },

  // Worker không import schema bảng, chỉ gọi interface engine.
  {
    files: ['apps/worker/**/*.ts'],
    rules: restrict([ANTHROPIC, PIXI, AUTH_SCHEMA, ANY_SCHEMA]),
  },

  // Mỗi engine: không import nội bộ engine khác, chỉ import schema do mình sở hữu.
  ...Object.keys(ENGINE_SCHEMAS).map((engine) => ({
    files: [`apps/api/src/engines/${engine}/**/*.ts`],
    rules: restrict([
      ANTHROPIC,
      PIXI,
      AUTH_SCHEMA,
      ...otherEngines(engine),
      ...foreignSchemas(engine),
    ]),
  })),

  // Test được truy cập schema để dựng dữ liệu và kiểm tra RLS.
  {
    files: ['tests/**/*.ts'],
    rules: restrict([ANTHROPIC, PIXI]),
  },

  // Service Docker viết bằng Node thuần (.mjs), không qua TypeScript: khai báo global của Node.
  {
    files: ['docker/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
      },
    },
  },

  // NestJS DI đọc kiểu tham số constructor qua emitDecoratorMetadata nên import class phải là import giá trị;
  // `import type` (kể cả do autofix) làm mất metadata và DI không inject được.
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
]);
