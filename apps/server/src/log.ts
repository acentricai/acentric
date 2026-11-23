// What the server says of itself, a line at a time: as text, for a person reading its log, or as
// JSON, one object to a line, for what collects logs. The same lines and the same fields either
// way. Nothing secret is given to it: no request's body, no header, no key, no secret.
//
//   text:  backed up to /backups/acentric-….tar
//          request GET actors.list 200 12ms requestId=9f2c… by=key_01…
//   json:  {"time":"2026-11-23T…","level":"info","msg":"request","method":"GET",…}

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Format = 'text' | 'json';

/** What a line is about, beside what it says: an actor, a request, how long. */
export type Fields = {
  readonly [name: string]: string | number | boolean | null | undefined;
};

export type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  /** `error` is said with it: its message, and in text its stack under the line. */
  error(msg: string, fields?: Fields, error?: unknown): void;
  /** A logger whose every line has `fields` too. */
  child(fields: Fields): Logger;
};

const ORDER: { readonly [level in Level]: number } = { debug: 10, info: 20, warn: 30, error: 40 };

export const LEVELS = Object.keys(ORDER) as Level[];
export const FORMATS: readonly Format[] = ['text', 'json'];

/** A field's value as text: bare when it has no space or quote in it, else as JSON. */
const textOf = (value: string | number | boolean | null): string => {
  const text = String(value);
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text);
};

/** What an error is, said in a line, and its stack. */
function errorOf(error: unknown): { readonly said: string; readonly stack?: string } {
  if (error instanceof Error) {
    return {
      said: `${error.name}: ${error.message}`,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { said: String(error) };
}

export function createLogger(options: {
  readonly format?: Format;
  readonly level?: Level;
  /**
   * Where each line goes, as it is written. Without it, stdout, and stderr for warnings and
   * errors.
   */
  readonly write?: (line: string, level: Level) => void;
  readonly clock?: () => number;
}): Logger {
  const format = options.format ?? 'text';
  const least = ORDER[options.level ?? 'info'];
  const clock = options.clock ?? Date.now;
  const write =
    options.write ??
    ((line: string, level: Level) => {
      (ORDER[level] >= ORDER.warn ? process.stderr : process.stdout).write(`${line}\n`);
    });

  const make = (base: Fields): Logger => {
    const say = (level: Level, msg: string, more: Fields = {}, error?: unknown): void => {
      if (ORDER[level] < least) return;
      const fields: { [name: string]: string | number | boolean | null } = {};
      for (const [name, value] of Object.entries({ ...base, ...more })) {
        if (value !== undefined) fields[name] = value;
      }
      const failed = error === undefined ? undefined : errorOf(error);
      if (format === 'json') {
        write(
          JSON.stringify({
            time: new Date(clock()).toISOString(),
            level,
            msg,
            ...fields,
            ...(failed === undefined
              ? {}
              : {
                  error: failed.said,
                  ...(failed.stack === undefined ? {} : { stack: failed.stack }),
                }),
          }),
          level,
        );
        return;
      }
      const tail = Object.entries(fields)
        .map(([name, value]) => ` ${name}=${textOf(value)}`)
        .join('');
      const head = level === 'warn' || level === 'error' ? `${level}: ` : '';
      const said = failed === undefined ? '' : `: ${failed.said}`;
      // The stack under the line, as Node prints it, without its first line again.
      const stack =
        failed?.stack === undefined ? '' : `\n${failed.stack.split('\n').slice(1).join('\n')}`;
      write(`${head}${msg}${said}${tail}${stack}`, level);
    };
    return {
      debug: (msg, fields) => say('debug', msg, fields),
      info: (msg, fields) => say('info', msg, fields),
      warn: (msg, fields) => say('warn', msg, fields),
      error: (msg, fields, error) => say('error', msg, fields, error),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make({});
}

/** A logger that says nothing: for what is told of nothing. */
export const silent: Logger = createLogger({ write: () => {} });
