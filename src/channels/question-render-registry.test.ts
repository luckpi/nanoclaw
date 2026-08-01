import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createPendingApproval } from '../db/sessions.js';
import { registerQuestionRenderResolver, resolveQuestionRender } from './question-render-registry.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('question render resolver registry', () => {
  it('runs module resolvers in registration order and stops on the first result', () => {
    const order: string[] = [];
    const later = vi.fn(() => undefined);
    const expected = {
      title: 'Module question',
      options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
    };

    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      order.push('first');
      return undefined;
    });
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      order.push('second');
      return expected;
    });
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      later();
      return undefined;
    });

    expect(resolveQuestionRender('module-order-question')).toBe(expected);
    expect(order).toEqual(['first', 'second']);
    expect(later).not.toHaveBeenCalled();
  });

  it('uses the existing database lookup as the final built-in fallback', () => {
    createPendingApproval({
      approval_id: 'built-in-render-question',
      request_id: 'request-1',
      action: 'test-action',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Built-in approval',
      options_json: JSON.stringify([{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }]),
    });

    expect(resolveQuestionRender('built-in-render-question')).toEqual({
      title: 'Built-in approval',
      options: [{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }],
    });
  });

  it('returns undefined when neither a module nor the built-in fallback owns the id', () => {
    expect(resolveQuestionRender('unowned-render-question')).toBeUndefined();
  });
});
