import fs from 'node:fs';
import path from 'node:path';
import Database from './sqlite-compat.js';
import { STORE_DIR } from './config.js';
import type {
  SalesAction,
  SalesActionStatus,
  SalesCustomerState,
  SalesDecisionToPersist,
  SalesTrace,
  SalesTraceStore,
} from './sales-sop.js';

export type LengshanDeliveryStatus = 'sent' | 'failed' | 'cancelled';

export interface SalesActionResult {
  actionId: string;
  status: LengshanDeliveryStatus;
  deliveredAt: string;
  providerMessageId?: string;
  errorCode?: string;
}

export interface SalesHandoff {
  actionId: string;
  customerId: string;
  sopDay: number;
  sopStage?: string;
  reason: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface SalesMetrics {
  customers: number;
  actions: Record<string, number>;
  openHandoffs: number;
  sentActions: number;
  failedActions: number;
}

interface CustomerRow {
  customer_id: string;
  sop_day: number;
  message_consent: number;
  tags_json: string;
  last_automated_touch_at: string | null;
  last_inbound_at: string | null;
  next_sop_due_at: string | null;
}

interface ActionRow {
  id: string;
  event_id: string;
  customer_id: string;
  kind: SalesAction['kind'];
  status: SalesActionStatus;
  template_key: string | null;
  template_variables_json: string | null;
  reason: string;
  sop_stage: string | null;
  lease_until: string | null;
}

const MAX_OUTBOX_CLAIM = 100;
const OUTBOX_LEASE_MS = 5 * 60 * 1000;

function asStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function asVariables(value: string | null): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return undefined;
  }
}

function toCustomerState(row: CustomerRow): SalesCustomerState {
  return {
    customerId: row.customer_id,
    sopDay: row.sop_day,
    messageConsent: Boolean(row.message_consent),
    tags: asStringArray(row.tags_json),
    ...(row.last_automated_touch_at
      ? { lastAutomatedTouchAt: row.last_automated_touch_at }
      : {}),
    ...(row.last_inbound_at ? { lastInboundAt: row.last_inbound_at } : {}),
    ...(row.next_sop_due_at ? { nextSopDueAt: row.next_sop_due_at } : {}),
  };
}

