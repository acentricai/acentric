// The Agents pages, from a person's side, against a stand-in for the server: the agents, an
// agent's actors, deployments and secrets, and an actor's page with its conversation.

import type { Account, Actor, Role, TaskDetail } from '@acentric/protocol';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { actorFor, definitionOf, idOf } from './fake/agents.ts';
import { open } from './render.tsx';
import { dayLabel, dayOf } from '../src/llm/format.ts';
import { totalsOf } from './fake/llm.ts';
import { fakeServer, machineOf } from './server.ts';

const signedIn = (role: Role = 'owner') => {
  const server = fakeServer();
  server.person('ada@example.test', 'a-password-for-tests', true, role);
  return server;
};
const area = (server: ReturnType<typeof fakeServer>) => server.areas.agents;
const press = (name: string | RegExp, within_: HTMLElement = document.body) =>
  fireEvent.click(within(within_).getByRole('button', { name }));
const dialog = () => screen.getByRole('dialog');
const cells = (label: string) =>
  within(screen.getByRole('table', { name: label }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

/** An engine with two agents, the first with two deployments and three actors. */
function withAgents(role: Role = 'owner') {
  const server = signedIn(role);
  const orders = area(server).agent('orders', 1, [
    definitionOf({ instructions: 'First.' }),
    definitionOf({
      instructions: 'You answer questions about orders.',
      tools: [
        {
          name: 'lookup_order',
          description: 'Finds an order.',
          parameters: {},
          retrySafe: true,
          codemode: true,
        },
      ],
      inputs: [
        { type: 'message', schema: null },
        { type: 'refund', schema: null },
      ],
    }),
  ]);
  area(server).agent('billing', 2);
  server.actors.push(
    actorFor(orders, 1, { name: 'eu-desk', status: 'working' }),
    actorFor(orders, 2),
    actorFor(orders, 3, { name: 'old-desk', status: 'archived', archivedAt: 1 }),
  );
  return { server, orders };
}

describe('the Agents page', () => {
  it('lists the agents, with their newest version and provider, and opens one', async () => {
    const { server, orders } = withAgents();
    const page = open('/agents', server);
    await screen.findByText('orders');
    expect(cells('Agents')).toEqual(['orders', 'billing']);
    const row = screen.getByText('orders').closest('tr') as HTMLElement;
    expect(within(row).getByText('v2')).toBeTruthy();
    expect(within(row).getByText('openai')).toBeTruthy();
    fireEvent.click(screen.getByText('orders'));
    await waitFor(() => expect(page.where()).toBe(`/agents/${orders.id}`));
  });

  it('tells how to deploy the first agent when there is none', async () => {
    open('/agents', signedIn());
    expect(await screen.findByText(/No agents yet/)).toBeTruthy();
    expect(screen.getByText("acentric login 'http://localhost:3000'")).toBeTruthy();
    expect(screen.getByText('acentric deploy')).toBeTruthy();
  });

  it('deletes an agent once its name is typed, for one who deploys agents', async () => {
    const { server } = withAgents();
    open('/agents', server);
    await screen.findByText('billing');
    press('Actions for billing');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const button = within(dialog()).getByRole('button', { name: 'Delete agent' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText('Type billing to confirm'), {
      target: { value: 'billing' },
    });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText('billing')).toBeNull());
    expect(
      server.calls.some(
        (call) => call.method === 'DELETE' && call.path === `/v1/agents/${idOf('agt', 2)}`,
      ),
    ).toBe(true);
  });

  it('offers no delete to one who does not deploy agents', async () => {
    const { server } = withAgents('viewer');
    open('/agents', server);
    await screen.findByText('billing');
    expect(screen.queryByRole('button', { name: 'Actions for billing' })).toBeNull();
  });
});

describe('an agent’s own dashboard', () => {
  it('has its own tabs in the sidebar, each its own page, and the way back', async () => {
    const { server, orders } = withAgents();
    const page = open(`/agents/${orders.id}`, server);
    const side = await screen.findByRole('complementary', { name: 'Sidebar' });
    const tabs = await within(side).findAllByRole('link');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining(['Overview', 'Actors', 'Deployments', 'Secrets', 'Settings']),
    );
    expect(within(side).queryByRole('link', { name: 'Machines' })).toBeNull();
    expect(within(side).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(within(side).getByRole('link', { name: 'Deployments' }));
    await waitFor(() => expect(page.where()).toBe(`/agents/${orders.id}/deployments`));
    expect(await screen.findByRole('heading', { name: 'Deployments' })).toBeTruthy();
    expect(within(side).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      null,
    );
    fireEvent.click(within(side).getByRole('link', { name: 'Back to Dashboard' }));
    await waitFor(() => expect(page.where()).toBe('/agents'));
    expect(await within(side).findByRole('link', { name: 'Machines' })).toBeTruthy();
  });
});

describe('an agent’s Overview', () => {
  it('adds up only its own model calls, each day split by the actors that made them', async () => {
    const { server, orders } = withAgents();
    const asked: URLSearchParams[] = [];
    const today = dayOf(Date.now());
    server.areas.llm.usageIs((query) => {
      asked.push(query);
      return {
        totals: totalsOf({ cost: 12.5, calls: 40 }),
        groups:
          query.get('by') === 'day'
            ? [
                {
                  key: today,
                  totals: totalsOf({ cost: 12.5, calls: 40 }),
                  groups: [
                    { key: idOf('act', 1), totals: totalsOf({ cost: 9, calls: 30 }) },
                    { key: idOf('act', 2), totals: totalsOf({ cost: 3.5, calls: 10 }) },
                  ],
                },
              ]
            : [],
      };
    });
    open(`/agents/${orders.id}`, server);
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeTruthy();
    await waitFor(() =>
      expect(document.querySelector('.usage-tile__value')?.textContent).toBe('$12.50'),
    );
    // Every read of usage is of this agent alone, and the days are split by actor.
    expect(asked.every((query) => query.get('agent') === orders.id)).toBe(true);
    expect(asked.some((query) => query.get('by') === 'day' && query.get('split') === 'actor')).toBe(
      true,
    );
    // A day's tooltip names its actors, by name where they have one.
    fireEvent.pointerEnter(
      await screen.findByRole('listitem', { name: new RegExp(`${dayLabel(today)}: \\$12\\.50`) }),
    );
    const tip = await screen.findByRole('status');
    expect(tip.textContent).toContain('eu-desk');
    // Nothing more than the totals, the days and the tokens.
    expect(screen.queryByText('Top actors')).toBeNull();
    expect(screen.queryByText('By model')).toBeNull();
  });
});

describe('an agent’s Actors', () => {
  const accountOf = (n: number, provider: string, more: Partial<Account> = {}): Account => ({
    id: `acc_${String(n).padStart(26, '0')}` as Account['id'],
    provider,
    name: `account ${String(n)}`,
    credential: 'api_key',
    default: false,
    owner: null,
    actors: 0,
    createdBy: { type: 'user', id: 'usr_1' as never },
    createdAt: 1_795_305_600_000,
    ...more,
  });

  it('lists them with how they stand and the account each is called with', async () => {
    const { server, orders } = withAgents();
    const main = accountOf(1, orders.provider, { name: 'main', default: true });
    server.areas.llm.accounts.push(main);
    server.actors[0] = { ...(server.actors[0] as Actor), account: main.id };
    open(`/agents/${orders.id}/actors`, server);
    await screen.findByText('eu-desk');
    const row = screen.getByText('eu-desk').closest('tr') as HTMLElement;
    expect(within(row).getByText('working')).toBeTruthy();
    expect(within(row).getByText('main')).toBeTruthy();
    expect(screen.getByText('old-desk')).toBeTruthy();

    // No filter: every one, archived too.
    expect(screen.queryByRole('button', { name: /Status/ })).toBeNull();
  });

  it('makes one with the account chosen, on a machine where its agent says so, and opens it', async () => {
    const server = signedIn();
    const worker = area(server).agent('worker', 3, [definitionOf({ features: ['machine'] })]);
    server.areas.llm.accounts.push(
      accountOf(1, worker.provider, { name: 'main', default: true }),
      accountOf(2, worker.provider, { name: 'team' }),
      accountOf(3, 'not-its-provider', { name: 'other' }),
    );
    server.machines.push(machineOf('box', { agents: '*', online: true }));
    const page = open(`/agents/${worker.id}/actors`, server);
    fireEvent.click(await screen.findByRole('button', { name: 'New actor' }));
    const form = dialog();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'night-shift' } });
    fireEvent.click(await within(form).findByRole('button', { name: /Account/ }));
    expect(screen.getByRole('menuitemradio', { name: 'Default: main' })).toBeTruthy();
    expect(screen.queryByRole('menuitemradio', { name: 'other' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'team' }));
    fireEvent.click(within(form).getByRole('button', { name: /Machine/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'box' }));
    fireEvent.change(within(form).getByLabelText('Working directory'), {
      target: { value: '~/work' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'New actor' }));
    await waitFor(() => expect(page.where()).toMatch(/^\/agents\/agt_\w+\/actors\/act_/));
    const created = server.calls.find(
      (call) => call.method === 'POST' && call.path === `/v1/agents/${worker.id}/actors`,
    );
    expect(created?.body).toEqual({
      name: 'night-shift',
      account: accountOf(2, worker.provider).id,
      reasoning: 'medium',
      machine: { id: machineOf('box').id, cwd: '~/work' },
    });
  });

  it('leaves the account to the provider’s default when none is chosen', async () => {
    const { server, orders } = withAgents();
    server.areas.llm.accounts.push(accountOf(1, orders.provider, { name: 'main', default: true }));
    open(`/agents/${orders.id}/actors`, server);
    fireEvent.click(await screen.findByRole('button', { name: 'New actor' }));
    expect(await within(dialog()).findByText('Default: main')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'New actor' }));
    await waitFor(() =>
      expect(
        server.calls.find(
          (call) => call.method === 'POST' && call.path === `/v1/agents/${orders.id}/actors`,
        )?.body,
      ).toEqual({ reasoning: 'medium' }),
    );
  });

  it('archives one after asking, and not one that is archived already', async () => {
    const { server, orders } = withAgents();
    const id = (server.actors[0] as Actor).id;
    open(`/agents/${orders.id}/actors`, server);
    await screen.findByRole('button', { name: 'Actions for eu-desk' });
    press('Actions for eu-desk');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(within(dialog()).getByRole('heading', { name: 'Archive actor?' })).toBeTruthy();
    expect(dialog().textContent).toContain('eu-desk takes no input while it is archived');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.method === 'POST' && call.path === `/v1/actors/${id}/archive`,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    press('Actions for old-desk');
    expect(
      ((await screen.findByRole('menuitem', { name: 'Archive' })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('deletes one after asking, archiving it first when it is not', async () => {
    const { server, orders } = withAgents();
    const id = (server.actors[0] as Actor).id;
    open(`/agents/${orders.id}/actors`, server);
    await screen.findByRole('button', { name: 'Actions for eu-desk' });
    press('Actions for eu-desk');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(within(dialog()).getByRole('heading', { name: 'Delete actor?' })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(
        server.calls
          .filter((call) => call.path.startsWith(`/v1/actors/${id}`) && call.method !== 'GET')
          .map((call) => `${call.method} ${call.path.slice(`/v1/actors/${id}`.length)}`),
      ).toEqual(['POST /archive', 'DELETE ']),
    );
  });

  it('has nothing to make or change for one who may only read', async () => {
    const { server, orders } = withAgents('viewer');
    open(`/agents/${orders.id}/actors`, server);
    await screen.findByText('eu-desk');
    expect(screen.queryByRole('button', { name: 'New actor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for eu-desk' })).toBeNull();
  });
});

describe('an agent’s Deployments', () => {
  it('lists them newest first, and says which is active', async () => {
    const { server, orders } = withAgents();
    open(`/agents/${orders.id}/deployments`, server);
    await screen.findByText('active');
    expect(cells('Deployments').map((text) => text?.replace('active', ''))).toEqual(['v2', 'v1']);
  });

  it('opens one by its version: a tab for each part it declared, kept in the address', async () => {
    const { server, orders } = withAgents();
    const page = open(`/agents/${orders.id}/deployments`, server);
    fireEvent.click(await screen.findByRole('button', { name: 'v2' }));
    const opened = await screen.findByRole('dialog');
    expect(within(opened).getByRole('heading', { name: 'v2' })).toBeTruthy();
    expect(await within(opened).findByText('You answer questions about orders.')).toBeTruthy();
    expect(page.where()).toBe(`/agents/${orders.id}/deployments?v=2`);

    fireEvent.click(within(opened).getByRole('button', { name: 'Tools' }));
    expect(await within(opened).findByText('lookup_order')).toBeTruthy();
    expect(within(opened).getByText('code mode')).toBeTruthy();
    expect(within(opened).getByText('Finds an order.')).toBeTruthy();
    expect(page.where()).toBe(`/agents/${orders.id}/deployments?v=2&tab=tools`);

    fireEvent.click(within(opened).getByRole('button', { name: 'Inputs' }));
    expect(await within(opened).findByText('refund')).toBeTruthy();

    fireEvent.click(within(opened).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(page.where()).toBe(`/agents/${orders.id}/deployments`));
  });

  it('links a subagent to its agent’s page, in a new tab', async () => {
    const server = signedIn();
    const billing = area(server).agent('billing', 1);
    const orders = area(server).agent('orders', 2, [
      definitionOf({
        subagents: [
          { agent: 'billing', description: 'Answers billing questions.', creates: false },
        ],
      }),
    ]);
    open(`/agents/${orders.id}/deployments?v=1&tab=subagents`, server);
    const link = await within(await screen.findByRole('dialog')).findByRole('link', {
      name: 'billing',
    });
    expect(link.getAttribute('href')).toBe(`/agents/${billing.id}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  it('shows the code, as it was deployed, in its Raw tab', async () => {
    const { server, orders } = withAgents();
    open(`/agents/${orders.id}/deployments`, server);
    await screen.findByRole('button', { name: 'Actions for v1' });
    press('Actions for v1');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'View source' }));
    const opened = await screen.findByRole('dialog');
    expect(within(opened).getByRole('heading', { name: 'v1' })).toBeTruthy();
    fireEvent.click(within(opened).getByRole('button', { name: 'Raw' }));
    await waitFor(() =>
      expect(opened.querySelector('pre.code__text')?.textContent).toBe("export default 'v1';"),
    );
  });
});

describe('a deployment’s menu', () => {
  it('makes another version active, after asking, and not the one that is', async () => {
    const { server, orders } = withAgents();
    open(`/agents/${orders.id}/deployments`, server);
    // The active version is offered, but not to be made active again.
    await screen.findByRole('button', { name: 'Actions for v2' });
    press('Actions for v2');
    await screen.findByRole('menuitem', { name: 'View source' });
    expect(
      (screen.getByRole('menuitem', { name: 'Make active' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    press('Actions for v1');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make active' }));
    expect(await screen.findByRole('heading', { name: 'Make v1 active?' })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Make active' }));
    await waitFor(() =>
      expect(
        server.calls.find(
          (call) => call.method === 'PATCH' && call.path === `/v1/agents/${orders.id}`,
        )?.body,
      ).toEqual({ activeVersion: 1 }),
    );
    const v1 = (await screen.findByRole('button', { name: 'v1' })).closest('tr') as HTMLElement;
    expect(await within(v1).findByText('active')).toBeTruthy();
  });

  it('offers no Make active to one who does not deploy agents', async () => {
    const { server, orders } = withAgents('viewer');
    open(`/agents/${orders.id}/deployments`, server);
    await screen.findByRole('button', { name: 'Actions for v1' });
    press('Actions for v1');
    await screen.findByRole('menuitem', { name: 'View source' });
    expect(screen.queryByRole('menuitem', { name: 'Make active' })).toBeNull();
  });
});

describe('an agent’s Secrets', () => {
  const putOf = (server: ReturnType<typeof fakeServer>, agent: string, name: string) =>
    server.calls.find(
      (call) => call.method === 'PUT' && call.path === `/v1/agents/${agent}/secrets/${name}`,
    );

  it('adds one, and asks before replacing one of a name it has', async () => {
    const { server, orders } = withAgents();
    area(server).secrets(orders.id, ['ORDERS_KEY']);
    open(`/agents/${orders.id}/secrets`, server);
    await screen.findByText('ORDERS_KEY');
    press('Add secret');
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'ORDERS_KEY' } });
    fireEvent.change(within(dialog()).getByLabelText('Value'), { target: { value: 'k-2' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add secret' }));
    expect(await screen.findByRole('heading', { name: 'Replace ORDERS_KEY?' })).toBeTruthy();
    expect(putOf(server, orders.id, 'ORDERS_KEY')).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(
        (putOf(server, orders.id, 'ORDERS_KEY')?.body as { value?: string } | undefined)?.value,
      ).toBe('k-2'),
    );
  });

  it('replaces one’s value from its menu, and removes one after asking', async () => {
    const { server, orders } = withAgents();
    area(server).secrets(orders.id, ['ORDERS_KEY']);
    open(`/agents/${orders.id}/secrets`, server);
    await screen.findByText('ORDERS_KEY');
    press('Actions for ORDERS_KEY');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Replace value' }));
    expect(within(dialog()).queryByLabelText('Name')).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText('Value'), { target: { value: 'k-3' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(
        (putOf(server, orders.id, 'ORDERS_KEY')?.body as { value?: string } | undefined)?.value,
      ).toBe('k-3'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    press('Actions for ORDERS_KEY');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) =>
            call.method === 'DELETE' && call.path === `/v1/agents/${orders.id}/secrets/ORDERS_KEY`,
        ),
      ).toBe(true),
    );
  });

  it('is no tab for one who may not set them', async () => {
    const { server, orders } = withAgents('viewer');
    open(`/agents/${orders.id}`, server);
    await screen.findByRole('link', { name: 'Deployments' });
    expect(screen.queryByRole('link', { name: 'Secrets' })).toBeNull();
  });
});

describe('an agent’s Settings', () => {
  it('says what it is', async () => {
    const { server, orders } = withAgents();
    open(`/agents/${orders.id}/settings`, server);
    await screen.findByRole('heading', { name: 'General' });
    const main = screen.getByRole('main');
    expect(within(main).getByText(orders.id)).toBeTruthy();
    expect(within(main).getByText('orders')).toBeTruthy();
    expect(within(main).getByText(orders.provider)).toBeTruthy();
    // An agent is of a provider, not of an account: its actors have those.
    expect(within(main).queryByText('Account')).toBeNull();
  });

  it('deletes it once its name is typed, and goes back to the agents', async () => {
    const { server, orders } = withAgents();
    const page = open(`/agents/${orders.id}/settings`, server);
    await screen.findByRole('button', { name: 'Delete agent' });
    press('Delete agent');
    fireEvent.change(within(dialog()).getByLabelText('Type orders to confirm'), {
      target: { value: 'orders' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete agent' }));
    await waitFor(() => expect(page.where()).toBe('/agents'));
    expect(
      server.calls.some(
        (call) => call.method === 'DELETE' && call.path === `/v1/agents/${orders.id}`,
      ),
    ).toBe(true);
  });

  it('has nothing to change for one who does not deploy agents', async () => {
    const { server, orders } = withAgents('viewer');
    open(`/agents/${orders.id}/settings`, server);
    await screen.findByRole('heading', { name: 'General' });
    expect(screen.queryByRole('button', { name: 'Delete agent' })).toBeNull();
  });
});

describe('an actor’s page', () => {
  it('says what it is, and what it and its subagents cost, beside where its conversation goes', async () => {
    const { server, orders } = withAgents();
    const actor = idOf('act', 1);
    server.areas.llm.accounts.push({
      id: `acc_${'0'.repeat(25)}1` as never,
      provider: orders.provider,
      name: 'main',
      credential: 'api_key',
      default: true,
      owner: null,
      actors: 1,
      createdBy: { type: 'user', id: 'usr_1' as never },
      createdAt: 1_795_305_600_000,
    });
    server.actors[0] = { ...(server.actors[0] as Actor), account: `acc_${'0'.repeat(25)}1` };
    // It and the actors under it, as the engine adds them up; and it alone, by kind of call.
    area(server).spent(actor, 1.5);
    server.areas.llm.usageIs(() => ({
      totals: totalsOf({ cost: 1.2 }),
      groups: [
        { key: 'turn', totals: totalsOf({ cost: 1 }) },
        { key: 'compaction', totals: totalsOf({ cost: 0.2 }) },
      ],
    }));
    open(`/agents/${orders.id}/actors/${actor}`, server);
    const side = await screen.findByRole('complementary', { name: 'About the actor' });
    const fact = (name: string) =>
      within(side).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
    await waitFor(() => expect(fact('Account')).toBe('main'));
    expect(fact('Status')).toBe('working');
    expect(fact('Model')).toBe('gpt-6.2-sol');
    expect(fact('Reasoning')).toBe('medium');
    expect(fact('Version')).toBe('v2 · follows the active');
    await waitFor(() => expect(within(side).getByText('$1.50')).toBeTruthy());
    expect(fact('Turns')).toBe('$1.00');
    expect(fact('Compaction')).toBe('$0.20');
    expect(fact('Subagents')).toBe('$0.30');
    // The breadcrumbs name its agent, that agent's Actors, and it by its ID.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(crumbs.textContent).toBe(`Agents/orders/Actors/${actor}`));
  });

  it('resizes its conversation and sidebar by the line between them, and keeps the size', async () => {
    const { server, orders } = withAgents();
    localStorage.removeItem('acentric.actor-split');
    open(`/agents/${orders.id}/actors/${idOf('act', 1)}`, server);
    const line = await screen.findByRole('separator', { name: 'Resize the conversation' });
    expect(line.getAttribute('aria-valuenow')).toBe('65');
    fireEvent.keyDown(line, { key: 'ArrowLeft', shiftKey: true });
    expect(line.getAttribute('aria-valuenow')).toBe('55');
    fireEvent.keyDown(line, { key: 'End' });
    expect(line.getAttribute('aria-valuenow')).toBe('80');
    expect(localStorage.getItem('acentric.actor-split')).toBe('80');
    fireEvent.doubleClick(line);
    expect(line.getAttribute('aria-valuenow')).toBe('65');
  });

  it('draws its conversation as it grows: what it was sent, what the model said and called, and notices', async () => {
    const { server, orders } = withAgents();
    const actor = idOf('act', 1);
    const at = 1_795_305_600_000;
    area(server).conversation(actor, [
      {
        seq: 1,
        createdAt: at,
        message: { role: 'user', content: [{ type: 'text', text: 'Where is A-1042?' }] },
        input: { id: idOf('inp', 1) as never, type: 'message' },
      },
      {
        seq: 2,
        createdAt: at + 1,
        message: {
          role: 'assistant',
          provider: 'openai',
          api: 'openai-responses',
          model: 'gpt-6.2-sol',
          content: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Look it up first.' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'Let me **check**.' }] },
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'lookup_order',
              arguments: '{"id":"A-1042"}',
            },
          ],
        },
        completion: { stopReason: 'tool_use', usage: { totalInput: 100, output: 20 } },
      },
      {
        seq: 3,
        createdAt: at + 2,
        message: {
          role: 'tool_result',
          toolCallId: 'call_1',
          toolName: 'lookup_order',
          content: [{ type: 'text', text: 'Shipped today.' }],
        },
      },
      {
        seq: 4,
        createdAt: at + 3,
        message: {
          role: 'system',
          content: [
            { type: 'text', text: '<task id="b2" kind="bash" status="done">\nok\n</task>' },
          ],
        },
      },
    ]);
    open(`/agents/${orders.id}/actors/${actor}`, server);
    const convo = await screen.findByLabelText('Conversation');
    expect(await within(convo).findByText('Where is A-1042?')).toBeTruthy();
    // Under what it was sent: that it is an input, and a copy of it.
    expect(within(convo).getByText('Input')).toBeTruthy();
    expect(within(convo).getByRole('button', { name: 'Copy the input' })).toBeTruthy();
    expect(within(convo).getByText('check').tagName).toBe('STRONG');
    // Its tool calls are a row each, and a row opened has the result of the call that asked for
    // it, not on its own.
    const call = within(convo).getByRole('button', { name: /^lookup_order/ });
    expect(within(convo).queryByText('Shipped today.')).toBeNull();
    fireEvent.click(call);
    expect(await within(convo).findByText('Shipped today.')).toBeTruthy();
    expect(within(convo).getByRole('button', { name: 'Copy the result' })).toBeTruthy();
    // What it thought is not shown.
    expect(within(convo).queryByText('Look it up first.')).toBeNull();
    // The engine's own line, named for what it is about.
    expect(within(convo).getByText('Task b2 · done')).toBeTruthy();
    // All it says is shown, not folded, with a copy of it.
    expect(within(convo).getByText(/^<task id="b2"/)).toBeTruthy();
    expect(within(convo).getByRole('button', { name: 'Copy the notice' })).toBeTruthy();
    // A message that joins is drawn.
    area(server).say(actor, {
      seq: 5,
      createdAt: at + 4,
      message: { role: 'user', content: [{ type: 'text', text: 'And A-1043?' }] },
      input: { id: idOf('inp', 5) as never, type: 'message' },
    });
    expect(await within(convo).findByText('And A-1043?')).toBeTruthy();
  });

  it('lists its tasks under way and those that ended, each opened, and stops one', async () => {
    const { server, orders } = withAgents();
    const actor = idOf('act', 1);
    const task = (n: number, more: Partial<TaskDetail>): TaskDetail => ({
      id: `task_${String(n)}` as never,
      kind: 'bash',
      status: 'done',
      attached: false,
      startedAt: 1_795_305_600_000,
      endedAt: 1_795_305_603_000,
      input: { command: `echo ${String(n)}` },
      result: `out ${String(n)}`,
      ...more,
    });
    area(server).tasks(actor, [
      task(1, { status: 'running', endedAt: undefined, result: null }),
      task(2, {}),
    ]);
    open(`/agents/${orders.id}/actors/${actor}`, server);
    fireEvent.click(await screen.findByRole('tab', { name: 'Tasks' }));
    const panel = await screen.findByRole('tabpanel');
    const active = await within(panel).findByRole('region', { name: 'Active' });
    const earlier = within(panel).getByRole('region', { name: 'Earlier' });
    expect(within(active).getByText('running')).toBeTruthy();
    expect(within(earlier).getByText('done')).toBeTruthy();
    expect(within(earlier).getByText('3.0s')).toBeTruthy();

    fireEvent.click(within(earlier).getByRole('button', { name: 'bash' }));
    expect(await within(earlier).findByText('out 2')).toBeTruthy();

    fireEvent.click(within(active).getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.method === 'POST' && call.path === `/v1/actors/${actor}/tasks/task_1/stop`,
        ),
      ).toBe(true),
    );
  });

  it('has its agent’s sidebar, with Actors the tab it is on', async () => {
    const { server, orders } = withAgents();
    open(`/actors/${idOf('act', 1)}`, server);
    const side = await screen.findByRole('complementary', { name: 'Sidebar' });
    const actors = await within(side).findByRole('link', { name: 'Actors' });
    expect(actors.getAttribute('href')).toBe(`/agents/${orders.id}/actors`);
    expect(actors.getAttribute('aria-current')).toBe('page');
    expect(within(side).getByRole('link', { name: 'Back to Dashboard' })).toBeTruthy();
    expect(within(side).queryByRole('link', { name: 'Machines' })).toBeNull();
  });

  it('is among its agent’s Actors: its ID alone goes there, keeping what was asked', async () => {
    const { server, orders } = withAgents();
    const actor = idOf('act', 1);
    const page = open(`/actors/${actor}?all=1`, server);
    await waitFor(() => expect(page.where()).toBe(`/agents/${orders.id}/actors/${actor}?all=true`));
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(crumbs.textContent).toBe(`Agents/orders/Actors/${actor}`));
  });

  it('says it is not there for an ID of none', async () => {
    open(`/actors/${idOf('act', 99)}`, withAgents().server);
    expect(await screen.findByText(/Nothing here/)).toBeTruthy();
  });
});
