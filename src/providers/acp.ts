import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * 从 .env 中读取常见 ACP agent 需要的 API key 并透传给容器。
 * 这些 key 永远不会留在容器镜像里，只在 spawn 时作为环境变量注入。
 */
const ACP_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CODEX_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
];

registerProviderContainerConfig('acp', () => ({
  env: readEnvFile(ACP_ENV_KEYS),
}));
