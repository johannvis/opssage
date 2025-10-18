import { useEffect, useMemo, useRef, useState } from 'react';
import { config, defaultRealtimeModel } from './config';
import { DebugPanel, LogDirection, LogEntry, directionLabel } from './components/DebugPanel';

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

const MODEL_STORAGE_KEY = 'opssage:model-override';
const TRANSCRIPTION_ENABLED_KEY = 'opssage:transcription-enabled';
const TRANSCRIPTION_MODEL_KEY = 'opssage:transcription-model';
const COMPLETE_KEYWORD = 'complete';
const TEXT_KEYS = new Set(['text', 'transcript', 'caption']);
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const TRANSCRIPTION_PROMPT =
  [
    'Transcribe exactly what the user said between the most recent "hey model test" wake phrase and the moment they said "complete".',
    'Return a single JSON object of the form {"transcript":"<text>"}.',
    'Do not include any additional commentary and do not output audio.',
  ].join(' ');
const BASE_INSTRUCTIONS =
  [
    'Remain silent when the session begins. Do not greet the user or prompt them unless explicitly instructed by the client application.',
    'Only respond when the client sends you a `response.create` message. Treat any automatic turn-detection events as noise and do not initiate your own replies.',
    'When the user says "hey model test", respond once with the exact phrase "whats your test. Please say \"complete\" when you are finished speaking." and then stay silent.',
    'After answering the wake phrase, ignore all other user speech until the client sends you further instructions. The client will issue follow-up `response.create` messages after the user says "complete".',
    'Never improvise additional prompts such as "Please continue" or "Complete.". Only speak the explicit instructions provided by the client.',
    'Speak only in English regardless of the language used by the user.',
  ].join(' ');
const MANUAL_TURN_DETECTION = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 200,
  idle_timeout_ms: 6000,
  create_response: false,
  interrupt_response: false,
};
const initialModelValue = () => {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  }
  return defaultRealtimeModel;
};

const initialTranscriptionEnabled = () => {
  if (typeof window !== 'undefined') {
    return window.localStorage.getItem(TRANSCRIPTION_ENABLED_KEY) === 'true';
  }
  return false;
};

const initialTranscriptionModel = () => {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(TRANSCRIPTION_MODEL_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  }
  return DEFAULT_TRANSCRIPTION_MODEL;
};

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
  const [model, setModel] = useState(initialModelValue);
  const [enableTranscription, setEnableTranscription] = useState(initialTranscriptionEnabled);
  const [transcriptionModel, setTranscriptionModel] = useState(initialTranscriptionModel);

  const connectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
