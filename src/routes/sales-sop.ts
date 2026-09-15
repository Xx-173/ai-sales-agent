import { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from '../web-context.js';
import { adminRoleMiddleware, authMiddleware } from '../middleware/auth.js';
import { verifyLengshanSignature } from '../lengshan-sales-auth.js';
import { getSalesSopPlan } from '../sales-sop-plan.js';
import {
  SalesSopService,
  type SalesInboundEvent,
  type SalesSopResult,
} from '../sales-sop.js';
import { SqliteSalesStore, type SalesActionResult } from '../sales-store.js';

const opaqueId = z.string().min(3).max(128);
const timestamp = z.string().datetime();

const customerSchema = z.object({
  customerId: opaqueId,
  sopDay: z.number().int().min(1).max(20).default(1),
  messageConsent: z.boolean().default(true),
  tags: z.array(z.string().min(1).max(64)).max(50).default([]),
  lastAutomatedTouchAt: timestamp.optional(),
  isNewFriend: z.boolean().optional(),
});

const inboundEventSchema = z.object({
  eventId: z.string().min(8).max(128),
  customer: customerSchema,
  message: z.object({
    text: z.string().max(2_000).default(''),
    hasImage: z.boolean().optional(),
    /** Metadata only. Lengshan owns the remote media URL and original file. */
    mediaTypes: z
      .array(z.enum(['image', 'file', 'audio', 'video']))
      .max(10)
      .optional(),
  }),
  receivedAt: timestamp.optional(),
});

const actionResultSchema = z.object({
  actionId: z.string().min(8).max(180),
  status: z.enum(['sent', 'failed', 'cancelled']),
  deliveredAt: timestamp.optional(),
  providerMessageId: z.string().min(1).max(256).optional(),
  errorCode: z.string().min(1).max(100).optional(),
});

const claimSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});

const dueTickSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  at: timestamp.optional(),
});

const handoffResolutionSchema = z.object({
  resolution: z.string().min(1).max(500),
});

const salesSopRoutes = new Hono<{ Variables: Variables }>();
const salesStore = new SqliteSalesStore();
const salesSopService = new SalesSopService(salesStore);

function normalizeInboundEvent(
  input: z.infer<typeof inboundEventSchema>,
): SalesInboundEvent {
  const tags = input.customer.isNewFriend
    ? [...input.customer.tags, 'new_friend']
    : input.customer.tags;
  return {
    eventId: input.eventId,
    customer: {
      customerId: input.customer.customerId,
      sopDay: input.customer.sopDay,
      messageConsent: input.customer.messageConsent,
      tags: [...new Set(tags)],
      ...(input.customer.lastAutomatedTouchAt
        ? { lastAutomatedTouchAt: input.customer.lastAutomatedTouchAt }
        : {}),
    },
    message: {
      text: input.message.text,
      hasImage:
        input.message.hasImage || input.message.mediaTypes?.includes('image'),
    },
    receivedAt: input.receivedAt || new Date().toISOString(),
  };
}

function toLengshanAction(result: SalesSopResult['action']) {
  return {
    actionId: result.id,
    eventId: result.eventId,
    customerId: result.customerId,
    kind: result.kind,
    status: result.status,
    templateKey: result.templateKey || null,
    templateVariables: result.templateVariables || {},
    reason: result.reason,
    sopStage: result.sopStage || null,
    leaseUntil: result.leaseUntil || null,
  };
}

async function parseSignedJson(
  c: any,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const rawBody = await c.req.text();
  if (rawBody.length > 128 * 1024) {
    return {
      ok: false,
      response: c.json({ error: 'Lengshan payload too large' }, 413),
    };
  }
  const signature = verifyLengshanSignature({
    timestamp: c.req.header('x-lengshan-timestamp'),
    signature: c.req.header('x-lengshan-signature'),
    rawBody,
  });
  if (!signature.ok) {
    return {
      ok: false,
      response: c.json({ error: signature.error }, signature.status),
    };
  }
  try {
    return { ok: true, body: JSON.parse(rawBody) as unknown };
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'Invalid JSON payload' }, 400),
    };
  }
}

