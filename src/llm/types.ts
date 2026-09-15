import type { ChatMessage } from '../session/session-manager';
import type { ToolDef } from '../tools';

export type LlmToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

export type LlmTurn = {
  text: string;
  calls: LlmToolCall[];
};

/** One neutral shape in, one neutral shape out — providers differ only inside. */
export interface LlmProvider {
  name: string;
  generate(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<LlmTurn>;
}
