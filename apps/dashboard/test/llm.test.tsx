// The LLM providers pages, Accounts and Usage, from a person's side, against a stand-in for the
// server.

import type { Account, Role } from '@acentric/protocol';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { rangeStart } from '../src/llm/format.ts';
import { totalsOf } from './fake/llm.ts';
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
  agents: [],
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
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Usage' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Accounts' })).toBeNull();
  });

  it('shows no accounts page to one who may not manage them', async () => {
    open('/llm-providers', signedIn('member'));
    expect(await screen.findByText('Nothing here, or you may not see it.')).toBeTruthy();
  });
});

describe('the Accounts page', () => {
  it('lists the accounts: the default, the provider, the agents given each, and its spend', async () => {
    const server = signedIn();
    server.areas.llm.accounts.push(
      accountOf(1, { name: 'main', default: true, agents: [ORDERS] }),
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
    expect(cells(rowOf('main')).slice(0, 4)).toEqual([
      'maindefault',
      'Anthropic',
      'orders, and every agent given none',
      '$3.50',
    ]);
    expect(cells(rowOf('spare')).slice(0, 4)).toEqual([
      'sparedefault',
      'OpenAI',
      'Every agent given none',
      '$0.00',
    ]);
    expect(cells(rowOf('side')).slice(0, 4)).toEqual(['side', 'Anthropic', '—', '$0.00']);
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
    // ChatGPT is signed in, not given a key: it is not offered here.
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual([
      'Anthropic',
      'OpenAI',
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

  it('removes one, and says what it is given to when it may not be', async () => {
    const server = signedIn();
    server.areas.llm.accounts.push(
      accountOf(1, { name: 'main', default: true, agents: [ORDERS, BILLING] }),
      accountOf(2, { name: 'side' }),
    );
    open('/llm-providers', server);
    await screen.findByText('side');
    await choose('main', 'Remove');
    expect(dialog().textContent).toContain(
      'It is given to orders, billing: give them another account first.',
    );
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
  /** Each usage query the page asked, as its address has it. */
  const asked: string[] = [];
  const withUsage = () => {
    asked.length = 0;
    const server = signedIn();
    server.areas.llm.accounts.push(accountOf(1, { name: 'main', default: true }));
    server.areas.llm.usageIs((query) => {
      asked.push(query.toString());
      const totals = totalsOf({
        calls: 12_900,
        failed: 3,
        totalInput: 1000,
        cacheRead: 620,
        cacheWrite: 40,
        output: 300,
        reasoning: 50,
        cost: 4,
        estimatedCost: 1,
        unpriced: 2,
        first: Date.now() - 86_400_000,
      });
      const by = query.get('by');
      const groups =
        by === 'agent'
          ? [
              { key: ORDERS, totals: totalsOf({ ...totals, cost: 3 }) },
              { key: BILLING, totals: totalsOf({ calls: 1, cost: 1 }) },
            ]
          : by === 'account'
            ? [{ key: accountOf(1).id, totals }]
            : by === 'provider'
              ? [
                  { key: 'anthropic', totals },
                  { key: 'fireworks', totals: totalsOf({ totalInput: 10, cacheRead: 0 }) },
                ]
              : by === 'day'
                ? [{ key: new Date().toISOString().slice(0, 10), totals }]
                : undefined;
      return { totals, ...(groups === undefined ? {} : { groups }) };
    });
    return server;
  };

  it('shows the totals of the range, the prompt cache of each provider, and what each agent spent', async () => {
    open('/usage', withUsage());
    await screen.findByText('$1.00 estimated · 2 calls of unknown price');
    const tiles = [...document.querySelectorAll('.usage-tile')].map((tile) =>
      [...tile.children].map((part) => part.textContent),
    );
    expect(tiles).toEqual([
      ['Spend', '$4.00', '$1.00 estimated · 2 calls of unknown price'],
      ['Model calls', '12.9K', '3 failed'],
      ['Input tokens', '1,000', '40 written to cache'],
      ['Cache hits', '62%', '620 of 1,000 input tokens'],
      ['Output tokens', '300', '50 reasoning'],
    ]);
    const cache = screen.getByRole('table', { name: 'Prompt cache by provider' });
    expect(
      within(cache)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]?.textContent),
    ).toEqual(['Anthropic', 'Fireworks']);
    const usage = await screen.findByRole('table', { name: 'Usage' });
    // An agent is named, and links to its page.
    const orders = within(usage).getByRole('link', { name: 'orders' });
    expect(orders.getAttribute('href')).toBe(`/agents/${ORDERS}`);
    expect(within(usage).getByRole('link', { name: 'billing' })).toBeTruthy();
  });

  it('adds usage up by account, by name, and reads each range asked for', async () => {
    const server = withUsage();
    open('/usage', server);
    await screen.findByRole('table', { name: 'Usage' });
    fireEvent.click(screen.getByRole('button', { name: 'Group: By agent' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'By account' }));
    await waitFor(() =>
      expect(within(screen.getByRole('table', { name: 'Usage' })).getByText('main')).toBeTruthy(),
    );
    expect(asked).toContain(`from=${String(rangeStart(30))}&by=account`);
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(asked).toContain(`from=${String(rangeStart(7))}&by=account`));
    fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() => expect(asked).toContain('by=account'));
  });

  it('says so when there were no model calls', async () => {
    open('/usage', signedIn());
    expect((await screen.findAllByText('No model calls in this range')).length).toBe(2);
  });
});
