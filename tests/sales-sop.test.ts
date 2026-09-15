import { describe, expect, test } from 'vitest';
import {
  InMemorySalesTraceStore,
  SalesSopService,
  type SalesInboundEvent,
} from '../src/sales-sop.js';

const receivedAt = '2026-09-15T08:00:00.000Z';

function makeEvent(
  overrides: Partial<SalesInboundEvent> = {},
): SalesInboundEvent {
  return {
    eventId: 'event-demo-0001',
    customer: {
      customerId: 'customer-demo-001',
      sopDay: 1,
      messageConsent: true,
      tags: [],
    },
    message: { text: '想了解课程链接' },
    receivedAt,
    ...overrides,
  };
}

describe('SalesSopService', () => {
  test('queues an approved, consented welcome template and stores no raw message', () => {
    const service = new SalesSopService(new InMemorySalesTraceStore());
    const result = service.process(makeEvent());

    expect(result.action).toMatchObject({
      kind: 'send_template',
      status: 'queued',
      templateKey: 'welcome_course',
    });
    expect(result.nextCustomerState.tags).toContain('course_interest');
    expect(JSON.stringify(result.trace)).not.toContain('想了解课程链接');
  });

  test('hands off price and negative-sentiment requests before sending a template', () => {
    const service = new SalesSopService(new InMemorySalesTraceStore());
    const result = service.process(
      makeEvent({ message: { text: '多少钱？不想再收到消息了' } }),
    );

    expect(result.action).toMatchObject({
      kind: 'handoff',
      status: 'requires_human',
      reason: 'sensitive_or_commercial_intent',
    });
  });

  test('blocks automated outreach without consent', () => {
    const service = new SalesSopService(new InMemorySalesTraceStore());
    const result = service.process(
      makeEvent({
        customer: {
          customerId: 'customer-demo-001',
          sopDay: 2,
          messageConsent: false,
          tags: [],
        },
      }),
    );

    expect(result.action).toMatchObject({
      kind: 'blocked',
      reason: 'missing_message_consent',
    });
  });

  test('treats a repeated event ID as an idempotent no-op', () => {
    const service = new SalesSopService(new InMemorySalesTraceStore());
    const event = makeEvent();
    service.process(event);
    const repeated = service.process(event);

    expect(repeated).toMatchObject({ duplicate: true });
    expect(repeated.action.reason).toBe('duplicate_event');
  });
});
