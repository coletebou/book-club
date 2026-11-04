import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config';
import type { ChatModel } from './anthropic';

type Params = Parameters<ChatModel['stream']>[0];
type Reply = Awaited<ReturnType<ReturnType<ChatModel['stream']>['finalMessage']>>;
interface Item { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }
interface ResponseBody { model?: string; status?: string; output?: Item[]; usage?: { input_tokens: number; output_tokens: number }; incomplete_details?: { reason?: string } }
interface Event { type: string; delta?: string; response?: ResponseBody }

/** Only capacity/connectivity failures qualify; authentication, validation and refusals do not. */
export function transientModelFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError') return true;
  const status = (error as Error & { status?: number }).status;
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function inputFor(messages: Params['messages']): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') { input.push({ role: message.role, content: message.content }); continue; }
    const text: string[] = [];
    const flush = () => { if (text.length) { input.push({ role: message.role, content: text.join('\n') }); text.length = 0; } };
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'tool_use') { flush(); input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) }); }
      else if (block.type === 'tool_result') {
        flush();
        if (typeof block.content !== 'string') throw new Error('Unsupported Sol tool-result content.');
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content });
      } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') throw new Error('Unsupported Sol message content.');
    }
    flush();
  }
  return input;
}

/** Native Responses wire adapter: explicit scoped auth, no SDK/profile/env authority. */
export function solModel(config: Config, fetcher: typeof fetch = fetch): ChatModel {
  return {
    stream(params) {
      let listener: ((text: string) => void) | undefined;
      return {
        on(_event, next) { listener = next; },
        async finalMessage(): Promise<Reply> {
          if (!config.CAL_SOL_BASE_URL || !config.ANTHROPIC_API_KEY || !config.ANTHROPIC_TENANT_ID) throw new Error('Sol fallback is not configured.');
          const tools = params.tools.map((tool) => {
            if ('type' in tool && tool.type && tool.type !== 'custom') throw new Error('Managed tools are unavailable on Sol fallback.');
            if (!('input_schema' in tool)) throw new Error('Unsupported Sol tool schema.');
            return { type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false };
          });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 120_000);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            const response = await fetcher(`${config.CAL_SOL_BASE_URL.replace(/\/$/, '')}/v1/responses`, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { authorization: `Bearer ${config.ANTHROPIC_API_KEY}`, [config.ANTHROPIC_TENANT_HEADER]: config.ANTHROPIC_TENANT_ID, 'content-type': 'application/json' },
              body: JSON.stringify({ model: config.CAL_SOL_MODEL, input: inputFor(params.messages), instructions: params.system.map((block) => block.text).join('\n'), tools, reasoning: { effort: 'low' }, max_output_tokens: params.max_tokens, stream: true, store: false, service_tier: 'default' }),
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw Object.assign(new Error('Sol provider request failed.'), { status: response.status });
            }
            if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid Sol stream.');
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = ''; let bytes = 0; let final: ResponseBody | undefined;
            let streamedText = '';
            const consume = (frame: string) => {
              const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
              if (!data || data === '[DONE]') return;
              const event = JSON.parse(data) as Event;
              if (event.type === 'response.output_text.delta') {
                if (typeof event.delta !== 'string') throw new Error('Invalid Sol text delta.');
                streamedText += event.delta;
                listener?.(event.delta);
              } else if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') throw new Error('Sol declined to answer.');
              else if (event.type === 'error' || event.type === 'response.failed') throw new Error('Sol stream failed.');
              else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
            };
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.length;
              if (bytes > 8 * 1024 * 1024) throw new Error('Sol stream exceeds the response bound.');
              buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
              let split: number;
              while ((split = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, split)); buffer = buffer.slice(split + 2); }
              if (buffer.length > 1024 * 1024) throw new Error('Sol stream frame exceeds the response bound.');
            }
            buffer += decoder.decode();
            if (buffer.trim()) consume(buffer);
            if (final?.model !== config.CAL_SOL_MODEL) throw new Error('Sol response model does not match the configured model.');
            if (!final.output || !final.usage || (final.status !== 'completed' && final.status !== 'incomplete')) throw new Error('Sol stream ended without a complete response.');
            if (![final.usage.input_tokens, final.usage.output_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid Sol usage.');
            if (final.output.length > 64) throw new Error('Sol output item count exceeds the bound.');
            const content: Anthropic.ContentBlock[] = [];
            const callIds = new Set<string>();
            for (const item of final.output) {
              if (item.type === 'message') for (const block of item.content ?? []) {
                if (block.type === 'refusal') throw new Error('Sol declined to answer.');
                if (block.type === 'output_text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text, citations: null });
              }
              else if (item.type === 'function_call') {
                if (!item.call_id || item.call_id.length > 128 || callIds.has(item.call_id) || !item.name || !tools.some((tool) => tool.name === item.name) || typeof item.arguments !== 'string' || item.arguments.length > 64 * 1024 || callIds.size >= 20) throw new Error('Invalid Sol tool call.');
                callIds.add(item.call_id);
                content.push({ type: 'tool_use', caller: { type: 'direct' }, id: item.call_id, name: item.name, input: JSON.parse(item.arguments) as unknown });
              }
            }
            if (!content.length) throw new Error('Sol returned no answer or tool call.');
            if (content.filter((block) => block.type === 'text').map((block) => block.text).join('') !== streamedText) throw new Error('Sol stream text does not match final output.');
            if (final.status === 'incomplete' && final.incomplete_details?.reason !== 'max_output_tokens') throw new Error('Sol response was incomplete.');
            return { content, stop_reason: final.status === 'incomplete' ? 'max_tokens' : content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens } as Anthropic.Usage };
          } finally {
            clearTimeout(timer);
            await reader?.cancel().catch(() => {});
            controller.abort();
          }
        },
      };
    },
  };
}
