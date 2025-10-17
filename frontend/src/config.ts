import runtime from '../config/runtime.json';

interface RuntimeConfig {
  apiBaseUrl?: string;
  realtimeModel?: string;
}

const runtimeConfig = runtime as RuntimeConfig;

export const config = {
  apiBaseUrl: runtimeConfig.apiBaseUrl ?? '',
  realtimeModel: runtimeConfig.realtimeModel ?? 'gpt-4o-realtime-preview',
};

if (!config.apiBaseUrl) {
  console.warn(
    'Opssage frontend: config.apiBaseUrl is empty. Provide a value in frontend/config/runtime.json.',
  );
}
