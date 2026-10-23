/** Diagrams drawn in the page's own colours, so they follow the theme. */

const box = { fill: 'var(--raised)', stroke: 'var(--line-control)', strokeWidth: 1 } as const;
/** Your code, set apart from the runner's parts. */
const yours = { fill: 'var(--solid)', stroke: 'var(--solid)', strokeWidth: 1 } as const;
const label = {
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'var(--font-sans)',
} as const;
const note = { fill: 'var(--ink-muted)', fontSize: 11.5, fontFamily: 'var(--font-sans)' } as const;
const line = { stroke: 'var(--ink-muted)', strokeWidth: 1.25, fill: 'none' } as const;

function Arrowhead({ id }: { id: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-muted)" />
    </marker>
  );
}

function Node({
  x,
  y,
  w = 128,
  title,
  sub,
  mine = false,
}: {
  x: number;
  y: number;
  w?: number;
  title: string;
  sub?: string;
  /** Whether this is your code rather than the runner's. */
  mine?: boolean;
}) {
  const ink = mine ? 'var(--on-solid)' : 'var(--ink)';
  return (
    <g>
      <rect x={x} y={y} width={w} height={sub ? 54 : 40} rx={10} {...(mine ? yours : box)} />
      <text x={x + w / 2} y={y + (sub ? 23 : 25)} textAnchor="middle" fill={ink} {...label}>
        {title}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={y + 40}
          textAnchor="middle"
          {...note}
          fill={mine ? 'var(--on-solid)' : note.fill}
          opacity={mine ? 0.75 : 1}
        >
          {sub}
        </text>
      )}
    </g>
  );
}

/** One message at a time: step, save, match effects, and results back as messages. */
export function AgentLoop() {
  return (
    <figure className="diagram">
      <svg viewBox="0 0 760 270" role="img" aria-labelledby="agent-loop-title">
        <title id="agent-loop-title">
          A message, from a caller or from a finished effect, goes to step, the agent's pure
          function. The runner saves what step returns, then matches the effects the agent declares
          against those running, starting new ones and cancelling dropped ones. Handlers do the
          effects' I/O, and each result comes back as the next message.
        </title>
        <defs>
          <Arrowhead id="agent-loop-arrow" />
        </defs>

        <text x={70} y={16} textAnchor="middle" {...note}>
          a caller&apos;s input or config
        </text>
        <path d="M70 24 V44" {...line} markerEnd="url(#agent-loop-arrow)" />

        <Node x={10} y={50} w={120} title="Message" sub="one at a time" />
        <Node x={165} y={50} w={180} title="step" sub="your agent, pure" mine />
        <Node x={380} y={50} w={150} title="Save" sub="state and log together" />
        <Node x={565} y={50} w={185} title="Match effects" sub="start new, cancel dropped" />
        <Node x={565} y={185} w={185} title="Handlers" sub="your code, the I/O" mine />

        {['M130 77 H159', 'M345 77 H374', 'M530 77 H559', 'M657 104 V179'].map((path) => (
          <path key={path} d={path} {...line} markerEnd="url(#agent-loop-arrow)" />
        ))}
        <path d="M565 212 H70 V110" {...line} markerEnd="url(#agent-loop-arrow)" />
        <text x={318} y={203} textAnchor="middle" {...note}>
          each result arrives as the next message
        </text>
      </svg>
      <figcaption>
        Your code decides and does the I/O; the runner does everything in between.
      </figcaption>
    </figure>
  );
}
