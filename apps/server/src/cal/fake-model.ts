import type Anthropic from '@anthropic-ai/sdk';
import { type ChatModel } from './anthropic';

/**
 * A deterministic stand-in for Claude (D160's "E2E: ask Cal a question... with a fake LLM
 * provider, deterministic"): real turn 1 always calls `search_library` with the user's whole
 * message as the query; turn 2 reads the real tool result (produced by the real, gated
 * hybridSearch — only the model's own reasoning is faked, not the search or the spoiler gate) and
 * answers with the first chunk it was handed, cited. Used only when `CAL_TEST_FAKE_MODEL=true`
 * (config.ts; never set in production) — e2e/cal-chat.spec.ts and the spoiler-safety E2E test
 * exercise the real route, real gating and real citation-building this way, with no Anthropic key.
 */
export class DeterministicFakeChatModel implements ChatModel {
  private turn = 0;

  stream(params: { messages: Anthropic.MessageParam[] }): {
    on(event: 'text', listener: (delta: string) => void): void;
    finalMessage(): Promise<Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>>;
  } {
    const listeners: ((delta: string) => void)[] = [];
    const final = this.respond(params.messages, (text) => listeners.forEach((l) => l(text)));
    return {
      on: (_event, listener) => listeners.push(listener),
      finalMessage: () => final,
    };
  }

  private async respond(messages: Anthropic.MessageParam[], emit: (text: string) => void): Promise<Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>> {
    this.turn++;
    const usage = { input_tokens: 10, output_tokens: 10 } as Anthropic.Usage;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastToolResult = findToolResultText(messages);

    if (!lastToolResult) {
      // Turn 1: ask to search for whatever the user said.
      const query = (lastUser ? extractText(lastUser.content) : '') || 'the book';
      const preamble = 'Let me check the shelf.';
      emit(preamble);
      return {
        content: [
          { type: 'text', text: preamble, citations: null },
          { type: 'tool_use', id: 'fake-tool-1', name: 'search_library', input: { query } },
        ] as unknown as Anthropic.ContentBlock[],
        stop_reason: 'tool_use',
        usage,
      };
    }

    const chunkMatch = /chunk ([A-Za-z0-9_-]+)/.exec(lastToolResult);
    const text = chunkMatch ? `Here is what the shelf says. [[cite:${chunkMatch[1]}]]` : "I couldn't find anything about that in what you've read so far.";
    emit(text);
    return { content: [{ type: 'text', text, citations: null }] as unknown as Anthropic.ContentBlock[], stop_reason: 'end_turn', usage };
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ');
}

function findToolResultText(messages: readonly Anthropic.MessageParam[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const result = (m.content as { type?: string; content?: unknown }[]).find((b) => b.type === 'tool_result');
    if (result && typeof result.content === 'string') return result.content;
  }
  return null;
}
