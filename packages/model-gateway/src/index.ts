import type { RuntimeKind } from '@claude-company/contracts';
import { ClaudeAgentSdkProvider, type ClaudeAgentSdkProviderOptions } from './providers/claude-agent-sdk.provider';
import { FakeModelProvider, type FakeModelProviderOptions } from './providers/fake.provider';
import { MessagesApiProvider, type MessagesApiProviderOptions } from './providers/messages-api.provider';
import type { AgentRunEvent, AgentRunIO, AgentRunRequest, ModelGateway } from './types';

export * from './types';
export * from './input-format';
export {
  FakeModelProvider,
  readFakeInput,
  type FakeEmployee,
  type FakeInput,
  type FakeModelProviderOptions,
} from './providers/fake.provider';
export { MessagesApiProvider, type MessagesApiProviderOptions } from './providers/messages-api.provider';
export {
  ClaudeAgentSdkProvider,
  buildSdkEnv,
  cliJsonSchema,
  MCP_SERVER_NAME,
  type ClaudeAgentSdkProviderOptions,
  type QueryFn,
} from './providers/claude-agent-sdk.provider';

export type ModelGatewayConfig =
  | {
      provider: 'fake';
      fake?: FakeModelProviderOptions;
    }
  | {
      /**
       * Chỉ để chạy local bằng đăng nhập subscription của Claude Code CLI (`MODEL_PROVIDER=claude_subscription`): cả hai
       * runtime đi qua Agent SDK, không có API key. Production phải dùng `anthropic`.
       */
      provider: 'claude_subscription';
      agentSdk?: Omit<ClaudeAgentSdkProviderOptions, 'apiKey' | 'subscription'>;
    }
  | {
      provider: 'anthropic';
      apiKey: string;
      messagesApi?: Omit<MessagesApiProviderOptions, 'apiKey'>;
      agentSdk?: Omit<ClaudeAgentSdkProviderOptions, 'apiKey'>;
    };

/** Gateway chọn provider theo `MODEL_PROVIDER` và `runtimeKind` của từng AI Employee (FR-012). */
class RoutingGateway implements ModelGateway {
  constructor(private readonly byRuntime: Record<RuntimeKind, ModelGateway>) {}

  runAgent(req: AgentRunRequest, io: AgentRunIO): AsyncIterable<AgentRunEvent> {
    return this.byRuntime[req.runtimeKind].runAgent(req, io);
  }
}

export function createModelGateway(config: ModelGatewayConfig): ModelGateway {
  if (config.provider === 'fake') {
    const fake = new FakeModelProvider(config.fake);
    return new RoutingGateway({ claude_agent_sdk: fake, messages_api: fake });
  }
  if (config.provider === 'claude_subscription') {
    const sdk = new ClaudeAgentSdkProvider({ ...config.agentSdk, subscription: true });
    return new RoutingGateway({ claude_agent_sdk: sdk, messages_api: sdk });
  }
  return new RoutingGateway({
    claude_agent_sdk: new ClaudeAgentSdkProvider({ ...config.agentSdk, apiKey: config.apiKey }),
    messages_api: new MessagesApiProvider({ ...config.messagesApi, apiKey: config.apiKey }),
  });
}
