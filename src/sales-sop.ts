import crypto from 'node:crypto';
import { getSalesSopPlan, resolveSalesSopStep } from './sales-sop-plan.js';

export type SalesIntent =
  | 'course_interest'
  | 'planning_interest'
  | 'replay_request'
  | 'pricing_or_payment'
  | 'negative_sentiment'
  | 'bypass_risk'
  | 'image_follow_up'
  | 'general_follow_up';

export type SalesActionKind = 'send_template' | 'handoff' | 'blocked';
export type SalesActionStatus =
  | 'queued'
  | 'dispatching'
  | 'sent'
  | 'failed'
  | 'requires_human'
  | 'resolved'
  | 'blocked'
  | 'cancelled';

export interface SalesCustomerState {
  /** A stable opaque ID. Names, phone numbers, and account IDs are excluded. */
  customerId: string;
  sopDay: number;
  messageConsent: boolean;
  tags: string[];
  lastAutomatedTouchAt?: string;
  lastInboundAt?: string;
  nextSopDueAt?: string;
}

export interface SalesInboundEvent {
  /** Idempotency key supplied by Lengshan after it verifies the WeCom event. */
  eventId: string;
  customer: SalesCustomerState;
  message: {
    text: string;
    hasImage?: boolean;
  };
  receivedAt: string;
}

export interface SalesAction {
  id: string;
  eventId: string;
  kind: SalesActionKind;
  status: SalesActionStatus;
  customerId: string;
  templateKey?: string;
  templateVariables?: Record<string, string>;
  /** Demo-only preview. Lengshan must resolve approved template keys itself. */
  content?: string;
  reason: string;
  sopStage?: string;
  leaseUntil?: string;
}

export interface SalesTrace {
  eventId: string;
  inputFingerprint: string;
  customerId: string;
  sopDay: number;
  sopStage?: string;
  intents: SalesIntent[];
  tagsAdded: string[];
  action: Pick<
    SalesAction,
    'kind' | 'status' | 'templateKey' | 'reason' | 'sopStage'
  >;
  policyVersion: string;
  recordedAt: string;
}

export interface SalesSopResult {
  duplicate: boolean;
  nextCustomerState: SalesCustomerState;
  action: SalesAction;
  trace: SalesTrace;
  /** Context that may be injected into a SalesClaw turn by a trusted adapter. */
  agentInstruction: string;
}

export interface SalesDecisionToPersist {
  event: SalesInboundEvent;
  nextCustomerState: SalesCustomerState;
  action: SalesAction;
  trace: SalesTrace;
}

export interface SalesTraceStore {
  hasEvent(eventId: string): boolean;
  save(trace: SalesTrace): void;
  list(): SalesTrace[];
  getCustomer?(customerId: string): SalesCustomerState | null;
  saveDecision?(decision: SalesDecisionToPersist): void;
}

export class InMemorySalesTraceStore implements SalesTraceStore {
  private readonly traces = new Map<string, SalesTrace>();

  hasEvent(eventId: string): boolean {
    return this.traces.has(eventId);
  }

  save(trace: SalesTrace): void {
    this.traces.set(trace.eventId, trace);
  }

  list(): SalesTrace[] {
    return [...this.traces.values()].sort((a, b) =>
      b.recordedAt.localeCompare(a.recordedAt),
    );
  }
}

