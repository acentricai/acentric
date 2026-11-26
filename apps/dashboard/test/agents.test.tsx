// The Agents pages, from a person's side, against a stand-in for the server: the agents, an
// agent's actors, deployments and secrets, and an actor's page with its conversation.

import type { Account, Actor, Role } from '@acentric/protocol';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { actorFor, definitionOf, idOf } from './fake/agents.ts';
import { open } from './render.tsx';
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
    await waitFor(() => expect(page.where()).toMatch(/^\/actors\/act_/));
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
  const user = (seq: number, text: string) => ({
    seq,
    createdAt: 1_795_305_600_000 + seq,
    message: { role: 'user' as const, content: [{ type: 'text' as const, text }] },
    input: { id: idOf('inp', seq) as never, type: 'message' },
  });
  const model = (seq: number, text: string) => ({
    seq,
    createdAt: 1_795_305_600_000 + seq,
    message: {
      role: 'assistant' as const,
      provider: 'openai',
      api: 'openai-responses',
      model: 'gpt-6.2-sol',
      content: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    },
    completion: { stopReason: 'stop' as const, usage: { totalInput: 100, output: 20 } },
  });

  it('says where it stands, and draws its conversation as it grows', async () => {
    const { server } = withAgents();
    const actor = idOf('act', 1);
    area(server).conversation(actor, [user(1, 'Where is A-1042?'), model(2, 'It ships today.')]);
    area(server).spent(actor, 0.42);
    open(`/actors/${actor}`, server);
    expect(await screen.findByRole('link', { name: 'orders' })).toBeTruthy();
    expect(await screen.findByText('It ships today.')).toBeTruthy();
    expect(screen.getByText('Where is A-1042?')).toBeTruthy();
    expect(screen.getByText('$0.42 spent')).toBeTruthy();
    expect(screen.getByText('1 turn')).toBeTruthy();
    // The breadcrumbs name its agent, that agent's Actors, and it by its ID.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(within(crumbs).getByText('orders')).toBeTruthy());
    expect(crumbs.textContent).toBe(`Agents/orders/Actors/${actor}`);
    expect(within(crumbs).getByRole('link', { name: 'Actors' }).getAttribute('href')).toBe(
      `/agents/${idOf('agt', 1)}/actors`,
    );
    // A message that joins is drawn, whole.
    area(server).say(actor, user(3, 'And A-1043?'));
    expect(await screen.findByText('And A-1043?')).toBeTruthy();
    expect(screen.getByText('2 turns')).toBeTruthy();
  });

  it('sends an input of its agent’s types, once, with an ID of its own', async () => {
    const { server } = withAgents();
    const actor = idOf('act', 2);
    open(`/actors/${actor}`, server);
    const type = (await screen.findByRole('combobox', { name: 'Input type' })) as HTMLSelectElement;
    await waitFor(() =>
      expect([...type.options].map((option) => option.value)).toEqual(['message', 'refund']),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Payload' }), {
      target: { value: '{"text":"Hello"}' },
    });
    press('Send');
    expect(await screen.findByText('sent')).toBeTruthy();
    expect(area(server).sent).toHaveLength(1);
    const [first] = area(server).sent;
    expect(first?.actor).toBe(actor);
    expect(first?.body).toMatchObject({ type: 'message', payload: { text: 'Hello' } });
    expect(first?.body['externalId']).toMatch(/^in_[0-9a-f]{20}$/);
    // A payload that is not JSON is not sent.
    fireEvent.change(screen.getByRole('textbox', { name: 'Payload' }), { target: { value: '{' } });
    press('Send');
    expect(await screen.findByRole('textbox', { name: 'Payload' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Payload' }).getAttribute('aria-invalid')).toBe(
        'true',
      ),
    );
    expect(area(server).sent).toHaveLength(1);
  });

  it('offers a message of text to an actor whose agent declares no input, as every agent takes one', async () => {
    const server = signedIn();
    const plain = area(server).agent('plain', 1, [definitionOf({ inputs: [] })]);
    server.actors.push(actorFor(plain, 7));
    open(`/actors/${idOf('act', 7)}`, server);
    const type = (await screen.findByRole('combobox', { name: 'Input type' })) as HTMLSelectElement;
    await waitFor(() =>
      expect([...type.options].map((option) => option.value)).toEqual(['message']),
    );
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('interrupts one that is working, and archives it after asking', async () => {
    const { server } = withAgents();
    const actor = idOf('act', 1);
    const { where } = open(`/actors/${actor}`, server);
    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt' }));
    expect(
      await screen.findByText('Its turn was ended. Its tasks and subagents go on.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('It was archived: it takes no input.')).toBeTruthy();
    expect(
      server.calls.some(
        (call) => call.method === 'POST' && call.path === `/v1/actors/${actor}/archive`,
      ),
    ).toBe(true);
    // An archived actor is sent nothing.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Send' })).toBeNull());

    // Archived, it may be deleted, after it is asked: then its agent's page is shown.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(within(dialog()).getByText(/It is not undone/)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.method === 'DELETE' && call.path === `/v1/actors/${actor}`,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(where()).toMatch(/^\/agents/));
  });

  it('shows its tasks, with what one was started with, and what waits in its mailbox', async () => {
    const { server } = withAgents();
    const actor = idOf('act', 2);
    area(server).tasks(actor, [
      {
        id: 'b1',
        kind: 'bash',
        status: 'running',
        attached: false,
        startedAt: 1,
        input: { command: 'npm test' },
        result: null,
      },
    ]);
    area(server).waiting(actor, [
      {
        id: idOf('inp', 7) as never,
        actor: actor as never,
        type: 'refund',
        externalId: null,
        message: { role: 'user', content: [] },
        receivedAt: 1,
        deliveredAt: null,
      },
    ]);
    open(`/actors/${actor}`, server);
    const tasks = await screen.findByRole('region', { name: 'Tasks' });
    fireEvent.click(within(tasks).getByRole('button', { name: 'b1' }));
    expect(await within(dialog()).findByText(/npm test/)).toBeTruthy();
    expect(within(dialog()).getByText('Still running')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    const mailbox = screen.getByRole('region', { name: 'Mailbox' });
    expect(within(mailbox).getByText('refund')).toBeTruthy();
    press('Stop', tasks);
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.method === 'POST' && call.path === `/v1/actors/${actor}/tasks/b1/stop`,
        ),
      ).toBe(true),
    );
  });

  it('says it is not there for an ID of none', async () => {
    open(`/actors/${idOf('act', 99)}`, withAgents().server);
    expect(await screen.findByText(/Nothing here/)).toBeTruthy();
  });
});
