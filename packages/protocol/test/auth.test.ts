import { describe, expect, it } from 'vitest';

import {
  HOLDABLE,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  isAtLeast,
  isHoldable,
  principalSchema,
  roleHolds,
  scopeSchema,
} from '../src/auth.ts';
import { makeId } from '../src/ids.ts';
import { BUNDLE_PROTOCOL, supportsBundleProtocol } from '../src/versions.ts';

const source = { now: 1_795_305_600_000, random: new Uint8Array(10).fill(3) };

describe('roles', () => {
  it('each hold everything the role below holds', () => {
    for (let index = 1; index < ROLES.length; index += 1) {
      const role = ROLES[index] as (typeof ROLES)[number];
      const below = ROLES[index - 1] as (typeof ROLES)[number];
      for (const permission of ROLE_PERMISSIONS[below]) {
        expect(roleHolds(role, permission), `${role} holds ${permission}`).toBe(true);
      }
    }
  });

  it('an owner holds every permission, and a viewer changes nothing', () => {
    expect([...ROLE_PERMISSIONS.owner].toSorted()).toEqual([...PERMISSIONS].toSorted());
    for (const permission of ROLE_PERMISSIONS.viewer) {
      expect(permission.endsWith(':read'), permission).toBe(true);
    }
  });

  it('only an admin or an owner manages people and reads the audit log', () => {
    for (const role of ROLES) {
      const high = role === 'admin' || role === 'owner';
      expect(roleHolds(role, 'users:manage'), role).toBe(high);
      expect(roleHolds(role, 'audit:read'), role).toBe(high);
    }
  });

  it('are ordered', () => {
    expect(isAtLeast('owner', 'admin')).toBe(true);
    expect(isAtLeast('admin', 'admin')).toBe(true);
    expect(isAtLeast('member', 'admin')).toBe(false);
  });
});

describe('scopes', () => {
  it('a narrower scope holds no permission a wider one cannot', () => {
    for (const permission of HOLDABLE.actor)
      expect(isHoldable('agent', permission), permission).toBe(true);
    for (const permission of HOLDABLE.agent)
      expect(isHoldable('engine', permission), permission).toBe(true);
  });

  it('a key of one actor cannot deploy, and a key of one agent cannot manage people', () => {
    expect(isHoldable('actor', 'agents:deploy')).toBe(false);
    expect(isHoldable('agent', 'users:manage')).toBe(false);
    expect(isHoldable('agent', 'machines:run')).toBe(false);
  });

  it('say what they reach by its ID', () => {
    const agent = makeId('agent', source);
    expect(scopeSchema.parse({ type: 'agent', agent })).toEqual({ type: 'agent', agent });
    expect(scopeSchema.safeParse({ type: 'agent', agent: 'support' }).success).toBe(false);
    expect(scopeSchema.safeParse({ type: 'agent', agent: makeId('actor', source) }).success).toBe(
      false,
    );
    expect(scopeSchema.safeParse({ type: 'engine' }).success).toBe(true);
  });
});

describe('principalSchema', () => {
  it('takes a person and a key', () => {
    const person = {
      type: 'user',
      user: makeId('user', source),
      email: 'maya@example.com',
      role: 'member',
      permissions: [...ROLE_PERMISSIONS.member],
      session: makeId('session', source),
    };
    const key = {
      type: 'key',
      key: makeId('key', source),
      owner: null,
      scope: { type: 'engine' },
      permissions: ['actors:send'],
      expiresAt: null,
    };
    expect(principalSchema.parse(person)).toEqual(person);
    expect(principalSchema.parse(key)).toEqual(key);
    expect(principalSchema.safeParse({ ...key, permissions: ['everything'] }).success).toBe(false);
  });
});

describe('bundle protocol', () => {
  it('is one this engine runs', () => {
    expect(supportsBundleProtocol(BUNDLE_PROTOCOL)).toBe(true);
    expect(supportsBundleProtocol(BUNDLE_PROTOCOL + 1)).toBe(false);
    expect(supportsBundleProtocol(0)).toBe(false);
  });
});