const MIN_AUTOMATED_TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DEMO_TEMPLATE_CONTENT: Record<string, string> = {
  welcome_course:
    '欢迎参加公开体验课。课程与资料由已审核的 Lengshan 模板配置决定。',
  course_link:
    '已为你匹配课程资料。请由 Lengshan 使用已审核模板和链接完成外发。',
  follow_up: '请由 Lengshan 使用已审核的低打扰跟进模板完成外发。',
};

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function classifyIntent(message: SalesInboundEvent['message']): {
  intents: SalesIntent[];
  tagsAdded: string[];
} {
  const normalized = message.text.trim().toLowerCase();
  const intents: SalesIntent[] = [];
  const tagsAdded: string[] =
    normalized.length > 0 || message.hasImage ? ['replied'] : [];

  if (/(价格|多少钱|付款|优惠|退款|报价)/u.test(normalized)) {
    intents.push('pricing_or_payment');
    tagsAdded.push('pricing_or_payment');
  }
  if (/(投诉|不想|别发|停止|骗子|不满意|退订)/u.test(normalized)) {
    intents.push('negative_sentiment');
    tagsAdded.push('negative_sentiment');
  }
  if (/(私下|加微信|加好友|绕过|其他老师)/u.test(normalized)) {
    intents.push('bypass_risk');
    tagsAdded.push('bypass_risk');
  }
  if (/(回放|录播)/u.test(normalized)) {
    intents.push('replay_request');
    tagsAdded.push('replay_requested');
  }
  if (/(排盘|作业|测评)/u.test(normalized)) {
    intents.push('planning_interest');
    tagsAdded.push('planning_interest');
  }
  if (/(课程|上课|资料|链接|体验课|公开课)/u.test(normalized)) {
    intents.push('course_interest');
    tagsAdded.push('course_interest');
  }
  if (message.hasImage) {
    intents.push('image_follow_up');
    tagsAdded.push('image_received');
  }
  if (intents.length === 0) intents.push('general_follow_up');

  return { intents, tagsAdded: unique(tagsAdded) };
}

function isRecentlyTouched(customer: SalesCustomerState, now: Date): boolean {
  if (!customer.lastAutomatedTouchAt) return false;
  const lastTouch = Date.parse(customer.lastAutomatedTouchAt);
  return (
    Number.isFinite(lastTouch) &&
    now.getTime() - lastTouch < MIN_AUTOMATED_TOUCH_INTERVAL_MS
  );
}

function mergeCustomerState(
  incoming: SalesCustomerState,
  persisted?: SalesCustomerState | null,
): SalesCustomerState {
  if (!persisted) return { ...incoming, tags: unique(incoming.tags) };
  return {
    ...persisted,
    messageConsent: incoming.messageConsent,
    tags: unique([...persisted.tags, ...incoming.tags]),
    lastInboundAt: incoming.lastInboundAt || persisted.lastInboundAt,
  };
}

export function buildSalesAgentInstruction(
  customer: SalesCustomerState,
  intents: SalesIntent[],
): string {
  return [
    'You are a sales-assistance agent operating under a fixed, approved SOP.',
    `Customer state: day=${customer.sopDay}; tags=${customer.tags.join(',') || 'none'}.`,
    `Detected intents: ${intents.join(', ')}.`,
    'Never invent pricing, discounts, guarantees, course outcomes, or links.',
    'Use only the approved template key returned by the SOP engine.',
    'Escalate pricing, payment, complaints, opt-out requests, bypass-risk, and low-confidence cases to a human.',
    'Do not expose customer data, internal reasoning, or connector credentials.',
  ].join('\n');
}

export class SalesSopService {
  constructor(private readonly traceStore: SalesTraceStore) {}

