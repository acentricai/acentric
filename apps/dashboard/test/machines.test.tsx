// The Machines and Sandboxes pages, from a person's side, against a stand-in for the server.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { enrolCommands, installCommand } from '../src/machines/machines.tsx';
import { sandboxDeletion, shortSandboxId } from '../src/machines/sandboxes.tsx';
import { open } from './render.tsx';
import { actorOf, fakeServer, machineOf } from './server.ts';

type AgentId = `agt_${string}`;
const ORDERS = `agt_${'0'.repeat(25)}1` as AgentId;
const BILLING = `agt_${'0'.repeat(25)}2` as AgentId;

const signedIn = () => {
  const server = fakeServer();
  server.person('ada@example.test', 'a-password-for-tests', true);
  server.agents.push({ id: ORDERS, name: 'orders' }, { id: BILLING, name: 'billing' });
  return server;
};
const dialog = () => screen.getByRole('dialog');
const press = (name: string, within_: HTMLElement = document.body) =>
  fireEvent.click(within(within_).getByRole('button', { name }));
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const menu = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};

describe('the Machines page', () => {
  it('lists the machines, with how each stands, what it is and which agents it is for', async () => {
    const server = signedIn();
    server.machines.push(
      machineOf('build-box', {
        agents: [ORDERS],
        enrolled: true,
        online: true,
        os: 'darwin',
        arch: 'arm64',
        hostname: 'studio.local',
        version: '0.15.0',
      }),
      machineOf('old-box', { agents: '*', enrolled: true, lastSeenAt: 1_795_305_000_000 }),
      machineOf('new-box'),
    );
    open('/machines', server);
    await screen.findByText('build-box');
    const cells = (name: string) =>
      within(rowOf(name))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells('build-box').slice(0, 5)).toEqual([
      'build-box',
      'Online',
      'macOS · arm64',
      'orders',
      '0.15.0',
    ]);
    expect(cells('old-box').slice(1, 4)).toEqual([
      expect.stringMatching(/^Offlinelast seen /) as string,
      '—',
      'All agents',
    ]);
    expect(cells('new-box').slice(1, 4)).toEqual(['Not enrolled', '—', 'None']);
  });

  it('says so when there are none', async () => {
    open('/machines', signedIn());
    expect(
      await screen.findByText('No machines. Add one to give actors a place to run commands.'),
    ).toBeTruthy();
  });

  it('adds one for the agents chosen, and shows the commands that enrol it, once', async () => {
    const server = signedIn();
    open('/machines', server);
    await screen.findByText(/^No machines/);
    press('Add a machine');
    const form = dialog();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'build-box' } });
    // All agents, unless some are chosen.
    fireEvent.click(within(form).getByLabelText('All agents, and any deployed later'));
    fireEvent.click(await within(form).findByLabelText('orders'));
    press('Add machine', form);
    expect(await screen.findByRole('heading', { name: 'Enrol build-box' })).toBeTruthy();
    expect(
      server.calls.find((call) => call.path === '/v1/machines' && call.method === 'POST')?.body,
    ).toEqual({
      name: 'build-box',
      agents: [ORDERS],
    });
    const added = server.machines[0];
    const shown = dialog().textContent ?? '';
    expect(shown).toContain(
      `curl -fsSL '${window.location.origin}/install.sh' | sh -s -- --id '${added?.id ?? ''}' --token 'token-build-box'`,
    );
    expect(shown).toContain(`acentric-machine enrol --server '${window.location.origin}'`);
    expect(shown).toContain('acentric-machine connect');
    press('Done');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The token is gone with the dialog; the machine is in the list.
    expect(screen.queryByText(/token-build-box/)).toBeNull();
    expect(await screen.findByText('build-box')).toBeTruthy();
  });

  it('says why a machine could not be added, in the server’s words', async () => {
    const server = signedIn();
    server.machines.push(machineOf('build-box'));
    open('/machines', server);
    await screen.findByText('build-box');
    press('Add a machine');
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'build-box' } });
    press('Add machine', dialog());
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(
      'There is a machine build-box already',
    );
  });

  it('changes which agents a machine is for', async () => {
    const server = signedIn();
    server.machines.push(machineOf('build-box', { agents: '*' }));
    open('/machines', server);
    await screen.findByText('build-box');
    fireEvent.click(
      within(await menu('build-box')).getByRole('menuitem', { name: 'Change agents' }),
    );
    expect(await screen.findByRole('heading', { name: 'Agents on build-box' })).toBeTruthy();
    fireEvent.click(within(dialog()).getByLabelText('All agents, and any deployed later'));
    fireEvent.click(await within(dialog()).findByLabelText('billing'));
    press('Save', dialog());
    await waitFor(() => expect(server.machines[0]?.agents).toEqual([BILLING]));
    expect(await screen.findByText('billing')).toBeTruthy();
  });

  it('gives a new token to enrol a machine again, and none for a sandbox', async () => {
    const server = signedIn();
    server.machines.push(
      machineOf('build-box', { enrolled: true }),
      machineOf('sandbox-1', { provider: 'prv_1' as never }),
    );
    open('/machines', server);
    await screen.findByText('sandbox-1');
    expect(
      within(await menu('sandbox-1'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Change agents', 'Remove']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(within(await menu('build-box')).getByRole('menuitem', { name: 'Enrol again' }));
    press('New token', await screen.findByRole('dialog'));
    expect(await within(dialog()).findByText('token-again-1')).toBeTruthy();
  });

  it('removes a machine once its name is typed', async () => {
    const server = signedIn();
    server.machines.push(machineOf('build-box'));
    open('/machines', server);
    await screen.findByText('build-box');
    fireEvent.click(within(await menu('build-box')).getByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog');
    const remove = within(confirm).getByRole('button', {
      name: 'Remove machine',
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.change(within(confirm).getByLabelText('Type build-box to confirm'), {
      target: { value: 'build-box' },
    });
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    expect(await screen.findByText(/^No machines/)).toBeTruthy();
    expect(server.machines).toEqual([]);
  });
});

describe('the Machines page’s filter', () => {
  const withTypes = () => {
    const server = signedIn();
    server.providers.push(
      {
        id: 'prv_1' as never,
        kind: 'boat',
        name: 'work',
        account: null,
        sandboxes: 1,
        createdAt: 0,
      },
      {
        id: 'prv_2' as never,
        kind: 'docker',
        name: 'local',
        account: null,
        sandboxes: 1,
        createdAt: 0,
      },
    );
    server.machines.push(
      machineOf('laptop'),
      machineOf('work-1', { provider: 'prv_1' as never }),
      machineOf('local-1', { provider: 'prv_2' as never }),
    );
    return server;
  };
  const shown = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent);
  const filter = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /^Type/ }));
    return screen.findByRole('group', { name: 'Type' });
  };

  it('offers personal machines and each sandbox account, and shows only what is ticked', async () => {
    const page = open('/machines', withTypes());
    await screen.findByText('work-1');
    expect(shown()).toEqual(['laptop', 'work-1', 'local-1']);
    // Nothing chosen: the chip is its name, and nothing clears it.
    expect(screen.getByRole('button', { name: 'Type' }).textContent).toBe('Type');
    expect(screen.queryByRole('button', { name: 'Clear Type' })).toBeNull();
    const types = await filter();
    expect(
      within(types)
        .getAllByRole('checkbox')
        .map((box) => [box.closest('label')?.textContent, (box as HTMLInputElement).checked]),
    ).toEqual([
      ['Personal', false],
      ['work', false],
      ['local', false],
    ]);
    fireEvent.click(within(types).getByLabelText('Personal'));
    await waitFor(() => expect(shown()).toEqual(['laptop']));
    expect(page.where()).toBe('/machines?type=personal');
    expect(screen.getByRole('button', { name: 'Type: Personal' }).textContent).toBe('TypePersonal');
    // The list stays open while more is ticked.
    fireEvent.click(within(types).getByLabelText('local'));
    await waitFor(() => expect(shown()).toEqual(['laptop', 'local-1']));
    expect(page.where()).toBe('/machines?type=personal%2Cprv_2');
    // Two or more are said by how many; all of them are said to assistive technology.
    expect(screen.getByRole('button', { name: 'Type: Personal, local' }).textContent).toBe(
      'Type2 selected',
    );
    // Unticking all of them is no filter.
    fireEvent.click(within(types).getByLabelText('Personal'));
    fireEvent.click(within(types).getByLabelText('local'));
    await waitFor(() => expect(shown()).toEqual(['laptop', 'work-1', 'local-1']));
    expect(page.where()).toBe('/machines');
    expect(screen.queryByRole('button', { name: 'Clear Type' })).toBeNull();
  });

  it('is cleared at once by the button at its start', async () => {
    const page = open('/machines?type=personal,prv_1', withTypes());
    await screen.findByText('work-1');
    expect(shown()).toEqual(['laptop', 'work-1']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Type' }));
    await waitFor(() => expect(shown()).toEqual(['laptop', 'work-1', 'local-1']));
    expect(page.where()).toBe('/machines');
    expect(screen.queryByRole('button', { name: 'Clear Type' })).toBeNull();
  });

  it('is read from the address, and leaves out what is none of its types', async () => {
    open('/machines?type=prv_1,prv_gone,nonsense', withTypes());
    await screen.findByText('work-1');
    expect(shown()).toEqual(['work-1']);
    expect(screen.getByRole('button', { name: 'Type: work' })).toBeTruthy();
  });

  it('says so when no machine is of the types ticked', async () => {
    const server = withTypes();
    server.machines.splice(0, 1);
    open('/machines?type=personal', server);
    expect(await screen.findByText('No machines match the filters.')).toBeTruthy();
  });
});

