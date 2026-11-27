// The LLM providers pages, Accounts and Usage, from a person's side, against a stand-in for the
// server.

import type { Account, Role } from '@acentric/protocol';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { dayLabel, dayOf, rangeStart, TIME_ZONE } from '../src/llm/format.ts';
import { reportOfCalls, totalsOf, type FakeCall } from './fake/llm.ts';
import { open } from './render.tsx';
import { fakeServer } from './server.ts';

type AgentId = `agt_${string}`;
const ORDERS = `agt_${'0'.repeat(25)}1` as AgentId;
const BILLING = `agt_${'0'.repeat(25)}2` as AgentId;

const signedIn = (role: Role = 'owner') => {
  const server = fakeServer();
  server.person('ada@example.test', 'a-password-for-tests', true, role);
  server.agents.push({ id: ORDERS, name: 'orders' }, { id: BILLING, name: 'billing' });
  return server;
};

const accountOf = (id: number, more: Partial<Account> = {}): Account => ({
  id: `acc_${String(id).padStart(26, '0')}` as Account['id'],
  provider: 'anthropic',
  name: `account ${String(id)}`,
  credential: 'api_key',
  default: false,
  owner: null,
  actors: 0,
  createdBy: { type: 'user', id: 'usr_1' as never },
  createdAt: 1_795_305_600_000,
  ...more,
});

const dialog = () => screen.getByRole('dialog');
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
const menu = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};
const choose = async (account: string, item: string) => {
  fireEvent.click(within(await menu(account)).getByRole('menuitem', { name: item }));
};

describe('the LLM providers section', () => {
  it('is in the sidebar for one who may manage accounts, and Usage for one who may read it', async () => {
    open('/usage', signedIn('viewer'));
    expect(await screen.findByRole('heading', { name: 'LLM Usage' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Usage' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Accounts' })).toBeNull();
  });

  it('shows no accounts page to one who may not manage them', async () => {
    open('/llm-providers', signedIn('member'));
    expect(await screen.findByText('Nothing here, or you may not see it.')).toBeTruthy();
  });
});