const lastUserUtteranceRef = useRef<string | null>(null);
const modeRef = useRef<'normal' | 'test'>('normal');
const testTranscriptRef = useRef<string[]>([]);
const turnDetectionDisabledRef = useRef(false);
const pendingSessionUpdatesRef = useRef<any[]>([]);
const currentResponseIdRef = useRef<string | null>(null);
const allowNextResponseRef = useRef(false);

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

  const handleDownloadLogs = () => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!logs.length) {
      return;
    }

    const entries = logs.map((log) => {
      const channel = directionLabel[log.direction];
      const isoTimestamp = log.timestamp;
      const localTimestamp = new Date(isoTimestamp).toLocaleString();
      const header = `${localTimestamp} ${channel}`;
      return {
        header,
        timestamp: isoTimestamp,
        channel,
        payload: log.payload,
      };
    });

    const serialized = JSON.stringify(entries, null, 2);
    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `opssage-debug-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const extractTextValues = (value: unknown): string[] => {
    const segments: string[] = [];

    const visit = (node: unknown) => {
      if (node == null) {
        return;
      }
      if (typeof node === 'string') {
        const trimmed = node.trim();
        if (trimmed) {
          segments.push(trimmed);
        }
        return;
      }
      if (typeof node === 'object') {
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        const record = node as Record<string, unknown>;
        for (const [key, val] of Object.entries(record)) {
          if (TEXT_KEYS.has(key) && typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed) {
              segments.push(trimmed);
            }
            continue;
          }
          if (key === 'instructions') {
            continue;
          }
          visit(val);
        }
      }
    };

    visit(value);
    return segments;
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

    const dc = dataChannelRef.current;
    if (dc) {
      try {
        dc.onopen = null;
        dc.onmessage = null;
        dc.close();
      } catch (err) {
        // ignore
      }
      dataChannelRef.current = null;
    }
    while (pendingSessionUpdatesRef.current.length) {
      pendingSessionUpdatesRef.current.shift();
    }

    const audio = audioRef.current;
    if (audio) {
      audio.srcObject = null;
    }

    resetCapture();

    if (isTalking) {
      addLog('from-gpt', { event: 'voice-session-stopped' });
    }
    setIsTalking(false);
    setTalkBusy(false);
    turnDetectionDisabledRef.current = false;
  };

  useEffect(
    () => () => {
      stopVoiceSession();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MODEL_STORAGE_KEY, model);
    }
  }, [model]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        TRANSCRIPTION_ENABLED_KEY,
        enableTranscription ? 'true' : 'false',
      );
    }
  }, [enableTranscription]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TRANSCRIPTION_MODEL_KEY, transcriptionModel);
    }
  }, [transcriptionModel]);

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
    const activeModel = model.trim() || config.realtimeModel;

    const transcriptionModelName = transcriptionModel.trim() || DEFAULT_TRANSCRIPTION_MODEL;

    const requestBody: Record<string, unknown> = {
      model: activeModel,
      instructions: BASE_INSTRUCTIONS,
      turn_detection: { ...MANUAL_TURN_DETECTION },
    };

    if (enableTranscription) {
      requestBody.input_audio_transcription = { model: transcriptionModelName };
    }

    addLog('to-aws', {
      url,
      method: 'POST',
      headers: { Authorization: 'Bearer ***redacted***' },
      body: requestBody,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(requestBody),
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
        return null;
      }

      const sessionPayload = (parsed as { session?: RealtimeSession }).session ?? null;
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
    const activeModel = model.trim() || config.realtimeModel;
    const sessionTranscription = (session?.input_audio_transcription as { model?: string } | undefined)?.model;
    const transcriptionModelName = transcriptionModel.trim() || DEFAULT_TRANSCRIPTION_MODEL;
    const transcriptionLabel = sessionTranscription ?? (enableTranscription ? transcriptionModelName : 'disabled');
    return (
      <div className="session-preview">
        <h2>Realtime Session</h2>
        <p className="session-info">
          Model: <code>{session?.model ?? activeModel}</code>
        </p>
        <p className="session-info">
          Transcription: <code>{transcriptionLabel}</code>
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
  }, [session, model, enableTranscription, transcriptionModel]);

const resetCapture = () => {
  modeRef.current = 'normal';
  testTranscriptRef.current = [];
  lastUserUtteranceRef.current = null;
  allowNextResponseRef.current = false;
};

const TRIGGER_PHRASES = ['hay model', 'hey model', 'hay, model', 'hey, model'];
const STOP_PHRASES = ['model stop', 'muddle stop', 'model, stop', 'muddle, stop'];
const COMMON_SINGLE_WORDS = new Set([
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank',
  'yes',
  'no',
  'ok',
  'okay',
  'test',
  'testing',
  'stop',
  'start',
  'help',
  'sure',
  'please',
]);

const normaliseUtterance = (value: string) => {
  const lowered = value.trim().toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9\s]/g, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
};

const isLikelyNoise = (normalized: string) => {
  if (!normalized) {
    return true;
  }
  if (TRIGGER_PHRASES.includes(normalized) || STOP_PHRASES.includes(normalized)) {
    return false;
  }
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length === 0) {
    return true;
  }
  if (parts.length === 1) {
    return !COMMON_SINGLE_WORDS.has(parts[0]);
  }
  return false;
};

const sendRealtimeInstruction = (
  text: string,
  options: { modalities?: Array<'audio' | 'text'>; exact?: boolean } = {},
) => {
    const dc = dataChannelRef.current;
    const modalities = options.modalities ?? ['audio', 'text'];
    const instructionPrefix = 'Respond only in English.';
    const instructions = options.exact
      ? `${instructionPrefix} Say exactly: "${text}".`
      : `${instructionPrefix} ${text}`;
    const content: Array<Record<string, unknown>> = [];
    if (modalities.includes('text')) {
      content.push({ type: 'output_text', text });
    }
    const payload = {
      type: 'response.create',
      response: {
        modalities,
        instructions,
        conversation: 'none',
      },
    };

    allowNextResponseRef.current = true;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(payload));
      addLog('to-gpt', { event: 'instruction', payload });
    } else {
      addLog('to-gpt', { event: 'instruction-buffered', payload });
    }
  };

  const sendSessionUpdate = (sessionPatch: Record<string, unknown>) => {
    const dc = dataChannelRef.current;
    const payload = {
      type: 'session.update',
      session: sessionPatch,
    };

    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(payload));
      addLog('to-gpt', { event: 'session-update', payload });
    } else {
      pendingSessionUpdatesRef.current.push(payload);
      addLog('to-gpt', { event: 'session-update-buffered', payload });
    }
  };

  const sendCancelActiveResponse = (responseId?: string | null) => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== 'open') {
      return;
    }

    const targetId = responseId ?? currentResponseIdRef.current;
    if (!targetId) {
      return;
    }

    const payload = { type: 'response.cancel', response_id: targetId };
    dc.send(JSON.stringify(payload));
    addLog('to-gpt', { event: 'response-cancel', payload });
    if (currentResponseIdRef.current === targetId) {
      currentResponseIdRef.current = null;
    }
  };

const disableAutoResponses = () => {
  if (turnDetectionDisabledRef.current) {
    return;
  }

  sendSessionUpdate({
    turn_detection: { ...MANUAL_TURN_DETECTION },
  });
  turnDetectionDisabledRef.current = true;
};


  const submitPingRequest = async (testText: string): Promise<string | null> => {
    if (!config.apiBaseUrl) {
      addLog('from-aws', { error: 'API base URL is not configured.' });
      setError('API base URL is not configured.');
      return null;
    }

    if (!bearer) {
      addLog('from-aws', { error: 'Bearer token is required for ping requests.' });
      setError('Add your bearer token before running the test.');
      return null;
    }

    const url = new URL(`${config.apiBaseUrl}/secure/ping`);
    if (testText.trim()) {
      url.searchParams.set('number', testText.trim());
    }
    addLog('to-aws', {
      url: url.toString(),
      method: 'GET',
      headers: { Authorization: 'Bearer ***redacted***' },
    });

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bearer}`,
        },
      });

      const raw = await response.text();
      let parsed: unknown = raw;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch (_err) {
        parsed = raw;
      }

      addLog('from-aws', {
        status: response.status,
        body: parsed,
      });

      if (!response.ok) {
        setError(`Ping request failed with status ${response.status}`);
        return null;
      }

      if (parsed && typeof parsed === 'object' && 'message' in parsed) {
        return String((parsed as Record<string, unknown>).message);
      }

      if (typeof parsed === 'string') {
        return parsed;
      }

      return raw.trim() ? raw : 'Ping succeeded.';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog('from-aws', { error: message });
      setError(`Ping request failed: ${message}`);
      return null;
    }
  };


  const respondNormally = (userText: string) => {
    sendRealtimeInstruction(`The user said: ${userText}. Respond helpfully and conversationally.`);
  };

  const enterTestMode = (rawUtterance: string) => {
    addLog('from-gpt', { event: 'test-mode-entered', text: rawUtterance });
    modeRef.current = 'test';
    testTranscriptRef.current = [rawUtterance];
    disableAutoResponses();
    sendCancelActiveResponse();
    sendRealtimeInstruction('what do you want to test', { modalities: ['audio', 'text'], exact: true });
  };

  const appendTestTranscript = (rawUtterance: string) => {
    testTranscriptRef.current.push(rawUtterance);
  };

  const exitTestMode = () => {
    const rawPieces = testTranscriptRef.current.slice();
    const normalizedPieces = rawPieces.map((value) => value.trim());
    const bodyStartIndex = normalizedPieces.findIndex((value) => TRIGGER_PHRASES.includes(normaliseUtterance(value)));
    const effectivePieces =
      bodyStartIndex === -1 ? normalizedPieces : normalizedPieces.slice(bodyStartIndex + 1);
    const stopIndex = effectivePieces.findIndex((value) => STOP_PHRASES.includes(normaliseUtterance(value)));
    const withoutStop = stopIndex === -1 ? effectivePieces : effectivePieces.slice(0, stopIndex);
    const transcript = withoutStop.join(' ').replace(/\s+/g, ' ').trim();
    addLog('from-gpt', { event: 'test-mode-exit', transcript });
    modeRef.current = 'normal';
    testTranscriptRef.current = [];
    if (transcript) {
      void (async () => {
        const pingResult = await submitPingRequest(transcript);
        if (pingResult) {
          sendRealtimeInstruction(`Ping response: ${pingResult}`, {
            modalities: ['audio', 'text'],
            exact: true,
          });
        } else {
          sendRealtimeInstruction('Ping request failed.', {
            modalities: ['audio', 'text'],
            exact: true,
          });
        }
      })();
    }
  };

  const handleRecognizedText = (utterance: string) => {
    const rawUtterance = utterance;
    if (!rawUtterance) {
      return;
    }

    const text = rawUtterance.trim();
    if (!text) {
      return;
    }

    const previous = lastUserUtteranceRef.current;
    if (previous === text) {
      return;
    }
    lastUserUtteranceRef.current = text;

    const normalized = normaliseUtterance(text);

    if (modeRef.current === 'test') {
      appendTestTranscript(rawUtterance);
      if (STOP_PHRASES.includes(normalized)) {
        exitTestMode();
      }
      return;
    }

    if (TRIGGER_PHRASES.includes(normalized)) {
      enterTestMode(rawUtterance);
      return;
    }

    if (isLikelyNoise(normalized)) {
      addLog('from-gpt', { event: 'ignored-utterance', text, normalized });
      return;
    }

    respondNormally(text);
  };

  const handleRealtimeEvent = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const record = payload as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';

    if (type === 'error') {
      const error = record.error as Record<string, unknown> | undefined;
      const param = typeof error?.param === 'string' ? error.param : '';
      if (param.startsWith('session.turn_detection')) {
        turnDetectionDisabledRef.current = false;
      }
      return;
    }

    if (type === 'session.created') {
      disableAutoResponses();
      return;
    }

    if (type === 'response.created') {
      const response = record.response as Record<string, unknown> | undefined;
      const responseId = typeof response?.id === 'string' ? response.id : null;
      if (responseId) {
        currentResponseIdRef.current = responseId;
      }

      if (allowNextResponseRef.current) {
        allowNextResponseRef.current = false;
      }
      return;
    }

    if (type === 'response.done') {
      const response = record.response as Record<string, unknown> | undefined;
      const responseId = typeof response?.id === 'string' ? response.id : null;
      if (responseId && currentResponseIdRef.current === responseId) {
        currentResponseIdRef.current = null;
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof record.transcript === 'string' ? record.transcript : '';
      if (transcript) {
        handleRecognizedText(transcript);
      } else {
        const item = record.item as Record<string, unknown> | undefined;
        const segments = extractTextValues(item);
        segments.forEach(handleRecognizedText);
      }
      return;
    }

    if (type === 'response.delta') {
      const delta = record.delta as Record<string, unknown> | undefined;
      const deltaRole = typeof delta?.role === 'string' ? delta.role : '';
      const deltaType = typeof delta?.type === 'string' ? delta.type : '';
      if (deltaRole === 'user' || deltaType.startsWith('input_text')) {
        const segments = extractTextValues(delta);
        segments.forEach(handleRecognizedText);
      }
      return;
    }
  };

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

      const dataChannel = pc.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;

      const flushPendingSessionUpdates = () => {
        const dc = dataChannelRef.current;
        while (pendingSessionUpdatesRef.current.length && dc && dc.readyState === 'open') {
          const payload = pendingSessionUpdatesRef.current.shift();
          if (!payload) {
            continue;
          }
          dc.send(JSON.stringify(payload));
          addLog('to-gpt', { event: 'session-update', payload });
        }
      };

      dataChannel.onopen = () => {
        addLog('to-gpt', { event: 'data-channel-open' });
        flushPendingSessionUpdates();
        disableAutoResponses();
        sendRealtimeInstruction('Hello!', { exact: true });
      };

      dataChannel.onmessage = (event) => {
        let parsed: unknown = event.data;
        if (typeof event.data === 'string') {
          try {
            parsed = JSON.parse(event.data);
          } catch (err) {
            parsed = event.data;
          }
        }
        addLog('from-gpt', { event: 'data-message', payload: parsed });
        handleRealtimeEvent(parsed);
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

      const activeModel = model.trim() || config.realtimeModel;
      const response = await fetch(
        `https://api.openai.com/v1/realtime?model=${activeModel}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/sdp',
            'OpenAI-Beta': 'realtime=v1',
          },
          body: offer.sdp ?? '',
        },
      );

      const answerSdp = await response.text();
      addLog('from-gpt', {
        event: 'webrtc-answer',
        status: response.status,
        body: answerSdp.slice(0, 2000),
      });

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

    const activeModel = model.trim() || config.realtimeModel;
    const token = resolveToken(session);
    if (!token) {
      setError('Enable the session first to mint a realtime token.');
      return;
    }

    addLog('to-gpt', { event: 'selected-model', model: activeModel });
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

      <section className="controls model">
        <label htmlFor="model-input">
          Realtime model
          <input
            id="model-input"
            type="text"
            placeholder={defaultRealtimeModel}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <small>
            Override the backend model (current default: <code>{defaultRealtimeModel}</code>). The value
            is stored locally for convenience.
          </small>
        </label>
      </section>

      <section className="controls transcription">
        <label className="toggle">
          <input
            type="checkbox"
            checked={enableTranscription}
            onChange={(event) => setEnableTranscription(event.target.checked)}
          />
          Enable text transcription capture
        </label>
        <label
          htmlFor="transcription-model-input"
          style={{ opacity: enableTranscription ? 1 : 0.5 }}
        >
          Transcription model
          <input
            id="transcription-model-input"
            type="text"
            placeholder={DEFAULT_TRANSCRIPTION_MODEL}
            value={transcriptionModel}
            onChange={(event) => setTranscriptionModel(event.target.value)}
            disabled={!enableTranscription}
          />
          <small>
            Used to request JSON transcripts from OpenAI when the workflow runs.
          </small>
        </label>
      </section>

      {sessionPreview}

      <DebugPanel
        logs={logs}
        open={panelOpen}
        onToggle={() => setPanelOpen((prev) => !prev)}
        onClear={() => setLogs([])}
        onDownload={handleDownloadLogs}
        canClear={logs.length > 0}
        canDownload={logs.length > 0}
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
