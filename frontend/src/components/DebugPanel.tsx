import { useMemo } from 'react';
import '../styles.css';

export type LogDirection = 'to-gpt' | 'from-gpt' | 'to-aws' | 'from-aws';

export interface LogEntry {
  id: string;
  direction: LogDirection;
  timestamp: string;
  payload: unknown;
}

interface Props {
  logs: LogEntry[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  onDownload: () => void;
  canClear: boolean;
  canDownload: boolean;
}

export const directionLabel: Record<LogDirection, string> = {
  'to-gpt': 'to gpt',
  'from-gpt': 'from gpt',
  'to-aws': 'to aws',
  'from-aws': 'from aws',
};

export const DebugPanel = ({
  logs,
  open,
  onToggle,
  onClear,
  onDownload,
  canClear,
  canDownload,
}: Props) => {
  const content = useMemo(
    () =>
      logs.map((log) => {
        const serialised =
          typeof log.payload === 'string'
            ? log.payload
            : JSON.stringify(log.payload, null, 2);

        return (
          <article key={log.id} className={`log-entry ${log.direction}`}>
            <header>
              <span className="log-direction">{directionLabel[log.direction]}</span>
              <time>{new Date(log.timestamp).toLocaleTimeString()}</time>
            </header>
            <pre>{serialised}</pre>
          </article>
        );
      }),
    [logs],
  );

  return (
    <section className={`debug-panel ${open ? 'open' : 'closed'}`}>
      <div className="panel-header">
        <button type="button" className="toggle" onClick={onToggle}>
          {open ? 'Hide debug' : 'Show debug'}
        </button>
        <button
          type="button"
          className="download"
          onClick={onDownload}
          disabled={!canDownload}
        >
          Download
        </button>
        <button type="button" className="clear" onClick={onClear} disabled={!canClear}>
          Clear
        </button>
      </div>
     {open ? <div className="log-scroll">{content}</div> : null}
    </section>
  );
};
