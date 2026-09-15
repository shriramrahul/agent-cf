import type { Env } from '../types/client';
import type { ChatMessage } from '../session/session-manager';
import type { ToolDef } from '../tools';
import type { LlmProvider, LlmTurn } from './types';

const MODEL = 'gemma-4-26b-a4b-it';

type NativePart = Record<string, unknown>;
type NativeContent = { role: 'user' | 'model'; parts: NativePart[] };

/** Stored history -> native contents. Thought parts are dropped. */
function toContents(history: ChatMessage[]): NativeContent[] {
  const out: NativeContent[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content ?? '' }] });
    } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      out.push({
        role: 'model',
        parts: (m.tool_calls as { id?: string; name: string; args: Record<string, unknown> }[]).map((c) => ({
          functionCall: { name: c.name, args: c.args ?? {}, ...(c.id ? { id: c.id } : {}) },
        })),
      });
    } else if (m.role === 'assistant') {
      out.push({ role: 'model', parts: [{ text: m.content ?? '' }] });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'result',
              response: { result: tryParse(m.content) },
              ...(m.tool_call_id ? { id: m.tool_call_id } : {}),
            },
          },
        ],
      });
    }
  }
  return out;
}

function tryParse(content: string | null): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

export class GeminiProvider implements LlmProvider {
  name = 'gemini';

  async generate(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<LlmTurn> {
    const key = (this.env.GEMINI_API_KEY ?? '') as string;
    if (!key) throw new Error('LLM binding missing: GEMINI_API_KEY');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: toContents(messages),
        ...(tools.length > 0
          ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
    const data = (await res.json()) as { candidates: { content: { parts: NativePart[] } }[] };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text as string)
      .join('')
      .trim();
    const calls = parts
      .filter((p) => p.functionCall)
      .map((p) => {
        const fc = p.functionCall as { id?: string; name: string; args: Record<string, unknown> };
        return { id: fc.id, name: fc.name, args: fc.args ?? {} };
      });
    return { text, calls };
  }

  constructor(private env: Env) {}
}
