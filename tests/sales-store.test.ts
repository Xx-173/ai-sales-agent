import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SalesSopService, type SalesInboundEvent } from '../src/sales-sop.js';
import { SqliteSalesStore } from '../src/sales-store.js';

const temporaryDirectories: string[] = [];

function createStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-sales-store-'));
  temporaryDirectories.push(directory);
  return new SqliteSalesStore(path.join(directory, 'sales.db'));
}

function event(
  eventId: string,
  overrides: Partial<SalesInboundEvent> = {},
): SalesInboundEvent {
  return {
    eventId,
    customer: {
      customerId: 'customer-opaque-001',
      sopDay: 1,
      messageConsent: true,
      tags: [],
    },
    message: { text: '我想了解体验课' },
    receivedAt: '2026-09-15T08:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('SqliteSalesStore', () => {
  test('persists the outbox and advances a customer only after Lengshan reports sent', () => {
    const store = createStore();
    const service = new SalesSopService(store);
    const decision = service.process(event('lengshan-event-0001'));

    expect(decision.action).toMatchObject({
      kind: 'send_template',
      status: 'queued',
      templateKey: 'welcome_course',
    });
    expect(store.getCustomer('customer-opaque-001')?.sopDay).toBe(1);

    const [claimed] = store.claimOutbox(
      10,
      new Date('2026-09-15T08:01:00.000Z'),
    );
    expect(claimed).toMatchObject({
      id: decision.action.id,
      status: 'dispatching',
    });
    store.recordDelivery({
      actionId: decision.action.id,
      status: 'sent',
      deliveredAt: '2026-09-15T08:02:00.000Z',
      providerMessageId: 'lengshan-message-001',
    });

    expect(store.getCustomer('customer-opaque-001')).toMatchObject({
      sopDay: 2,
      lastAutomatedTouchAt: '2026-09-15T08:02:00.000Z',
    });
    store.close();
  });

  test('persists sensitive intent as an open human handoff without an outbox item', () => {
    const store = createStore();
    const service = new SalesSopService(store);
    const decision = service.process(
      event('lengshan-event-0002', { message: { text: '课程多少钱？' } }),
    );

    expect(decision.action).toMatchObject({
      kind: 'handoff',
      status: 'requires_human',
    });
    expect(store.claimOutbox(10)).toEqual([]);
    expect(store.listHandoffs()).toHaveLength(1);
    expect(store.resolveHandoff(decision.action.id, '由人工跟进报价咨询')).toBe(
      true,
    );
    expect(store.listHandoffs()[0]).toMatchObject({ status: 'resolved' });
    store.close();
  });
});
