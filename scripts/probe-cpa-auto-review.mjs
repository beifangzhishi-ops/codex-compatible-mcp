// Opt-in live probe for CPA's codex-auto-review Responses tool-call protocol.
// This uses two fake data-returning tools; it never dispatches CCM commands.
// API credentials are read in process and are never printed or written out.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = process.env.CPA_CONFIG || path.resolve(repo, '..', 'CPA', 'config.yaml');
const text = await readFile(configFile, 'utf8');
const lines = text.split(/\r?\n/);
const index = lines.findIndex((line) => /^\s*api-keys:\s*$/.test(line));
if (index < 0) throw new Error('CPA local api-keys list not found');
const first = lines.slice(index + 1).find((line) => /^\s*-\s*\S+/.test(line));
if (!first) throw new Error('CPA local client key not found');
const token = first.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '');
const baseURL = process.env.CPA_BASE_URL || 'http://127.0.0.1:8317/v1';
const model = 'codex-auto-review';
const tools = [
  {
    type: 'function', name: 'inspect_example_action',
    description: 'Retrieve simulated action metadata. This tool reads a fixed in-memory fixture only.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: 'function', name: 'inspect_example_authorization',
    description: 'Retrieve simulated user permission metadata. This tool reads a fixed in-memory fixture only.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];
const responses = [];
const fakeResults = {
  inspect_example_action: JSON.stringify({ command: 'git status --short', scope: 'mock workspace', writes: false }),
  inspect_example_authorization: JSON.stringify({ requested_by_user: true, scope: 'mock workspace', approved: true }),
};
const prompt = 'You are testing a Guardian reviewer tool API, not executing a command. First call inspect_example_action, and after the tool responds call inspect_example_authorization. After both responses return only a JSON review decision with fields outcome, risk_level, user_authorization, rationale. No real actions are allowed.';

function outputSummary(response) {
  return (response.output || []).map((item) => item.type === 'function_call'
    ? { type: item.type, name: item.name, call_id_present: Boolean(item.call_id) }
    : { type: item.type });
}

function extractDecision(response) {
  const content = (response.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
  try {
    const parsed = JSON.parse(content);
    return ['allow', 'deny'].includes(parsed?.outcome)
      ? { valid: true, outcome: parsed.outcome }
      : { valid: false };
  } catch {
    return { valid: false };
  }
}

async function request(body) {
  const result = await fetch(`${baseURL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, store: true, parallel_tool_calls: false, tools, ...body }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    const detail = data.error?.message || data.message || 'unspecified API error';
    const error = new Error(String(detail).slice(0, 300));
    error.status = result.status;
    throw error;
  }
  return data;
}

function collectCalls(response) {
  return (response.output || []).filter((item) => item.type === 'function_call');
}

function answerFor(call) {
  if (!Object.hasOwn(fakeResults, call.name)) throw new Error(`Unexpected tool: ${call.name}`);
  return { type: 'function_call_output', call_id: call.call_id, output: fakeResults[call.name] };
}

function record(stage, result) {
  responses.push({ stage, ...result });
  console.log(JSON.stringify(responses.at(-1)));
}

let firstResponse;
try {
  firstResponse = await request({ input: prompt, tool_choice: 'auto' });
  record('initial', { status: 'ok', items: outputSummary(firstResponse) });
} catch (error) {
  record('initial', { status: 'failed', http_status: error.status ?? null, reason: error.message });
  process.exitCode = 1;
}

if (firstResponse) {
  const firstCall = collectCalls(firstResponse)[0];
  if (!firstCall) {
    record('first_call', { status: 'failed', reason: 'No function_call from the reviewer' });
    process.exitCode = 1;
  } else {
    const firstOutput = answerFor(firstCall);
    // Test the OpenAI-compatible server-state continuation path.
    try {
      const continued = await request({ previous_response_id: firstResponse.id, input: [firstOutput], tool_choice: 'auto' });
      record('previous_response_id', { status: 'ok', items: outputSummary(continued) });
    } catch (error) {
      record('previous_response_id', { status: 'failed', http_status: error.status ?? null, reason: error.message });
    }

    // Test stateless input replay; include the assistant function_call that owns the call_id.
    let history = [{ role: 'user', content: prompt }, ...firstResponse.output, firstOutput];
    let callNames = [firstCall.name];
    let allToolsCompleted = false;
    for (let round = 2; round <= 4; round++) {
      let continued;
      try {
        continued = await request({ input: history, tool_choice: 'auto' });
        record(`replay_round_${round}`, { status: 'ok', items: outputSummary(continued) });
      } catch (error) {
        record(`replay_round_${round}`, { status: 'failed', http_status: error.status ?? null, reason: error.message });
        process.exitCode = 1;
        break;
      }
      history.push(...continued.output);
      const calls = collectCalls(continued);
      for (const call of calls) {
        callNames.push(call.name);
        history.push(answerFor(call));
      }
      if (!calls.length) {
        allToolsCompleted = true;
        const decision = extractDecision(continued);
        const complete = callNames.includes('inspect_example_action')
          && callNames.includes('inspect_example_authorization')
          && decision.valid;
        record('final', {
          status: complete ? 'complete' : 'incomplete',
          called_tools: callNames,
          final_message: (continued.output || []).some((item) => item.type === 'message'),
          valid_decision_json: decision.valid,
          outcome: decision.outcome ?? null,
        });
        if (!complete) process.exitCode = 1;
        break;
      }
    }
    if (!allToolsCompleted) {
      record('final', { status: 'incomplete', called_tools: callNames });
      process.exitCode = 1;
    }
  }
}
