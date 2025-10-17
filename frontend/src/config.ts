import runtime from '../config/runtime.json';

type FlatConfig = {
  apiBaseUrl?: string;
  realtimeModel?: string;
};

type CdkOutputs = Record<
  string,
  {
    ApiBaseUrl?: string;
    RealtimeModelName?: string;
  }
>;

const deriveConfig = (): FlatConfig => {
  if ('apiBaseUrl' in runtime || 'realtimeModel' in runtime) {
    return runtime as FlatConfig;
  }

  const outputs = runtime as CdkOutputs;
  const firstKey = Object.keys(outputs)[0];
  if (!firstKey) {
    return {};
  }

  const entry = outputs[firstKey];
  return {
    apiBaseUrl: entry?.ApiBaseUrl,
    realtimeModel: entry?.RealtimeModelName,
  };
};

const derived = deriveConfig();

export const config = {
  apiBaseUrl: derived.apiBaseUrl ?? '',
  realtimeModel: derived.realtimeModel ?? 'gpt-4o-mini-realtime-preview',
};

export const defaultRealtimeModel = config.realtimeModel;

if (!config.apiBaseUrl) {
  console.warn(
    'Opssage frontend: config.apiBaseUrl is empty. Update frontend/config/runtime.json with ApiBaseUrl.',
  );
}
