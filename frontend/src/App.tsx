import { useEffect, useMemo, useRef, useState } from 'react';
import { config } from './config';
import { DebugPanel, LogDirection, LogEntry } from './components/DebugPanel';

type ClientSecret = {
  value?: string;
  token?: string;
};

type RealtimeSession = {
  id?: string;
  client_secret?: ClientSecret;
  [key: string]: unknown;
};

const generateId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
};

const resolveToken = (payload: RealtimeSession | null) =>
  payload?.client_secret?.value ?? payload?.client_secret?.token ?? '';

const App = () => {
  const [bearer, setBearer] = useState('');
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBearer, setShowBearer] = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [talkBusy, setTalkBusy] = useState(false);

  const connectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const stopVoiceSession = () => {
    const pc = connectionRef.current;
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
      connectionRef.current = null;
    }

    const localStream = localStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    const audio = audioRef.current;
    if (audio) {
      audio.srcObject = null;
    }

    if (isTalking) {
      addLog('from-gpt', { event: 'voice-session-stopped' });
    }
    setIsTalking(false);
    setTalkBusy(false);
  };

  useEffect(
    () => () => {
      stopVoiceSession();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const requestRealtimeSession = async (
    options: { reset?: boolean; showSpinner?: boolean } = {},
  ): Promise<RealtimeSession | null> => {
    const { reset = true, showSpinner = true } = options;

    if (!bearer) {
      setError('Add a bearer token before requesting a session.');
      return null;
    }

    if (!config.apiBaseUrl) {
      setError('API base URL is not configured.');
      return null;
    }

    if (showSpinner) {
      setLoading(true);
    }
    if (reset) {
      setSession(null);
    }
    setError(null);

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

      const sessionPayload = (parsed as { session?: RealtimeSession }).session ?? null;

      if (!response.ok) {
        const message =
          typeof parsed === 'object' && parsed && 'message' in parsed
            ? String((parsed as Record<string, unknown>).message)
            : `Request failed with status ${response.status}`;
        setError(message);
        return null;
      }

      setSession(sessionPayload);
      if (sessionPayload) {
        addLog('to-gpt', {
          hint: 'Use this session to open a WebRTC connection with OpenAI.',
          session: sessionPayload,
        });
      }

      return sessionPayload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addLog('from-aws', { error: message });
      return null;
    } finally {
      if (showSpinner) {
        setLoading(false);
      }
    }
  };

  const handleEnableSession = async () => {
    if (!bearer) {
      setError('Add a bearer token before requesting a session.');
      return;
    }

    await requestRealtimeSession();
  };

  const sessionPreview = useMemo(() => {
    if (!session) {
      return null;
    }

    const secret = resolveToken(session);
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

  const startVoiceSession = async (token: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Browser does not support audio capture.');
      return;
    }

    setIsTalking(true);
    setTalkBusy(true);

    try {
      addLog('to-gpt', { event: 'voice-session-start' });

      const pc = new RTCPeerConnection();
      connectionRef.current = pc;

      pc.onconnectionstatechange = () => {
        addLog('from-gpt', { event: 'connection-state', state: pc.connectionState });
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          stopVoiceSession();
        }
      };

      pc.oniceconnectionstatechange = () => {
        addLog('from-gpt', {
          event: 'ice-state',
          state: pc.iceConnectionState,
        });
      };

      pc.ontrack = (event) => {
        addLog('from-gpt', { event: 'audio-track', streams: event.streams.length });
        const audio = audioRef.current;
        if (audio) {
          audio.srcObject = event.streams[0];
          void audio.play().catch((err) => {
            addLog('from-gpt', { event: 'audio-play-error', message: err.message });
          });
        }
      };

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      pc.addTransceiver('audio', { direction: 'sendrecv' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete before sending the offer
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkState = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', checkState);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', checkState);
        }
      });

      addLog('to-gpt', { event: 'webrtc-offer-created' });

      const response = await fetch(
        `https://api.openai.com/v1/realtime?model=${config.realtimeModel}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp ?? '',
        },
      );

      const answerSdp = await response.text();
      addLog('from-gpt', { event: 'webrtc-answer', status: response.status });

      if (!response.ok) {
        throw new Error(`Realtime session rejected (${response.status}): ${answerSdp}`);
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addLog('from-gpt', { error: message });
      stopVoiceSession();
    } finally {
      setTalkBusy(false);
    }
  };

  const handleTalk = async () => {
    if (isTalking || talkBusy) {
      stopVoiceSession();
      return;
    }

    if (!bearer) {
      setError('Add a bearer token before starting a voice session.');
      return;
    }

    const token = resolveToken(session);
    if (!token) {
      setError('Enable the session first to mint a realtime token.');
      return;
    }

    await startVoiceSession(token);
  };

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
        <div className="bearer-row">
          <label htmlFor="bearer-input">
            Bearer token
            <div className="bearer-input-wrapper">
              <input
                id="bearer-input"
                type={showBearer ? 'text' : 'password'}
                placeholder="Paste bearer token"
                value={bearer}
                onChange={(event) => setBearer(event.target.value)}
              />
            </div>
          </label>
          <label className="show-bearer">
            <input
              type="checkbox"
              checked={showBearer}
              onChange={(event) => setShowBearer(event.target.checked)}
            />
            Show bearer
          </label>
        </div>

        <div className="action-row">
          <button className="primary" onClick={handleEnableSession} disabled={loading}>
            {loading ? 'Requesting session…' : 'Enable session'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setLogs([])}
            disabled={logs.length === 0}
          >
            Clear logs
          </button>
          <button
            type="button"
            className={`talk ${isTalking ? 'active' : ''}`}
            onClick={handleTalk}
            disabled={loading || talkBusy || !resolveToken(session)}
          >
            {isTalking ? 'Stop talking' : 'Talk'}
          </button>
        </div>

        {error ? <p className="error">{error}</p> : null}
      </section>

      {sessionPreview}

      <DebugPanel
        logs={logs}
        open={panelOpen}
        onToggle={() => setPanelOpen((prev) => !prev)}
        onClear={() => setLogs([])}
        canClear={logs.length > 0}
      />

      <footer>
        <small>
          API base URL: <code>{config.apiBaseUrl || 'not configured'}</code>
        </small>
      </footer>

      <audio ref={audioRef} autoPlay className="remote-audio" controls />
    </div>
  );
};

export default App;