function toAction(row: ActionRow): SalesAction {
  return {
    id: row.id,
    eventId: row.event_id,
    customerId: row.customer_id,
    kind: row.kind,
    status: row.status,
    ...(row.template_key ? { templateKey: row.template_key } : {}),
    ...(asVariables(row.template_variables_json)
      ? { templateVariables: asVariables(row.template_variables_json) }
      : {}),
    reason: row.reason,
    ...(row.sop_stage ? { sopStage: row.sop_stage } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
  };
}

/**
 * Persistent, privacy-minimised sales state. Raw Lengshan/WeCom messages are
 * deliberately not stored here: only opaque customer IDs and text hashes are
 * durable. Lengshan remains the system of record for channel credentials and
 * message bodies.
 */
export class SqliteSalesStore implements SalesTraceStore {
  private readonly db: InstanceType<typeof Database>;

  constructor(dbPath = path.join(STORE_DIR, 'sales.db')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.createSchema();
  }

  close(): void {
    this.db.close();
  }

  hasEvent(eventId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM sales_events WHERE event_id = ?')
        .get(eventId),
    );
  }

  getCustomer(customerId: string): SalesCustomerState | null {
    const row = this.db
      .prepare(
        `SELECT customer_id, sop_day, message_consent, tags_json,
                last_automated_touch_at, last_inbound_at, next_sop_due_at
         FROM sales_customers WHERE customer_id = ?`,
      )
      .get(customerId) as CustomerRow | undefined;
    return row ? toCustomerState(row) : null;
  }

  save(trace: SalesTrace): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sales_events
          (event_id, customer_id, received_at, input_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        trace.eventId,
        trace.customerId,
        trace.recordedAt,
        trace.inputFingerprint,
        trace.recordedAt,
      );
    this.insertTrace(trace);
  }

  saveDecision(decision: SalesDecisionToPersist): void {
    const persist = this.db.transaction((input: SalesDecisionToPersist) => {
      const eventInserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO sales_events
            (event_id, customer_id, received_at, input_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.event.eventId,
          input.nextCustomerState.customerId,
          input.event.receivedAt,
          input.trace.inputFingerprint,
          input.trace.recordedAt,
        ).changes;
      if (eventInserted === 0) return;

      this.upsertCustomer(input.nextCustomerState);
      this.db
        .prepare(
          `INSERT INTO sales_actions
            (id, event_id, customer_id, kind, status, template_key,
             template_variables_json, reason, sop_stage, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.action.id,
          input.action.eventId,
          input.action.customerId,
          input.action.kind,
          input.action.status,
          input.action.templateKey || null,
          input.action.templateVariables
            ? JSON.stringify(input.action.templateVariables)
            : null,
          input.action.reason,
          input.action.sopStage || null,
          input.trace.recordedAt,
          input.trace.recordedAt,
        );
      this.insertTrace(input.trace);
      if (input.action.kind === 'handoff') {
        this.db
          .prepare(
            `INSERT INTO sales_handoffs
              (action_id, customer_id, sop_day, sop_stage, reason, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'open', ?)`,
          )
          .run(
            input.action.id,
            input.action.customerId,
            input.nextCustomerState.sopDay,
            input.action.sopStage || null,
            input.action.reason,
            input.trace.recordedAt,
          );
      }
    });
    persist(decision);
  }

  list(): SalesTrace[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, input_fingerprint, customer_id, sop_day, sop_stage,
                intents_json, tags_added_json, action_kind, action_status,
                template_key, action_reason, policy_version, recorded_at
         FROM sales_traces ORDER BY recorded_at DESC`,
      )
      .all() as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      eventId: String(row.event_id),
      inputFingerprint: String(row.input_fingerprint),
      customerId: String(row.customer_id),
      sopDay: Number(row.sop_day),
      ...(row.sop_stage ? { sopStage: String(row.sop_stage) } : {}),
      intents: asStringArray(String(row.intents_json)) as SalesTrace['intents'],
      tagsAdded: asStringArray(String(row.tags_added_json)),
      action: {
        kind: String(row.action_kind) as SalesAction['kind'],
        status: String(row.action_status) as SalesActionStatus,
        ...(row.template_key ? { templateKey: String(row.template_key) } : {}),
        reason: String(row.action_reason),
        ...(row.sop_stage ? { sopStage: String(row.sop_stage) } : {}),
      },
      policyVersion: String(row.policy_version),
      recordedAt: String(row.recorded_at),
    }));
  }

  claimOutbox(limit: number, now = new Date()): SalesAction[] {
    const boundedLimit = Math.max(1, Math.min(limit, MAX_OUTBOX_CLAIM));
    const claimed = this.db.transaction((claimLimit: number) => {
      const nowIso = now.toISOString();
      this.db
        .prepare(
          `UPDATE sales_actions SET status = 'queued', lease_until = NULL, updated_at = ?
           WHERE status = 'dispatching' AND lease_until IS NOT NULL AND lease_until <= ?`,
        )
        .run(nowIso, nowIso);
      const rows = this.db
        .prepare(
          `SELECT id, event_id, customer_id, kind, status, template_key,
                  template_variables_json, reason, sop_stage, lease_until
           FROM sales_actions
           WHERE kind = 'send_template' AND status = 'queued'
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(claimLimit) as ActionRow[];
      const leaseUntil = new Date(
        now.getTime() + OUTBOX_LEASE_MS,
      ).toISOString();
      const update = this.db.prepare(
        `UPDATE sales_actions
         SET status = 'dispatching', lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      );
      return rows.flatMap((row) => {
        if (update.run(leaseUntil, nowIso, row.id).changes !== 1) return [];
        return [
          toAction({ ...row, status: 'dispatching', lease_until: leaseUntil }),
        ];
      });
    });
    return claimed(boundedLimit);
  }

  recordDelivery(result: SalesActionResult): SalesAction | null {
    const recorded = this.db.transaction((input: SalesActionResult) => {
      const row = this.db
        .prepare(
          `SELECT id, event_id, customer_id, kind, status, template_key,
                  template_variables_json, reason, sop_stage, lease_until
           FROM sales_actions WHERE id = ?`,
        )
        .get(input.actionId) as ActionRow | undefined;
      if (!row || !['queued', 'dispatching'].includes(row.status)) return null;

      this.db
        .prepare(
          `UPDATE sales_actions
           SET status = ?, lease_until = NULL, provider_message_id = ?,
               delivery_error_code = ?, delivered_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          input.providerMessageId || null,
          input.errorCode || null,
          input.deliveredAt,
          input.deliveredAt,
          input.actionId,
        );

      if (input.status === 'sent' && row.kind === 'send_template') {
        const customer = this.getCustomer(row.customer_id);
        if (customer) {
          const nextDay = Math.min(20, customer.sopDay + 1);
          const nextDueAt =
            customer.sopDay >= 20
              ? null
              : new Date(
                  Date.parse(input.deliveredAt) + 24 * 60 * 60 * 1000,
                ).toISOString();
          this.db
            .prepare(
              `UPDATE sales_customers
               SET sop_day = ?, last_automated_touch_at = ?, next_sop_due_at = ?, updated_at = ?
               WHERE customer_id = ?`,
            )
            .run(
              nextDay,
              input.deliveredAt,
              nextDueAt,
              input.deliveredAt,
              row.customer_id,
            );
        }
      }
      return toAction({ ...row, status: input.status, lease_until: null });
    });
    return recorded(result);
  }

  listDueCustomers(now = new Date(), limit = 100): SalesCustomerState[] {
    const rows = this.db
      .prepare(
        `SELECT customer_id, sop_day, message_consent, tags_json,
                last_automated_touch_at, last_inbound_at, next_sop_due_at
         FROM sales_customers
         WHERE message_consent = 1 AND next_sop_due_at IS NOT NULL
           AND next_sop_due_at <= ? AND sop_day <= 20
         ORDER BY next_sop_due_at ASC LIMIT ?`,
      )
      .all(
        now.toISOString(),
        Math.max(1, Math.min(limit, MAX_OUTBOX_CLAIM)),
      ) as CustomerRow[];
    return rows.map(toCustomerState);
  }

  listHandoffs(limit = 100): SalesHandoff[] {
    const rows = this.db
      .prepare(
        `SELECT action_id, customer_id, sop_day, sop_stage, reason, status,
                created_at, resolved_at, resolution
         FROM sales_handoffs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, MAX_OUTBOX_CLAIM))) as Array<
      Record<string, string | number | null>
    >;
    return rows.map((row) => ({
      actionId: String(row.action_id),
      customerId: String(row.customer_id),
      sopDay: Number(row.sop_day),
      ...(row.sop_stage ? { sopStage: String(row.sop_stage) } : {}),
      reason: String(row.reason),
      status: String(row.status) as SalesHandoff['status'],
      createdAt: String(row.created_at),
      ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
      ...(row.resolution ? { resolution: String(row.resolution) } : {}),
    }));
  }

  resolveHandoff(
    actionId: string,
    resolution: string,
    now = new Date(),
  ): boolean {
    const resolved = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE sales_handoffs
           SET status = 'resolved', resolved_at = ?, resolution = ?
           WHERE action_id = ? AND status = 'open'`,
        )
        .run(now.toISOString(), resolution, actionId).changes;
      if (updated !== 1) return false;
      this.db
        .prepare(
          `UPDATE sales_actions SET status = 'resolved', updated_at = ? WHERE id = ?`,
        )
        .run(now.toISOString(), actionId);
      return true;
    });
    return resolved();
  }

  retryAction(actionId: string, now = new Date()): boolean {
    return (
      this.db
        .prepare(
          `UPDATE sales_actions
           SET status = 'queued', lease_until = NULL, updated_at = ?
           WHERE id = ? AND kind = 'send_template' AND status = 'failed'`,
        )
        .run(now.toISOString(), actionId).changes === 1
    );
  }

  metrics(): SalesMetrics {
    const actionRows = this.db
      .prepare(
        'SELECT status, COUNT(*) AS count FROM sales_actions GROUP BY status',
      )
      .all() as Array<{ status: string; count: number }>;
    const actions = Object.fromEntries(
      actionRows.map((row) => [row.status, row.count]),
    );
    return {
      customers: Number(
        (
          this.db
            .prepare('SELECT COUNT(*) AS count FROM sales_customers')
            .get() as {
            count: number;
          }
        ).count,
      ),
      actions,
      openHandoffs: Number(
        (
          this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM sales_handoffs WHERE status = 'open'",
            )
            .get() as { count: number }
        ).count,
      ),
      sentActions: actions.sent || 0,
      failedActions: actions.failed || 0,
    };
  }

  private upsertCustomer(customer: SalesCustomerState): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sales_customers
          (customer_id, sop_day, message_consent, tags_json,
           last_automated_touch_at, last_inbound_at, next_sop_due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET
           sop_day = excluded.sop_day,
           message_consent = excluded.message_consent,
           tags_json = excluded.tags_json,
           last_automated_touch_at = excluded.last_automated_touch_at,
           last_inbound_at = excluded.last_inbound_at,
           next_sop_due_at = excluded.next_sop_due_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        customer.customerId,
        customer.sopDay,
        customer.messageConsent ? 1 : 0,
        JSON.stringify(customer.tags),
        customer.lastAutomatedTouchAt || null,
        customer.lastInboundAt || null,
        customer.nextSopDueAt || null,
        now,
        now,
      );
  }

  private insertTrace(trace: SalesTrace): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sales_traces
          (event_id, input_fingerprint, customer_id, sop_day, sop_stage,
           intents_json, tags_added_json, action_kind, action_status,
           template_key, action_reason, policy_version, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.eventId,
        trace.inputFingerprint,
        trace.customerId,
        trace.sopDay,
        trace.sopStage || null,
        JSON.stringify(trace.intents),
        JSON.stringify(trace.tagsAdded),
        trace.action.kind,
        trace.action.status,
        trace.action.templateKey || null,
        trace.action.reason,
        trace.policyVersion,
        trace.recordedAt,
      );
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sales_customers (
        customer_id TEXT PRIMARY KEY,
        sop_day INTEGER NOT NULL CHECK (sop_day BETWEEN 1 AND 20),
        message_consent INTEGER NOT NULL CHECK (message_consent IN (0, 1)),
        tags_json TEXT NOT NULL,
        last_automated_touch_at TEXT,
        last_inbound_at TEXT,
        next_sop_due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sales_customers_due
        ON sales_customers(next_sop_due_at);

      CREATE TABLE IF NOT EXISTS sales_events (
        event_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sales_actions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        template_key TEXT,
        template_variables_json TEXT,
        reason TEXT NOT NULL,
        sop_stage TEXT,
        lease_until TEXT,
        provider_message_id TEXT,
        delivery_error_code TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sales_actions_outbox
        ON sales_actions(kind, status, created_at);

      CREATE TABLE IF NOT EXISTS sales_traces (
        event_id TEXT PRIMARY KEY,
        input_fingerprint TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        sop_day INTEGER NOT NULL,
        sop_stage TEXT,
        intents_json TEXT NOT NULL,
        tags_added_json TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        action_status TEXT NOT NULL,
        template_key TEXT,
        action_reason TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sales_traces_customer_recorded
        ON sales_traces(customer_id, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS sales_handoffs (
        action_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        sop_day INTEGER NOT NULL,
        sop_stage TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sales_handoffs_status_created
        ON sales_handoffs(status, created_at DESC);
    `);
  }
}
