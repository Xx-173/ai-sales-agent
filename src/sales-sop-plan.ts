import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const stepSchema = z.object({
  day: z.number().int().min(1).max(20),
  stage: z.string().min(1).max(80),
  delivery: z.enum(['send_template', 'handoff']),
  templateKey: z.string().min(1).max(120).optional(),
  requiresAllTags: z.array(z.string().min(1).max(64)).max(20).default([]),
});

const planSchema = z
  .object({
    version: z.string().min(1).max(80),
    steps: z.array(stepSchema).length(20),
  })
  .superRefine((plan, context) => {
    const days = new Set(plan.steps.map((step) => step.day));
    for (let day = 1; day <= 20; day += 1) {
      if (!days.has(day)) {
        context.addIssue({
          code: 'custom',
          message: `Missing SOP step for D${day}`,
        });
      }
    }
    for (const step of plan.steps) {
      if (step.delivery === 'send_template' && !step.templateKey) {
        context.addIssue({
          code: 'custom',
          message: `D${step.day} must define templateKey for send_template`,
        });
      }
    }
  });

export type SalesSopStep = z.infer<typeof stepSchema>;
export type SalesSopPlan = z.infer<typeof planSchema>;

let cachedPlan: {
  path: string;
  modifiedAtMs: number;
  value: SalesSopPlan;
} | null = null;

function resolvePlanPath(): string {
  return path.resolve(
    process.env.AI_SALES_SOP_PLAN_PATH ||
      path.join(process.cwd(), 'config', 'sales-sop-plan.json'),
  );
}

/**
 * The plan is an operator-maintained, versioned JSON file. It intentionally
 * contains only approved template keys and conditions; message text and links
 * stay in the Lengshan template system rather than the Agent runtime.
 */
export function getSalesSopPlan(): SalesSopPlan {
  const planPath = resolvePlanPath();
  const stat = fs.statSync(planPath);
  if (
    cachedPlan &&
    cachedPlan.path === planPath &&
    cachedPlan.modifiedAtMs === stat.mtimeMs
  ) {
    return cachedPlan.value;
  }

  const parsed = planSchema.parse(
    JSON.parse(fs.readFileSync(planPath, 'utf8')) as unknown,
  );
  const value = {
    ...parsed,
    steps: [...parsed.steps].sort((left, right) => left.day - right.day),
  };
  cachedPlan = { path: planPath, modifiedAtMs: stat.mtimeMs, value };
  return value;
}

export function resolveSalesSopStep(day: number): SalesSopStep {
  const step = getSalesSopPlan().steps.find(
    (candidate) => candidate.day === day,
  );
  if (!step) throw new Error(`No configured SOP step for D${day}`);
  return step;
}