// Browser/admin endpoints. They never expose raw Lengshan messages.
salesSopRoutes.get('/policy', authMiddleware, (c) =>
  c.json({
    mode: 'lengshan-ready',
    connector: 'HMAC-signed server-to-server requests',
    outbound: 'persistent outbox; Lengshan claims approved template actions',
    humanHandoff: [
      'pricing_or_payment',
      'negative_sentiment',
      'bypass_risk',
      'conversion_consultation',
      'renewal_consultation',
    ],
    customerData: 'opaque customer IDs, state and message fingerprints only',
    sopPlanVersion: getSalesSopPlan().version,
  }),
);

salesSopRoutes.get('/sop-plan', authMiddleware, (c) =>
  c.json(getSalesSopPlan()),
);

salesSopRoutes.get('/traces', authMiddleware, (c) =>
  c.json({ traces: salesSopService.listTraces() }),
);

salesSopRoutes.get('/metrics', authMiddleware, (c) =>
  c.json(salesStore.metrics()),
);

salesSopRoutes.get('/handoffs', authMiddleware, (c) =>
  c.json({ handoffs: salesStore.listHandoffs() }),
);

salesSopRoutes.post(
  '/handoffs/:actionId/resolve',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = handoffResolutionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid handoff resolution' }, 400);
    }
    const resolved = salesStore.resolveHandoff(
      c.req.param('actionId'),
      parsed.data.resolution,
    );
    return resolved
      ? c.json({ status: 'resolved' })
      : c.json({ error: 'Open handoff not found' }, 404);
  },
);

salesSopRoutes.post(
  '/actions/:actionId/retry',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    const queued = salesStore.retryAction(c.req.param('actionId'));
    return queued
      ? c.json({ status: 'queued' })
      : c.json({ error: 'Failed template action not found' }, 404);
  },
);

/** Retained for authenticated local demonstrations and contract tests. */
salesSopRoutes.post('/events', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = inboundEventSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid sales event', details: parsed.error.flatten() },
      400,
    );
  }
  const result = salesSopService.process(normalizeInboundEvent(parsed.data));
  return c.json(result, result.duplicate ? 200 : 201);
});

// Lengshan server-to-server contract. These routes deliberately bypass browser
// Cookie auth and require a fresh HMAC signature for every request.
salesSopRoutes.post('/lengshan/events', async (c) => {
  const signed = await parseSignedJson(c);
  if (!signed.ok) return signed.response;
  const parsed = inboundEventSchema.safeParse(signed.body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid Lengshan inbound event',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  const result = salesSopService.process(normalizeInboundEvent(parsed.data));
  return c.json(
    {
      duplicate: result.duplicate,
      action: toLengshanAction(result.action),
      customer: result.nextCustomerState,
    },
    result.duplicate ? 200 : 201,
  );
});

salesSopRoutes.post('/lengshan/outbox/claim', async (c) => {
  const signed = await parseSignedJson(c);
  if (!signed.ok) return signed.response;
  const parsed = claimSchema.safeParse(signed.body);
  if (!parsed.success) return c.json({ error: 'Invalid outbox claim' }, 400);
  return c.json({
    actions: salesStore
      .claimOutbox(parsed.data.limit)
      .map((action) => toLengshanAction(action)),
  });
});

salesSopRoutes.post('/lengshan/actions/result', async (c) => {
  const signed = await parseSignedJson(c);
  if (!signed.ok) return signed.response;
  const parsed = actionResultSchema.safeParse(signed.body);
  if (!parsed.success) return c.json({ error: 'Invalid action result' }, 400);
  const result: SalesActionResult = {
    ...parsed.data,
    deliveredAt: parsed.data.deliveredAt || new Date().toISOString(),
  };
  const action = salesStore.recordDelivery(result);
  return action
    ? c.json({ action: toLengshanAction(action) })
    : c.json({ error: 'Claimed action not found' }, 404);
});

salesSopRoutes.post('/lengshan/ticks/due', async (c) => {
  const signed = await parseSignedJson(c);
  if (!signed.ok) return signed.response;
  const parsed = dueTickSchema.safeParse(signed.body);
  if (!parsed.success) return c.json({ error: 'Invalid due tick' }, 400);
  const at = new Date(parsed.data.at || new Date().toISOString());
  const actions = salesStore
    .listDueCustomers(at, parsed.data.limit)
    .map((customer) => {
      const eventId = `schedule:${customer.customerId}:${customer.sopDay}:${at.toISOString().slice(0, 10)}`;
      return salesSopService.process({
        eventId,
        customer,
        message: { text: '' },
        receivedAt: at.toISOString(),
      }).action;
    });
  return c.json({ actions: actions.map(toLengshanAction) });
});

export default salesSopRoutes;
