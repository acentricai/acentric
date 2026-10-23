/**
 * What MDX elements render as, and the components pages may use without
 * importing them: Callout, Steps, Cards and Card, Tabs and Tab, and the
 * diagrams.
 */
import {
  Children,
  isValidElement,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Link } from '@tanstack/react-router';
import type { MDXComponents } from 'mdx/types';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBulb,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconInfoCircle,
} from '@tabler/icons-react';

function Anchor({ href = '', children, ...rest }: ComponentProps<'a'>) {
  if (href.startsWith('/')) {
    const [path, hash] = href.split('#');
    return (
      <Link to={path || '/'} hash={hash} {...rest}>
        {children}
      </Link>
    );
  }
  if (href.startsWith('#'))
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

type PreProps = ComponentProps<'pre'> & { 'data-title'?: string };

/** A highlighted block with its language or file name, and a copy button. */
function CodeBlock({ children, 'data-title': title, className, style, ...rest }: PreProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const code = isValidElement<{ className?: string }>(children) ? children : null;
  const language = /language-(\S+)/.exec(code?.props.className ?? '')?.[1];
  const label = title ?? languageLabel(language);

  const copy = async () => {
    const text = ref.current?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The clipboard can be refused (an insecure origin, a denied permission); the code stays selectable.
    }
  };

  return (
    <figure className="code">
      <figcaption className="code-bar">
        <span className={title ? 'code-title' : 'code-language'}>{label}</span>
        <button
          type="button"
          className="code-copy"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <IconCheck size={15} stroke={1.75} /> : <IconCopy size={15} stroke={1.5} />}
        </button>
      </figcaption>
      <pre ref={ref} className={className} style={style} {...rest}>
        {children}
      </pre>
    </figure>
  );
}

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  javascript: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSON',
  sh: 'Terminal',
  bash: 'Terminal',
  shell: 'Terminal',
  http: 'HTTP',
  text: 'Text',
};

function languageLabel(language: string | undefined): string {
  if (!language) return 'Text';
  return LANGUAGES[language] ?? language;
}

/** A section heading that links to itself on hover. */
function heading(Tag: 'h2' | 'h3') {
  return function Heading({ id, children, ...rest }: ComponentProps<'h2'>) {
    return (
      <Tag id={id} {...rest}>
        {children}
        {id && (
          <a className="heading-anchor" href={`#${id}`} aria-label="Link to this section">
            #
          </a>
        )}
      </Tag>
    );
  };
}

function Table(props: ComponentProps<'table'>) {
  return (
    <div className="table-scroll" tabIndex={0}>
      <table {...props} />
    </div>
  );
}

const CALLOUTS = {
  note: { icon: IconInfoCircle, title: 'Note' },
  tip: { icon: IconBulb, title: 'Tip' },
  warning: { icon: IconAlertTriangle, title: 'Important' },
} as const;

function Callout({
  type = 'note',
  title,
  children,
}: {
  type?: keyof typeof CALLOUTS;
  title?: string;
  children: ReactNode;
}) {
  const { icon: Icon, title: fallback } = CALLOUTS[type];
  return (
    <aside className={`callout callout-${type}`}>
      <Icon className="callout-icon" size={18} stroke={1.6} aria-hidden />
      <div className="callout-body">
        <p className="callout-title">{title ?? fallback}</p>
        {children}
      </div>
    </aside>
  );
}

/** Numbers the `###` headings inside it as steps. */
function Steps({ children }: { children: ReactNode }) {
  return <div className="steps">{children}</div>;
}

function Cards({ children }: { children: ReactNode }) {
  return <div className="cards">{children}</div>;
}

function Card({ title, href, children }: { title: string; href: string; children?: ReactNode }) {
  const external = !href.startsWith('/');
  const body = (
    <>
      <span className="card-title">
        {title}
        {external ? (
          <IconArrowUpRight size={15} stroke={1.6} aria-hidden />
        ) : (
          <IconChevronRight size={15} stroke={1.6} aria-hidden />
        )}
      </span>
      {children && <span className="card-text">{children}</span>}
    </>
  );
  if (external) {
    return (
      <a className="card" href={href} target="_blank" rel="noreferrer">
        {body}
      </a>
    );
  }
  const [path, hash] = href.split('#');
  return (
    <Link className="card" to={path} hash={hash}>
      {body}
    </Link>
  );
}

function Tab({ children }: { label: string; children: ReactNode }) {
  return <>{children}</>;
}

/** Alternatives for the same step, one shown at a time: `<Tabs><Tab label="CLI">…</Tab>…</Tabs>`. */
function Tabs({ children }: { children: ReactNode }) {
  const tabs = Children.toArray(children).filter(
    (child): child is ReactElement<{ label: string; children: ReactNode }> =>
      isValidElement(child) &&
      typeof child.props === 'object' &&
      child.props !== null &&
      typeof Reflect.get(child.props, 'label') === 'string',
  );
  const [active, setActive] = useState(0);
  const id = useId();
  const select = (index: number) => setActive((index + tabs.length) % tabs.length);

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.props.label}
            id={`${id}-tab-${index}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={index === active}
            aria-controls={`${id}-panel`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => select(index)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') select(index + 1);
              else if (event.key === 'ArrowLeft') select(index - 1);
              else return;
              event.preventDefault();
              const next =
                event.currentTarget.parentElement?.children[
                  (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                ];
              if (next instanceof HTMLElement) next.focus();
            }}
          >
            {tab.props.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        className="tab-panel"
        aria-labelledby={`${id}-tab-${active}`}
      >
        {tabs[active]}
      </div>
    </div>
  );
}

export const mdxComponents: MDXComponents = {
  a: Anchor,
  pre: CodeBlock as MDXComponents['pre'],
  table: Table,
  h2: heading('h2'),
  h3: heading('h3'),
  Callout,
  Steps,
  Cards,
  Card,
  Tabs,
  Tab,
};
