// What the server counts and measures, in Prometheus' text format, at /metrics on a port of its
// own (ACENTRIC_METRICS_PORT): for what is inside its network, never through the API's port.
// Counters and histograms are of this process, from when it started; gauges are read when they
// are asked for.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';

type Labels = { readonly [name: string]: string };

const escape = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
const labelsOf = (labels: Labels): string => {
  const entries = Object.entries(labels);
  return entries.length === 0
    ? ''
    : `{${entries.map(([name, value]) => `${name}="${escape(value)}"`).join(',')}}`;
};
const keyOf = (labels: Labels): string => JSON.stringify(Object.entries(labels).toSorted());
const number = (value: number): string =>
  Number.isFinite(value) ? String(value) : value > 0 ? '+Inf' : '-Inf';

type Metric = { render(): string[] };

export class Counter implements Metric {
  readonly #values = new Map<string, { labels: Labels; value: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const key = keyOf(labels);
    const had = this.#values.get(key);
    if (had === undefined) this.#values.set(key, { labels, value: by });
    else had.value += by;
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.#values.values()].map(
        ({ labels, value }) => `${this.name}${labelsOf(labels)} ${number(value)}`,
      ),
    ];
  }
}

export class Gauge implements Metric {
  readonly name: string;
  readonly help: string;
  /** What it is now, each with its labels: read when it is asked for. */
  readonly read: () => readonly { readonly labels?: Labels; readonly value: number }[];
  constructor(name: string, help: string, read: Gauge['read']) {
    this.name = name;
    this.help = help;
    this.read = read;
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      ...this.read().map(
        ({ labels = {}, value }) => `${this.name}${labelsOf(labels)} ${number(value)}`,
      ),
    ];
  }
}

export class Histogram implements Metric {
  readonly #values = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  readonly name: string;
  readonly help: string;
  readonly buckets: readonly number[];
  constructor(name: string, help: string, buckets: readonly number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(value: number, labels: Labels = {}): void {
    const key = keyOf(labels);
    let had = this.#values.get(key);
    if (had === undefined) {
      had = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.#values.set(key, had);
    }
    for (const [index, bound] of this.buckets.entries()) {
      if (value <= bound) had.counts[index] = (had.counts[index] ?? 0) + 1;
    }
    had.sum += value;
    had.count += 1;
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.#values.values()) {
      for (const [index, bound] of this.buckets.entries()) {
        lines.push(
          `${this.name}_bucket${labelsOf({ ...labels, le: number(bound) })} ${String(counts[index] ?? 0)}`,
        );
      }
      lines.push(`${this.name}_bucket${labelsOf({ ...labels, le: '+Inf' })} ${String(count)}`);
      lines.push(`${this.name}_sum${labelsOf(labels)} ${number(sum)}`);
      lines.push(`${this.name}_count${labelsOf(labels)} ${String(count)}`);
    }
    return lines;
  }
}

/** Seconds, for how long a request or a call of a model takes. */
const QUICK = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** Seconds, for how long a turn or a tool call takes. */
const SLOW = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];

export class Metrics {
  readonly #metrics: Metric[] = [];
  readonly #loop = monitorEventLoopDelay({ resolution: 20 });

  readonly requests = this.#add(
    new Counter('acentric_http_requests_total', 'Requests answered, by route, method and status.'),
  );
  readonly requestSeconds = this.#add(
    new Histogram(
      'acentric_http_request_duration_seconds',
      'How long requests took to answer, by route.',
      QUICK,
    ),
  );
  readonly turnsStarted = this.#add(
    new Counter(
      'acentric_turns_started_total',
      'Turns that started: an actor went from idle to working.',
    ),
  );
  readonly turnsEnded = this.#add(
    new Counter(
      'acentric_turns_ended_total',
      'Turns that ended, by how: ok, failed or interrupted.',
    ),
  );
  readonly turnSeconds = this.#add(
    new Histogram(
      'acentric_turn_duration_seconds',
      'How long turns took, by how they ended.',
      SLOW,
    ),
  );
  readonly modelCalls = this.#add(
    new Counter(
      'acentric_model_calls_total',
      'Calls of models, by provider, model, kind (turn or compaction) and outcome (ok, or the failure).',
    ),
  );
  readonly modelSeconds = this.#add(
    new Histogram(
      'acentric_model_call_duration_seconds',
      'How long calls of models took, by provider.',
      QUICK,
    ),
  );
  readonly modelTokens = this.#add(
    new Counter(
      'acentric_model_tokens_total',
      'Tokens of calls of models, by provider, model and what they were: input, output, cache_read or cache_write.',
    ),
  );
  readonly modelCost = this.#add(
    new Counter(
      'acentric_model_cost_dollars_total',
      'What calls of models cost, in US dollars, by provider and model.',
    ),
  );
  readonly toolCalls = this.#add(
    new Counter(
      'acentric_tool_calls_total',
      "Tool calls answered, by kind (agent: the agent's code; engine: the engine's own; task) and outcome.",
    ),
  );
  readonly toolSeconds = this.#add(
    new Histogram(
      'acentric_tool_call_duration_seconds',
      'How long tool calls took, by kind.',
      SLOW,
    ),
  );
  readonly retentionRemoved = this.#add(
    new Counter(
      'acentric_retention_removed_total',
      'What was removed as it had its day: sessions and links that expired, and actors, audit events and usage past how long they are kept.',
    ),
  );
  readonly retentionBytes = this.#add(
    new Counter('acentric_retention_freed_bytes_total', 'Bytes given back to the disk after it.'),
  );
  readonly backupFailures = this.#add(
    new Counter('acentric_backup_failures_total', 'Backups of the server that failed.'),
  );

  constructor(version: string) {
    this.#loop.enable();
    this.gauge('acentric_build_info', 'The version of the server.', () => [
      { labels: { version }, value: 1 },
    ]);
    const started = Date.now() / 1000;
    this.gauge(
      'acentric_process_start_time_seconds',
      'When the server started, in seconds since 1970.',
      () => [{ value: started }],
    );
    this.gauge('acentric_process_resident_memory_bytes', "The server's resident memory.", () => [
      { value: process.memoryUsage.rss() },
    ]);
    this.gauge('acentric_process_heap_used_bytes', "The server's JavaScript heap in use.", () => [
      { value: process.memoryUsage().heapUsed },
    ]);
    this.gauge(
      'acentric_event_loop_delay_seconds',
      "How late the server's event loop ran, by quantile, since it was last asked.",
      () => {
        const values = [0.5, 0.99].map((quantile) => ({
          labels: { quantile: String(quantile) },
          value: this.#loop.percentile(quantile * 100) / 1e9,
        }));
        this.#loop.reset();
        return values;
      },
    );
  }

  #add<M extends Metric>(metric: M): M {
    this.#metrics.push(metric);
    return metric;
  }

  /** A gauge read when the metrics are asked for. */
  gauge(name: string, help: string, read: Gauge['read']): void {
    this.#add(new Gauge(name, help, read));
  }

  /** Every metric, in Prometheus' text format. A gauge that fails to read is left out. */
  render(): string {
    const lines: string[] = [];
    for (const metric of this.#metrics) {
      try {
        lines.push(...metric.render());
      } catch {
        // What could not be read now is not said.
      }
    }
    return `${lines.join('\n')}\n`;
  }

  close(): void {
    this.#loop.disable();
  }
}

/** Serves `metrics` at /metrics, on `host` and `port`: nothing else is there. */
export async function serveMetrics(
  metrics: Metrics,
  host: string,
  port: number,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || (request.url ?? '').split('?')[0] !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(metrics.render());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${String(bound)}/metrics`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