describe('the Accounts page', () => {
  it('lists the accounts: the default, the provider, and its spend', async () => {
    const server = signedIn();
    server.areas.llm.accounts.push(
      accountOf(1, { name: 'main', default: true, actors: 1 }),
      accountOf(2, { name: 'spare', provider: 'openai', default: true }),
      accountOf(3, { name: 'side' }),
    );
    server.areas.llm.usageIs((query) => ({
      totals: totalsOf({ cost: 3.5 }),
      groups:
        query.get('by') === 'account'
          ? [{ key: accountOf(1).id, totals: totalsOf({ cost: 3.5 }) }]
          : [],
    }));
    open('/llm-providers', server);
    await screen.findByText('main');
    expect(screen.queryByRole('columnheader', { name: 'Agents' })).toBeNull();
    expect(cells(rowOf('main')).slice(0, 3)).toEqual(['maindefault', 'Anthropic', '$3.50']);
    expect(cells(rowOf('spare')).slice(0, 3)).toEqual(['sparedefault', 'OpenAI', '$0.00']);
    expect(cells(rowOf('side')).slice(0, 3)).toEqual(['side', 'Anthropic', '$0.00']);
    // The default is not made the default again.
    expect(within(await menu('main')).queryByRole('menuitem', { name: 'Make default' })).toBeNull();
  });

  it('says so when there are none', async () => {
    open('/llm-providers', signedIn());
    expect(await screen.findByText('No accounts yet')).toBeTruthy();
  });

  it('adds one by its API key, says why a key was refused, and makes the first the default', async () => {
    const server = signedIn();
    open('/llm-providers', server);
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Provider: Anthropic' }));
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual([
      'Anthropic',
      'OpenAI',
      'ChatGPT',
      'Fireworks',
    ]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'OpenAI' }));
    expect(within(dialog()).getByLabelText('Name').getAttribute('placeholder')).toBe(
      'openai-personal',
    );
    // A name is what the server takes, and it says so of one that is not.
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'My work' } });
    fireEvent.change(within(dialog()).getByLabelText('API key'), { target: { value: 'sk-test' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add account' }));
    expect(
      await within(dialog()).findByText(
        'A name is lowercase letters, digits, - and _, starting with a letter or digit, 63 at most',
      ),
    ).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'work' } });
    fireEvent.change(within(dialog()).getByLabelText('API key'), {
      target: { value: 'bad-key' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add account' }));
    expect(await within(dialog()).findByText('openai did not take the key')).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText('API key'), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('work')).toBeTruthy();
    expect(server.areas.llm.accounts.map((account) => [account.provider, account.default])).toEqual(
      [['openai', true]],
    );
    // The key is sent once, and kept nowhere on the page.
    expect(document.body.innerHTML).not.toContain('sk-test');
  });

  it('adds a ChatGPT account by signing in with ChatGPT, with the address it ends at', async () => {
    const server = signedIn();
    let opened = 0;
    const tab = { opener: {}, closed: false, close() {}, location: { href: '' } };
    const before = window.open;
    window.open = (() => {
      opened += 1;
      return tab;
    }) as unknown as typeof window.open;
    try {
      open('/llm-providers', server);
      fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Provider: Anthropic' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'ChatGPT' }));
      // Signed in, not given a key.
      expect(within(dialog()).queryByLabelText('API key')).toBeNull();
      expect(within(dialog()).queryByRole('button', { name: 'Add account' })).toBeNull();
      const signIn = within(dialog()).getByRole('button', { name: 'Sign in with ChatGPT' });
      expect(signIn.hasAttribute('disabled')).toBe(true);
      expect(signIn.hasAttribute('data-oai-siwc-button')).toBe(true);
      fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'plan' } });
      fireEvent.click(signIn);

      // OpenAI's page opens, in a tab of its own that is not given this one.
      const link = await within(dialog()).findByRole('link', { name: /Open auth\.openai\.com/ });
      const url = 'https://auth.openai.com/api/accounts/authorize?state=state-1';
      expect(link.getAttribute('href')).toBe(url);
      expect(opened).toBe(1);
      expect(tab.location.href).toBe(url);
      expect(tab.opener).toBeNull();
      expect(server.areas.llm.signInCalls[0]).toMatchObject({ body: { name: 'plan' } });
      // The name it was started with stays while it waits.
      expect(within(dialog()).getByLabelText('Name').hasAttribute('disabled')).toBe(true);

      const address = within(dialog()).getByLabelText('Address');
      fireEvent.change(address, {
        target: { value: 'http://127.0.0.1:1455/auth/callback?state=x' },
      });
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in' }));
      expect(
        await within(dialog()).findByText('That is not the address of this sign-in'),
      ).toBeTruthy();
      fireEvent.change(address, {
        target: { value: 'http://127.0.0.1:1455/auth/callback?code=c&state=state-1' },
      });
      fireEvent.keyDown(address, { key: 'Enter' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(
        cells(await screen.findByText('plan').then((n) => n.closest('tr') as HTMLElement)).slice(
          0,
          2,
        ),
      ).toEqual(['plandefault', 'ChatGPT']);
      expect(server.areas.llm.accounts).toMatchObject([
        { provider: 'chatgpt', name: 'plan', credential: 'access_token' },
      ]);
    } finally {
      window.open = before;
    }
  });

  it('sends a pasted address at once, and opens the new page of a sign-in that was refused', async () => {
    const server = signedIn();
    open('/llm-providers', server);
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Provider: Anthropic' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'ChatGPT' }));
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'plan' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in with ChatGPT' }));
    const address = await within(dialog()).findByLabelText('Address');
    const paste = (text: string) =>
      fireEvent.paste(address, { clipboardData: { getData: () => text } });
    // Pasted, and sent with no click.
    paste('http://127.0.0.1:1455/auth/callback?code=c&state=state-1&refused=1');
    expect(
      await within(dialog()).findByText('ChatGPT did not take that sign-in’s code'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        within(dialog())
          .getByRole('link', { name: /Open auth\.openai\.com/ })
          .getAttribute('href'),
      ).toBe('https://auth.openai.com/api/accounts/authorize?state=state-1-again'),
    );
    expect((within(dialog()).getByLabelText('Address') as HTMLInputElement).value).toBe('');
    paste('http://127.0.0.1:1455/auth/callback?code=c2&state=state-1-again');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.areas.llm.accounts).toMatchObject([{ provider: 'chatgpt', name: 'plan' }]);
    expect(
      server.areas.llm.signInCalls.filter((call) => call.path.endsWith('/callback')),
    ).toHaveLength(2);
  });

  it('gives up a ChatGPT sign-in that the dialog was closed on', async () => {
    const server = signedIn();
    open('/llm-providers', server);
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Provider: Anthropic' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'ChatGPT' }));
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'plan' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in with ChatGPT' }));
    await within(dialog()).findByLabelText('Address');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(server.areas.llm.signInCalls.map((call) => call.method)).toEqual(['POST', 'DELETE']),
    );
  });

  it('signs a ChatGPT account in again, and says one that was signed out', async () => {
    const server = signedIn();
    server.areas.llm.accounts.push(
      accountOf(1, {
        name: 'plan',
        provider: 'chatgpt',
        credential: 'access_token',
        default: true,
        signIn: { email: 'ada@example.test', signedOut: 'The ChatGPT sign-in has ended' },
      }),
    );
    open('/llm-providers', server);
    await screen.findByText('plan');
    expect(within(rowOf('plan')).getByText('signed out')).toBeTruthy();
    expect(within(rowOf('plan')).getByText('ChatGPT').getAttribute('title')).toBe(
      'ada@example.test',
    );
    const items = within(await menu('plan')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).not.toContain('Replace key');
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Sign in again' }),
    );
    expect(within(dialog()).getByText('The ChatGPT sign-in has ended')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in with ChatGPT' }));
    const address = await within(dialog()).findByLabelText('Address');
    expect(server.areas.llm.signInCalls[0]).toMatchObject({ body: { account: accountOf(1).id } });
    fireEvent.change(address, {
      target: { value: 'http://127.0.0.1:1455/auth/callback?state=state-1' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(rowOf('plan')).queryByText('signed out')).toBeNull());
  });

  it('adds another of a provider as it is, not its default', async () => {
    const server = signedIn();
    server.areas.llm.accounts.push(accountOf(1, { name: 'main', default: true }));
    open('/llm-providers', server);
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    expect(within(dialog()).queryByRole('checkbox')).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'second' } });
    fireEvent.change(within(dialog()).getByLabelText('API key'), { target: { value: 'sk-2' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add account' }));
    await waitFor(() =>
      expect(server.areas.llm.accounts.map((account) => [account.name, account.default])).toEqual([
        ['main', true],
        ['second', false],
      ]),
    );
  });

  it('makes one the default, renames it, and replaces its key', async () => {
    const server = signedIn();
    server.areas.llm.accounts.push(
      accountOf(1, { name: 'main', default: true }),
      accountOf(2, { name: 'side' }),
    );
    open('/llm-providers', server);
    await screen.findByText('side');
    await choose('side', 'Make default');
    await waitFor(() => expect(cells(rowOf('side'))[0]).toBe('sidedefault'));
    expect(cells(rowOf('main'))[0]).toBe('main');

    await choose('side', 'Rename');
    const name = within(dialog()).getByLabelText('Name');
    expect((name as HTMLInputElement).value).toBe('side');
    fireEvent.change(name, { target: { value: 'backup' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('backup')).toBeTruthy();

    await choose('backup', 'Replace key');
    expect(dialog().textContent).toContain('Replace the key of backup');
    fireEvent.change(within(dialog()).getByLabelText('API key'), {
      target: { value: 'bad-again' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Replace key' }));
    expect(await within(dialog()).findByText('anthropic did not take the key')).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText('API key'), { target: { value: 'sk-new' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Replace key' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual(
      [{ default: true }, { name: 'backup' }, { apiKey: 'bad-again' }, { apiKey: 'sk-new' }],
    );
  });

  it('removes one, and says how many actors are given it when it may not be', async () => {
    const server = signedIn();
    server.areas.llm.accounts.push(
      accountOf(1, { name: 'main', default: true, actors: 2 }),
      accountOf(2, { name: 'side' }),
    );
    open('/llm-providers', server);
    await screen.findByText('side');
    await choose('main', 'Remove');
    expect(dialog().textContent).toContain('2 actors use it: archive or delete them first.');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    await choose('side', 'Remove');
    expect(dialog().textContent).toContain(
      'The engine forgets this account and its key. What was spent with it stays in Usage.',
    );
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('side')).toBeNull());
    expect(server.areas.llm.accounts.map((account) => account.name)).toEqual(['main']);
  });
});

describe('the Usage page', () => {
  const DAY = 86_400_000;
  const NOW = Date.now();
  const A = `act_${'0'.repeat(25)}a`;
  const B = `act_${'0'.repeat(25)}b`;
  /** Each usage query the page asked, as its address has it. */
  const asked: string[] = [];
  const withUsage = () => {
    asked.length = 0;
    const server = signedIn();
    const calls: FakeCall[] = [
      {
        at: NOW,
        agent: ORDERS,
        actor: A,
        provider: 'anthropic',
        model: 'claude-x',
        cost: 3,
        input: 100,
        cacheRead: 600,
        cacheWrite: 40,
        output: 200,
        reasoning: 50,
        durationMs: 800,
      },
      {
        at: NOW,
        agent: BILLING,
        actor: B,
        provider: 'openai',
        model: 'gpt-x',
        cost: 1,
        input: 200,
        output: 100,
        durationMs: 1200,
      },
      {
        at: NOW - DAY,
        agent: ORDERS,
        actor: A,
        provider: 'anthropic',
        model: 'claude-x',
        cost: 2,
        input: 100,
        output: 50,
        durationMs: 1000,
      },
      {
        at: NOW - DAY,
        agent: ORDERS,
        actor: A,
        provider: 'anthropic',
        model: 'claude-x',
        cost: 0,
        failed: true,
        durationMs: 50,
      },
      // Of the range before the 30 days.
      {
        at: NOW - 40 * DAY,
        agent: ORDERS,
        actor: A,
        provider: 'anthropic',
        model: 'claude-x',
        cost: 2,
        input: 100,
      },
    ];
    const answer = (query: URLSearchParams) => {
      asked.push(query.toString());
      return reportOfCalls(calls, query);
    };
    server.areas.llm.usageIs(answer);
    return server;
  };
  const tiles = () =>
    [...document.querySelectorAll('.usage-tile')].map((tile) =>
      [...tile.children].map((part) => part.textContent),
    );
  const bars = (label: string) =>
    within(screen.getByRole('list', { name: label }))
      .getAllByRole('listitem')
      .map((row) => [
        row.querySelector('.usage-bars__name')?.textContent,
        row.querySelector('.usage-bars__value')?.textContent,
      ]);

  it('shows the totals of the range, and nothing of the range before', async () => {
    open('/usage', withUsage());
    await screen.findByText('1 failed (25%)');
    expect(tiles()).toEqual([
      ['Spend', '$6.00'],
      ['Model calls', '4', '1 failed (25%)'],
      ['Tokens', '1,390', '1,040 in · 350 out'],
      ['Cache hits', '58%'],
      ['Typical call', '1 s', '1.2 s for the slowest 5%'],
    ]);
    expect(asked.some((query) => query.includes('to='))).toBe(false);
  });

  it('draws each day by provider, in the viewer’s time zone, as spend, tokens or calls', async () => {
    open('/usage', withUsage());
    await screen.findByRole('heading', { name: 'Spend by day' });
    expect(asked).toContain(
      new URLSearchParams({
        from: String(rangeStart(30)),
        by: 'day',
        split: 'provider',
        tz: TIME_ZONE,
      }).toString(),
    );
    // No table to turn it into, and no legend beneath it.
    expect(screen.queryByRole('button', { name: 'Table' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Providers' })).toBeNull();
    const days = () =>
      within(screen.getByRole('list', { name: /by day$/ }))
        .getAllByRole('listitem')
        .map((day) => day.getAttribute('aria-label'));
    await waitFor(() => expect(days()).toHaveLength(30));
    const today = dayLabel(dayOf(NOW));
    const yesterday = dayLabel(dayOf(NOW - DAY));
    expect(days().slice(-2)).toEqual([`${yesterday}: $2.00`, `${today}: $4.00`]);
    // A day's tooltip names its providers' parts.
    const column = within(screen.getByRole('list', { name: /by day$/ })).getAllByRole(
      'listitem',
    )[29] as HTMLElement;
    fireEvent.focus(column);
    const tip = screen.getByRole('status');
    expect(tip.textContent).toBe(`$4.00${today}Anthropic$3.00OpenAI$1.00`);
    fireEvent.click(screen.getByRole('radio', { name: 'Calls' }));
    await screen.findByRole('heading', { name: 'Calls by day' });
    expect(days().slice(-2)).toEqual([`${yesterday}: 2`, `${today}: 2`]);
  });

  it('shows what each provider, model and actor spent, and each agent', async () => {
    open('/usage', withUsage());
    await screen.findByRole('list', { name: 'Spend by provider' });
    await waitFor(() =>
      expect(bars('Spend by provider')).toEqual([
        ['Anthropic', '$5.00'],
        ['OpenAI', '$1.00'],
      ]),
    );
    expect(bars('Spend by model')).toEqual([
      ['claude-x', '$5.00'],
      ['gpt-x', '$1.00'],
    ]);
    // An actor is its name and what it spent, with nothing under its bar.
    expect(screen.queryByText('With their subagents')).toBeNull();
    expect(
      screen.getByRole('list', { name: 'Spend by actor' }).querySelector('.usage-bars__note'),
    ).toBeNull();
    const actor = within(screen.getByRole('list', { name: 'Spend by actor' })).getAllByRole(
      'link',
    )[0];
    expect(actor?.getAttribute('href')).toBe(`/actors/${A}`);
    const agents = screen.getByRole('table', { name: 'Spend by agent' });
    expect(within(agents).getByRole('link', { name: 'orders' }).getAttribute('href')).toBe(
      `/agents/${ORDERS}`,
    );
    expect(cells(rowOf('orders'))).toEqual([
      'orders',
      '3',
      '1',
      '1,090',
      '71%',
      '800 ms',
      '$1.67',
      '$5.00',
      '',
    ]);
    const tokens = screen.getByRole('list', { name: 'Tokens by kind' });
    expect(
      within(tokens)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Input400 · 29%',
      'Read from cache600 · 43%',
      'Written to cache40 · 3%',
      'Output350 · 25%',
    ]);
  });

  it('reads each range asked for', async () => {
    open('/usage', withUsage());
    await screen.findByText('1 failed (25%)');
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(asked).toContain(`from=${String(rangeStart(7))}&by=provider`));
    fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() => expect(asked).toContain('by=provider'));
  });

  it('says so when there were no model calls', async () => {
    open('/usage', signedIn());
    expect((await screen.findAllByText('No model calls in this range')).length).toBe(5);
  });
});