  process(event: SalesInboundEvent): SalesSopResult {
    const now = new Date(event.receivedAt);
    if (Number.isNaN(now.getTime())) {
      throw new Error('receivedAt must be an ISO-8601 timestamp');
    }

    const nextCustomerState = mergeCustomerState(
      event.customer,
      this.traceStore.getCustomer?.(event.customer.customerId),
    );
    nextCustomerState.lastInboundAt = now.toISOString();
    const { intents, tagsAdded } = classifyIntent(event.message);
    nextCustomerState.tags = unique([...nextCustomerState.tags, ...tagsAdded]);
    const agentInstruction = buildSalesAgentInstruction(
      nextCustomerState,
      intents,
    );

    if (this.traceStore.hasEvent(event.eventId)) {
      const action: SalesAction = {
        id: `action-${event.eventId}`,
        eventId: event.eventId,
        kind: 'blocked',
        status: 'blocked',
        customerId: event.customer.customerId,
        reason: 'duplicate_event',
      };
      return {
        duplicate: true,
        nextCustomerState,
        action,
        trace: this.createTrace(
          event,
          nextCustomerState,
          intents,
          tagsAdded,
          action,
          now,
        ),
        agentInstruction,
      };
    }

    const step = resolveSalesSopStep(nextCustomerState.sopDay);
    const plan = getSalesSopPlan();
    const action = this.selectAction(
      nextCustomerState,
      intents,
      event.eventId,
      step,
      now,
    );
    const trace = this.createTrace(
      event,
      nextCustomerState,
      intents,
      tagsAdded,
      action,
      now,
      plan.version,
    );

    const decision: SalesDecisionToPersist = {
      event,
      nextCustomerState,
      action,
      trace,
    };
    if (this.traceStore.saveDecision) this.traceStore.saveDecision(decision);
    else this.traceStore.save(trace);

    return {
      duplicate: false,
      nextCustomerState,
      action,
      trace,
      agentInstruction,
    };
  }

  listTraces(): SalesTrace[] {
    return this.traceStore.list();
  }

  private selectAction(
    customer: SalesCustomerState,
    intents: SalesIntent[],
    eventId: string,
    step: ReturnType<typeof resolveSalesSopStep>,
    now: Date,
  ): SalesAction {
    const base = {
      id: `action-${eventId}`,
      eventId,
      customerId: customer.customerId,
      sopStage: step.stage,
    };
    const needsHuman = intents.some((intent) =>
      ['pricing_or_payment', 'negative_sentiment', 'bypass_risk'].includes(
        intent,
      ),
    );
    if (needsHuman || step.delivery === 'handoff') {
      return {
        ...base,
        kind: 'handoff',
        status: 'requires_human',
        reason: intents.includes('bypass_risk')
          ? 'sensitive_or_risk_intent'
          : needsHuman
            ? 'sensitive_or_commercial_intent'
            : 'sop_human_conversion_stage',
      };
    }
    if (!customer.messageConsent) {
      return {
        ...base,
        kind: 'blocked',
        status: 'blocked',
        reason: 'missing_message_consent',
      };
    }
    if (isRecentlyTouched(customer, now)) {
      return {
        ...base,
        kind: 'blocked',
        status: 'blocked',
        reason: 'automated_touch_rate_limited',
      };
    }
    const missingTags = step.requiresAllTags.filter(
      (tag) => !customer.tags.includes(tag),
    );
    if (missingTags.length > 0) {
      return {
        ...base,
        kind: 'blocked',
        status: 'blocked',
        reason: `sop_condition_not_met:${missingTags.join(',')}`,
      };
    }

    const courseInterest = intents.includes('course_interest');
    const templateKey =
      courseInterest && customer.sopDay > 1 ? 'course_link' : step.templateKey!;
    return {
      ...base,
      kind: 'send_template',
      status: 'queued',
      templateKey,
      templateVariables: {
        sopDay: String(customer.sopDay),
        sopStage: step.stage,
      },
      content: DEMO_TEMPLATE_CONTENT[templateKey],
      reason: 'approved_sop_template',
    };
  }

  private createTrace(
    event: SalesInboundEvent,
    customer: SalesCustomerState,
    intents: SalesIntent[],
    tagsAdded: string[],
    action: SalesAction,
    now: Date,
    policyVersion = getSalesSopPlan().version,
  ): SalesTrace {
    return {
      eventId: event.eventId,
      inputFingerprint: fingerprint(event.message.text),
      customerId: customer.customerId,
      sopDay: customer.sopDay,
      sopStage: action.sopStage,
      intents,
      tagsAdded,
      action: {
        kind: action.kind,
        status: action.status,
        templateKey: action.templateKey,
        reason: action.reason,
        sopStage: action.sopStage,
      },
      policyVersion,
      recordedAt: now.toISOString(),
    };
  }
}
