import { useMemo, useState } from 'react';
import { config } from './config';
import { DebugPanel, LogDirection, LogEntry } from './components/DebugPanel';

type SessionResponse = {
  session?: Record<string, unknown>;
  client_secret?: { value?: string };
  [key: string]: unknown;
};

const generateId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
};

const App = () => {
  const [bearer, setBearer] = useState('');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addLog = (direction: LogDirection, payload: unknown) => {
    setLogs((prev) => [
      ...prev,
      {
        id: generateId(),
        direction,
        timestamp: new Date().toISOString(),
        payload,
      },
    ]);
  };

  const handleEnableSession = async () => {
    if (!bearer) {
      setError('Add a bearer token before requesting a session.');
      return;
    }

    setLoading(true);
    setError(null);
    setSession(null);

    const url = `${config.apiBaseUrl}/secure/realtime-token`;

    addLog('to-aws', {
      url,
      method: 'POST',
      headers: { Authorization: 'Bearer ***redacted***' },
      body: {},
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({}),
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch (parseErr) {
        parsed = text;
      }

      addLog('from-aws', {
        status: response.status,
        body: parsed,
      });

      if (!response.ok) {
        const message =
          typeof parsed === 'object' && parsed && 'message' in parsed
            ? String((parsed as Record<string, unknown>).message)
            : `Request failed with status ${response.status}`;
        setError(message);
        return;
      }

      setSession((parsed as SessionResponse) ?? {});
      if (parsed && typeof parsed === 'object' && 'session' in parsed) {
        addLog('to-gpt', {
          hint: 'Use this session to open a WebRTC connection with OpenAI.',
          session: (parsed as SessionResponse).session,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addLog('from-aws', { error: message });
    } finally {
      setLoading(false);
    }
  };

  const sessionPreview = useMemo(() => {
    if (!session) {
      return null;
    }

    const secret = session?.client_secret?.value;
    return (
      <div className="session-preview">
        <h2>Realtime Session</h2>
        <p className="session-info">
          Model: <code>{config.realtimeModel}</code>
        </p>
        {secret ? (
          <div className="session-token">
            <p>Client Secret:</p>
            <code>{secret}</code>
          </div>
        ) : (
          <p className="session-hint">
            Pass the JSON payload below to your Realtime WebRTC/WebSocket client.
          </p>
        )}
        <pre className="session-json">{JSON.stringify(session, null, 2)}</pre>
      </div>
    );
  }, [session]);

  return (
    <div className="app-shell">
      <header>
        <h1>Opssage Realtime Playground</h1>
        <p>
          Request an OpenAI Realtime session token via the bearer-protected API, then connect your
          browser to OpenAI using the returned credentials.
        </p>
      </header>

      <section className="controls">
        <label htmlFor="bearer-input">
          Bearer token
          <input
            id="bearer-input"
            type="password"
            placeholder="Paste bearer token"
            value={bearer}
            onChange={(event) => setBearer(event.target.value)}
          />
        </label>

        <button className="primary" onClick={handleEnableSession} disabled={loading}>
          {loading ? 'Requesting session…' : 'Enable session'}
        </button>

        {error ? <p className="error">{error}</p> : null}
      </section>

      {sessionPreview}

      <DebugPanel logs={logs} open={panelOpen} onToggle={() => setPanelOpen((prev) => !prev)} />

      <footer>
        <small>
          API base URL: <code>{config.apiBaseUrl || 'not configured'}</code>
        </small>
      </footer>
    </div>
  );
};

export default App;
