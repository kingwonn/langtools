// LLM 调用抽象：优先 Anthropic 原生 API（结构化输出最可靠），
// 其次 OpenRouter 兼容接口（OPENROUTER_API_KEY + ANALYZE_MODEL 指定模型）。
import Anthropic from '@anthropic-ai/sdk';

const PROVIDER = process.env.ANTHROPIC_API_KEY
  ? 'anthropic'
  : process.env.OPENROUTER_API_KEY
    ? 'openrouter'
    : null;

export function llmProvider() {
  return PROVIDER;
}

let anthropicClient = null;

function stripFences(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

/**
 * 调用 LLM 并返回符合 schema 的 JSON 对象。
 * @param {object} opts {system, user, schema, effort, maxTokens}
 */
export async function llmJSON({ system, user, schema, effort = 'medium', maxTokens = 16000 }) {
  if (PROVIDER === 'anthropic') {
    anthropicClient ||= new Anthropic();
    const model = process.env.ANALYZE_MODEL || 'claude-opus-4-8';
    const response = await anthropicClient.messages.create({
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') throw new Error('model refused');
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('empty response');
    return JSON.parse(text);
  }

  if (PROVIDER === 'openrouter') {
    // OpenRouter 走 OpenAI 兼容接口；模型需用 OpenRouter 的 slug，
    // 如 anthropic/claude-sonnet-4.5、deepseek/deepseek-chat 等
    const model = process.env.ANALYZE_MODEL || 'anthropic/claude-sonnet-4.5';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/kingwonn/langtools',
        'X-Title': 'ReadSphere',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `${user}\n\n只输出一个符合以下 JSON Schema 的 JSON 对象，不要输出其他任何内容：\n${JSON.stringify(schema)}`,
          },
        ],
        // 支持 structured outputs 的模型会强制约束；不支持的模型靠上面的提示词兜底
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', strict: true, schema },
        },
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error(`empty response: ${JSON.stringify(data).slice(0, 200)}`);
    return JSON.parse(stripFences(text));
  }

  throw new Error('未配置 LLM：请设置 ANTHROPIC_API_KEY 或 OPENROUTER_API_KEY');
}
