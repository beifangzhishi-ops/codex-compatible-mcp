// The CPA Responses transport and tool-result loop. No server-side response
// persistence dependency: call_id-bearing assistant messages are replayed.
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 16;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;

function errorStatus(response, data) {
  const description = data?.error?.message || data?.message || response.statusText;
  const error = new Error('CPA Responses HTTP ' + response.status + ': ' +
    String(description || 'unknown error').slice(0, 360));
  error.httpStatus = response.status;
  return error;
}

function messageText(output) {
  return output.filter((item) => item?.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text || '')
    .join('\n').trim();
}

function toolErrorResult(error) {
  // Ordinary tool errors are results for the reviewer to consider or repair,
  // not an excuse to bypass the actual tool or invoke a parallel executor.
  return JSON.stringify({
    isError: true,
    message: String(error?.message || error || 'Tool failed').slice(0, 900),
  });
}

function abortableToolResult(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Guardian review cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Guardian review cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(
      (result) => { signal.removeEventListener('abort', abort); resolve(result); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export class CpaReviewClient {
  constructor({
    apiKey, model = 'codex-auto-review',
    baseUrl = 'http://127.0.0.1:8317/v1',
    fetchImpl = fetch, maxTurns = DEFAULT_MAX_TURNS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS, maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.maxTurns = maxTurns;
    this.maxToolCalls = maxToolCalls;
    this.maxInputBytes = maxInputBytes;
  }

  async complete({ instructions, prompt, schema = null, tools, invokeTool, signal }) {
    if (!this.apiKey) throw new Error('CPA reviewer API key is not configured');
    const requestTools = tools || [];
    const validTools = new Set(requestTools.map((tool) => tool.name));
    const seenCalls = new Set();
    const unresolvedToolErrors = new Set();
    const history = [{ role: 'developer', content: instructions }, { role: 'user', content: prompt }];
    let toolCalls = 0;
    for (let round = 0; round < this.maxTurns; round++) {
      if (signal?.aborted) throw signal.reason || new Error('Guardian review cancelled');
      const input = JSON.stringify(history);
      if (Buffer.byteLength(input, 'utf8') > this.maxInputBytes) {
        throw new Error('Guardian reviewer input budget exceeded');
      }
      const response = await this.fetchImpl(this.baseUrl + '/responses', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json',
        },
        signal,
        body: JSON.stringify({
          model: this.model,
          store: true,
          parallel_tool_calls: false,
          tools: requestTools,
          input: history,
          tool_choice: 'auto',
          ...(schema ? {
            text: {
              format: {
                type: 'json_schema',
                name: 'guardian_assessment',
                strict: false,
                schema,
              },
            },
          } : {}),
        }),
      });
      let data;
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok) throw errorStatus(response, data);
      if (!Array.isArray(data.output)) throw new Error('CPA reviewer response lacks output');
      history.push(...data.output);
      const calls = data.output.filter((item) => item?.type === 'function_call');
      if (calls.length === 0) {
        if (unresolvedToolErrors.size) {
          throw new Error('Guardian review ended with unresolved tool failures');
        }
        const result = messageText(data.output);
        if (!result) throw new Error('CPA reviewer returned no final message');
        return { text: result, rounds: round + 1, toolCalls };
      }
      for (const call of calls) {
        if (++toolCalls > this.maxToolCalls) throw new Error('Guardian tool-call budget exceeded');
        if (!call.call_id || seenCalls.has(call.call_id) || !validTools.has(call.name)) {
          throw new Error('CPA reviewer returned unknown or duplicate tool call');
        }
        seenCalls.add(call.call_id);
        let args;
        let toolResult;
        try {
          args = JSON.parse(call.arguments || '{}');
          if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            throw new Error('Tool arguments must be a JSON object');
          }
        } catch {
          toolResult = toolErrorResult(new Error('Tool arguments must be valid JSON object'));
        }
        if (toolResult === undefined) {
          try {
            toolResult = await abortableToolResult(
              invokeTool(call.name, args, { signal }), signal,
            );
          } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
            toolResult = toolErrorResult(error);
          }
        }
        const resultPayload = Array.isArray(toolResult)
          ? toolResult : String(toolResult);
        let toolOutcome;
        try {
          const reported = Array.isArray(resultPayload)
            ? resultPayload.find((item) => item.type === 'input_text')?.text
            : resultPayload;
          toolOutcome = JSON.parse(reported);
        } catch {}
        if (toolOutcome?.isError) unresolvedToolErrors.add(call.name);
        else unresolvedToolErrors.delete(call.name);
        history.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: Array.isArray(resultPayload)
            ? resultPayload : resultPayload.slice(0, 20_000),
        });
      }
    }
    throw new Error('Guardian turn limit exceeded');
  }
}
