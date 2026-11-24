import { describe, expect, it } from 'vitest';

import { framed } from '../src/frame-guard.ts';
import { shortOf } from '../src/shell/SettingsKeys.tsx';
import { machinesSearch, safeRedirect, signInSearch, tokenSearch, typesOf } from '../src/url.ts';

describe('where a person is sent after signing in', () => {
  it('is a path of this site', () => {
    expect(safeRedirect('/')).toBe('/');
    expect(safeRedirect('/agents/orders?tab=actors#top')).toBe('/agents/orders?tab=actors#top');
  });

  it('is never another site, however it is written', () => {
    for (const elsewhere of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'javascript:alert(1)',
      'agents',
      '',
      5,
      undefined,
    ]) {
      expect(safeRedirect(elsewhere), String(elsewhere)).toBeUndefined();
    }
  });

  it('is never back to signing in, nor to a link that was used', () => {
    for (const page of [
      '/sign-in',
      '/sign-in?redirect=/',
      '/setup?token=x',
      '/invite',
      '/reset#x',
    ]) {
      expect(safeRedirect(page), page).toBeUndefined();
    }
    expect(safeRedirect('/settings')).toBe('/settings');
    expect(signInSearch({ redirect: '//evil.example' })).toEqual({ redirect: undefined });
    expect(signInSearch({ redirect: '/agents' })).toEqual({ redirect: '/agents' });
  });
});

describe('the Machines page’s filter in the address', () => {
  it('is personal and the IDs of sandbox accounts, once each, and nothing else', () => {
    expect(machinesSearch({ type: 'personal,prv_1,personal' })).toEqual({ type: 'personal,prv_1' });
    expect(machinesSearch({ type: 'everything,//evil,prv_' })).toEqual({ type: undefined });
    expect(machinesSearch({})).toEqual({ type: undefined });
    expect(typesOf('prv_2,personal')).toEqual(['prv_2', 'personal']);
    expect(typesOf(undefined)).toEqual([]);
  });
});

describe('the token of a link', () => {
  it('is what the link says, when it says one', () => {
    expect(tokenSearch({ token: 'al_abc' })).toEqual({ token: 'al_abc' });
    // Each is said to be none, so that the URL's own does not come through under it.
    expect(tokenSearch({ token: '' })).toEqual({ token: undefined });
    expect(tokenSearch({ token: 'x'.repeat(201) })).toEqual({ token: undefined });
    expect(tokenSearch({})).toEqual({ token: undefined });
  });
});

describe('a page inside a frame', () => {
  it('is known as one, even when its parent cannot be read', () => {
    const self = {};
    expect(framed({ top: self, self })).toBe(false);
    expect(framed({ top: {}, self })).toBe(true);
    const hidden = {
      self,
      get top(): unknown {
        throw new Error('A frame of another origin');
      },
    };
    expect(framed(hidden)).toBe(true);
  });
});

describe('a long name, shown short', () => {
  it('is its first words that fit, then …, or its first word cut when that alone is too long', () => {
    expect(shortOf('ci deploys')).toBe('ci deploys');
    expect(shortOf('The first key, made when the engine first started')).toBe(
      'The first key, made…',
    );
    expect(shortOf('averyveryveryverylongnamewithoutspaces')).toBe('averyveryveryverylon…');
  });
});
