import type { Env } from '../types/client';
import type { ChatMessage } from '../session/session-manager';
import type { ToolDef } from '../tools';
import type { LlmProvider, LlmTurn } from './types';

const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

type OpenAiMessage = Record<string, unknown>;

/** Stored history -> OpenAI messages. */
function toMessages(history: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const m of history) {
    if (m.role === 'user' || m.role === 'system') {
      out.push({ role: m.role, content: m.content ?? '' });
    } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      out.push({
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: (m.tool_calls as { id?: string; name: string; args: Record<string, unknown> }[]).map((c, i) => ({
          id: c.id ?? `call_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content ?? '' });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' });
    }
  }
  return out;
}

export class GroqProvider implements LlmProvider {
  name = 'groq';

  async generate(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<LlmTurn> {
    const key = (this.env.GROQ_API_KEY ?? '') as string;
    if (!key) throw new Error('LLM binding missing: GROQ_API_KEY');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: (this.env.GROQ_MODEL as string | undefined) ?? DEFAULT_MODEL,
        messages: [{ role: 'system', content: system }, ...toMessages(messages)],
        temperature: 0.6,
        max_completion_tokens: 4096,
        top_p: 0.95,
        stream: false,
        ...(tools.length > 0
          ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('LLM returned no choices');
    const calls = (msg.tool_calls ?? []).map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      return { id: c.id, name: c.function.name, args };
    });
    return { text: (msg.content ?? '').trim(), calls };
  }

  constructor(private env: Env) {}
}