describe('the Machines page’s Agents filter', () => {
  const actorId = (n: number) => `act_${'0'.repeat(25)}${String(n)}`;
  const withActors = () => {
    const server = signedIn();
    const [box, laptop, spare] = [machineOf('box'), machineOf('laptop'), machineOf('spare')];
    server.machines.push(box, laptop, spare);
    const on = (machine: { id: string }) => ({
      machine: { id: machine.id as never, cwd: '~/work', env: [] },
    });
    server.actors.push(
      actorOf(actorId(1), ORDERS, { name: 'eu-desk', createdAt: 2, ...on(box) }),
      actorOf(actorId(2), ORDERS, { status: 'working', createdAt: 1, ...on(laptop) }),
      actorOf(actorId(3), ORDERS, { name: 'gone', status: 'archived', ...on(spare) }),
      actorOf(actorId(4), BILLING, { name: 'invoices', ...on(spare) }),
    );
    return server;
  };
  const shown = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent);
  const bar = () => document.querySelector('.filter-bar') as HTMLElement;
  const agents = async () => {
    fireEvent.click(within(bar()).getByRole('button', { name: /^Agents/ }));
    return within(bar()).findByRole('group', { name: 'Agents' });
  };
  const actorsOf = async (agent: string) => {
    fireEvent.mouseEnter(screen.getByLabelText(agent).closest('.filter-chip__row') as Element);
    return screen.findByRole('group', { name: `Active actors of ${agent}` });
  };

  it('lists the agents deployed, and shows the machines of an agent’s actors not archived', async () => {
    const page = open('/machines', withActors());
    await screen.findByText('spare');
    const list = await agents();
    expect(
      within(list)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['orders', 'billing']);
    fireEvent.click(within(list).getByLabelText('orders'));
    await waitFor(() => expect(shown()).toEqual(['box', 'laptop']));
    expect(page.where()).toBe(`/machines?agent=${ORDERS}`);
    expect(screen.getByRole('button', { name: 'Agents: orders' }).textContent).toBe('Agentsorders');
    fireEvent.click(within(list).getByLabelText('billing'));
    await waitFor(() => expect(shown()).toEqual(['box', 'laptop', 'spare']));
    expect(screen.getByRole('button', { name: 'Agents: orders, billing' })).toBeTruthy();
  });

  it('shows an agent’s active actors beside it, and the machines of those ticked', async () => {
    const page = open('/machines', withActors());
    await screen.findByText('spare');
    await agents();
    const actors = await actorsOf('orders');
    // Those archived are not offered, the newest is first, and one with no name is its ID.
    await waitFor(() =>
      expect(
        within(actors)
          .getAllByRole('checkbox')
          .map((box) => box.closest('label')?.textContent),
      ).toEqual(['eu-desk', actorId(2)]),
    );
    fireEvent.click(within(actors).getByLabelText('eu-desk'));
    await waitFor(() => expect(shown()).toEqual(['box']));
    expect(page.where()).toBe(`/machines?actor=${actorId(1)}`);
    expect(screen.getByRole('button', { name: 'Agents: eu-desk' })).toBeTruthy();
    // Another agent's actor is beside that agent, and both are kept.
    const billing = await actorsOf('billing');
    await waitFor(() => expect(within(billing).getByLabelText('invoices')).toBeTruthy());
    fireEvent.click(within(billing).getByLabelText('invoices'));
    await waitFor(() => expect(shown()).toEqual(['box', 'spare']));
    expect(screen.getByRole('button', { name: 'Agents: eu-desk, invoices' }).textContent).toBe(
      'Agents2 selected',
    );
  });

  it('is read from the address, with the Type filter, and cleared at once', async () => {
    const page = open(
      `/machines?type=personal&agent=${BILLING},agt_nonsense&actor=${actorId(3)}`,
      withActors(),
    );
    // An actor named is shown though it is archived.
    await waitFor(() => expect(shown()).toEqual(['spare']));
    expect(await screen.findByRole('button', { name: 'Agents: billing, gone' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Agents' }));
    await waitFor(() => expect(shown()).toEqual(['box', 'laptop', 'spare']));
    expect(page.where()).toBe('/machines?type=personal');
  });

  it('is reached from the keyboard: the arrow opens an agent’s actors, and back', async () => {
    open('/machines', withActors());
    await screen.findByText('spare');
    await agents();
    const arrow = screen.getByRole('button', { name: 'Actors of orders' });
    fireEvent.keyDown(arrow, { key: 'ArrowRight' });
    const actors = await screen.findByRole('group', { name: 'Active actors of orders' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(actors).getByLabelText('eu-desk')),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(arrow));
    expect(screen.queryByRole('group', { name: 'Active actors of orders' })).toBeNull();
  });

  it('says so when an agent has no active actors', async () => {
    const server = withActors();
    server.actors.splice(3, 1);
    open('/machines', server);
    await screen.findByText('spare');
    await agents();
    const actors = await actorsOf('billing');
    expect(await within(actors).findByText('No active actors.')).toBeTruthy();
  });
});

describe('the commands that enrol a machine', () => {
  it('quote what they are given, whatever it is', () => {
    const token = {
      machine: machineOf('x', { id: "mch_it's" as never }),
      token: 'a b',
      expiresAt: 0,
    };
    expect(installCommand(token, 'https://engine.example')).toBe(
      "curl -fsSL 'https://engine.example/install.sh' | sh -s -- --id 'mch_it'\\''s' --token 'a b'",
    );
    expect(enrolCommands(token, 'https://engine.example')).toEqual([
      "acentric-machine enrol --server 'https://engine.example' --id 'mch_it'\\''s' --token 'a b'",
      'acentric-machine connect',
    ]);
  });
});

describe('the Sandboxes pages', () => {
  it('add a Boat account by its API key, and say why one was refused', async () => {
    const server = signedIn();
    open('/sandboxes', server);
    expect(
      await screen.findByText('No accounts. Add a Boat account to make sandboxes from here.'),
    ).toBeTruthy();
    press('Add account');
    const form = dialog();
    const add = within(form).getByRole('button', { name: 'Add account' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'personal' } });
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'boat_refused' } });
    fireEvent.click(add);
    expect((await within(form).findByRole('alert')).textContent).toBe('Boat refused the API key');
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: ' boat_good ' } });
    fireEvent.click(add);
    expect(await screen.findByRole('link', { name: 'personal' })).toBeTruthy();
    expect(
      server.calls.filter((call) => call.path === '/v1/providers' && call.method === 'POST').at(-1)
        ?.body,
    ).toEqual({
      kind: 'boat',
      name: 'personal',
      apiKey: 'boat_good',
    });
    const cells = within(rowOf('personal'))
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells.slice(0, 4)).toEqual(['personal', 'Boat', 'ada@example.test', '0']);
  });

  it('make a sandbox in an account, list it, and delete it once its name is typed', async () => {
    const server = signedIn();
    server.providers.push({
      id: 'prv_1' as never,
      kind: 'boat',
      name: 'personal',
      account: null,
      sandboxes: 0,
      createdAt: 0,
    });
    const page = open('/sandboxes', server);
    fireEvent.click(await screen.findByRole('link', { name: 'personal' }));
    expect(await screen.findByText('No sandboxes')).toBeTruthy();
    expect(page.where()).toBe('/sandboxes/prv_1');
    press('Create sandbox');
    const form = dialog();
    fireEvent.change(within(form).getByLabelText('Size'), { target: { value: '0' } });
    fireEvent.change(within(form).getByLabelText('Stop when idle for'), {
      target: { value: '600' },
    });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'work-1' } });
    press('Create sandbox', form);
    await screen.findByText('work-1');
    expect(server.calls.find((call) => call.path === '/v1/sandboxes')?.body).toEqual({
      provider: 'prv_1',
      vcpu: 2,
      memoryGB: 4,
      idleTimeoutSeconds: 600,
      agents: '*',
      name: 'work-1',
    });
    const cells = within(rowOf('work-1'))
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells.slice(0, 6)).toEqual([
      'work-1',
      'Online',
      '2 vCPU · 4 GB',
      'All agents',
      'sbx_1',
      '10 minutes',
    ]);
    expect(screen.getByRole('columnheader', { name: 'Boat ID' })).toBeTruthy();

    fireEvent.click(within(await menu('work-1')).getByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(sandboxDeletion('boat'))).toBeTruthy();
    fireEvent.change(within(confirm).getByLabelText('Type work-1 to confirm'), {
      target: { value: 'work-1' },
    });
    press('Delete sandbox', confirm);
    expect(await screen.findByText('No sandboxes')).toBeTruthy();
    expect(server.sandboxes).toEqual([]);
  });

  it('do not remove an account that has sandboxes: the server’s reason is shown', async () => {
    const server = signedIn();
    server.providers.push({
      id: 'prv_1' as never,
      kind: 'boat',
      name: 'personal',
      account: null,
      sandboxes: 1,
      createdAt: 0,
    });
    server.sandboxes.push({
      machine: machineOf('work-1', { provider: 'prv_1' as never }),
      provider: 'prv_1' as never,
      kind: 'boat',
      providerSandboxId: null,
      vcpu: 2,
      memoryGB: 4,
      idleTimeoutSeconds: 3600,
      state: 'stopped',
    });
    open('/sandboxes', server);
    await screen.findByRole('link', { name: 'personal' });
    fireEvent.click(within(await menu('personal')).getByRole('menuitem', { name: 'Remove' }));
    press('Remove', await screen.findByRole('dialog'));
    expect(await within(dialog()).findByText("Remove this account's sandboxes first")).toBeTruthy();
  });

  it('say a sandbox’s state when its daemon is not connected', async () => {
    const server = signedIn();
    server.providers.push({
      id: 'prv_1' as never,
      kind: 'docker',
      name: 'local',
      account: null,
      sandboxes: 2,
      createdAt: 0,
    });
    const asleep = machineOf('asleep', { provider: 'prv_1' as never, enrolled: true });
    const waking = machineOf('waking', { provider: 'prv_1' as never });
    const sandbox = (machine: typeof asleep, state: 'stopped' | 'starting') => ({
      machine,
      provider: 'prv_1' as never,
      kind: 'docker',
      providerSandboxId: 'f'.repeat(64),
      vcpu: 2,
      memoryGB: 4,
      idleTimeoutSeconds: 7200,
      state,
    });
    server.sandboxes.push(sandbox(asleep, 'stopped'), sandbox(waking, 'starting'));
    open('/sandboxes/prv_1', server);
    await screen.findByText('asleep');
    const cells = (name: string) =>
      within(rowOf(name))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells('asleep')[1]).toBe('Stopped');
    expect(cells('waking')[1]).toBe('Connecting');
    // Docker's IDs are shown as Docker shows them; the idle time not offered is said as it is.
    expect(cells('asleep').slice(4, 6)).toEqual(['f'.repeat(12), '2 h']);
    expect(screen.getByRole('columnheader', { name: 'Docker ID' })).toBeTruthy();
    expect(shortSandboxId('sbx_1')).toBe('sbx_1');
  });
});
