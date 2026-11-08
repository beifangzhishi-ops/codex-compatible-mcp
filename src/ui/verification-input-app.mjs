export const VERIFICATION_INPUT_UI_URI = 'ui://ccm/verification-input-v1.html';

// Only App-only tool calls receive the input value. The card never writes it
// to model context, widgetState, or a follow-up chat message.
export const VERIFICATION_INPUT_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2px; font: 13px/1.45 system-ui,sans-serif; }
#card { padding: 14px; border: 1px solid color-mix(in srgb,currentColor 16%,transparent); border-radius: 13px; color: CanvasText; background: color-mix(in srgb,Canvas 95%,currentColor 5%); }
#title { font-weight: 700; font-size: 14px; }
#target { margin: 6px 0 10px; font-size: 12px; opacity: .7; overflow-wrap: anywhere; }
#value { display: block; width: 100%; padding: 10px; border-radius: 8px; border: 1px solid color-mix(in srgb,currentColor 25%,transparent); background: Canvas; color: CanvasText; font: inherit; }
#actions { display: flex; justify-content: flex-end; margin-top: 10px; }
#send { padding: 9px 15px; border: 0; border-radius: 999px; cursor: pointer; color: inherit; background: color-mix(in srgb,currentColor 14%,transparent); font: inherit; font-weight: 600; }
#send:disabled { opacity: .45; cursor: default; }
#status { font-size: 12px; margin-top: 9px; opacity: .75; }
</style>
</head>
<body>
<div id="card" hidden>
  <div id="title">CCM verification input</div><div id="target"></div>
  <form id="form">
    <input id="value" type="password" autocomplete="one-time-code" maxlength="256" placeholder="Enter verification code" aria-label="Verification code">
    <div id="actions"><button id="send" type="submit" disabled>Send to CCM</button></div>
  </form>
  <div id="status" role="status">Enter the code here, not in the chat.</div>
</div>
<script>
(() => {
  const card = document.getElementById('card');
  const title = document.getElementById('title');
  const target = document.getElementById('target');
  const form = document.getElementById('form');
  const input = document.getElementById('value');
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const pending = new Map();
  let nextId = 1;
  let current = null;
  let initialized = false;
  let busy = false;
  let continued = false;
  function post(message) { window.parent.postMessage(message, '*'); }
  function request(method, params, timeout = 30000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id); reject(new Error('CCM request timed out'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      post({ jsonrpc: '2.0', id, method, params });
    });
  }
  function render(value) {
    if (!value?.request_id) return;
    if (current?.request_id !== value.request_id) continued = false;
    current = value;
    card.hidden = false;
    title.textContent = value.label || 'CCM verification input';
    target.textContent = (value.environment_id || 'CCM') + ' / ' +
      (value.workspace_id || '') + ' · session ' + value.session_id;
    form.hidden = value.state !== 'pending';
    input.disabled = busy || value.state !== 'pending';
    send.disabled = busy || !input.value.trim() || value.state !== 'pending';
    status.textContent =
      value.state === 'delivered' ? 'Input delivered to CCM.' :
      value.state === 'unknown' ? 'Delivery unconfirmed; this card cannot resend.' :
      value.state === 'sending' ? 'Submitting to CCM…' :
      value.state === 'unavailable' ? 'CCM session no longer available.' :
      'Enter the code here, not in the chat.';
    try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
  }
  async function refresh() {
    if (!initialized || !current?.request_id) return;
    const id = current.request_id;
    try {
      const reply = await request('tools/call', {
        name: 'get_verification_input_status', arguments: { request_id: id }
      }, 12000);
      if (current?.request_id !== id || current.state === 'delivered' ||
          current.state === 'unknown' || current.state === 'unavailable') return;
      if (reply?.isError || !reply?.structuredContent) throw Error('Unavailable');
      render(reply.structuredContent);
    } catch {
      form.hidden = true;
      status.textContent = 'Card status unavailable. Request a new CCM input card.';
    }
  }
  async function continueModel() {
    if (continued) return;
    continued = true;
    try {
      const processStatus = current?.session_running
        ? 'The process session is still running.'
        : current?.exit_code !== undefined
          ? 'The process exited with code ' + current.exit_code + '.'
          : 'The process session status is not available.';
      await request('ui/update-model-context', {
        content: [{ type: 'text',
          text: 'Verification input was delivered directly to the CCM process session. ' +
            processStatus + ' The input value is not in model context.' }]
      }, 10000);
    } catch {
      status.textContent += ' Send a chat message to continue.';
      return;
    }
    const prompt = 'I submitted the verification input through the CCM card. Treat it as submitted and continue the original task without checking the code or its submission status. If the task later reports that the code is invalid, show another input card instead of reading or requesting the code in chat.';
    try {
      const reply = await request('ui/message', {
        role: 'user', content: [{ type: 'text', text: prompt }]
      }, 10000);
      if (!reply?.isError) return;
    } catch {}
    try {
      if (!window.openai?.sendFollowUpMessage) throw Error('Unsupported');
      await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
    } catch { status.textContent += ' Send a chat message to continue.'; }
  }
  input.addEventListener('input', () => {
    send.disabled = busy || !input.value.trim() || current?.state !== 'pending';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || current?.state !== 'pending') return;
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    busy = true;
    send.disabled = true;
    const id = current.request_id;
    status.textContent = 'Submitting to CCM…';
    try {
      const reply = await request('tools/call', {
        name: 'submit_verification_input',
        arguments: { request_id: id, value }
      }, 120000);
      if (reply?.isError || !reply?.structuredContent) throw Error('Unavailable');
      if (current?.request_id !== id) return;
      render(reply.structuredContent);
      if (reply.structuredContent.state === 'delivered') void continueModel();
    } catch {
      form.hidden = true;
      status.textContent = 'Delivery result unknown. Request a new CCM input card if needed.';
    } finally {
      busy = false;
      send.disabled = true;
    }
  });
  function load(value) {
    const data = value?.structuredContent || window.openai?.toolOutput || value;
    if (!data?.request_id) return;
    if (current?.request_id === data.request_id && current.state !== 'pending') return;
    render(data);
    if (initialized) void refresh();
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (Object.hasOwn(message, 'id')) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error('CCM bridge error'));
      else waiter.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-result') {
      load(message.params);
    }
  });
  window.addEventListener('openai:set_globals', () => load());
  async function initialize() {
    try {
      await request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'ccm-verification-input', version: '1.0.0' },
        appCapabilities: {}
      }, 5000);
      initialized = true;
      post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      load();
      void refresh();
    } catch {
      card.hidden = false;
      form.hidden = true;
      status.textContent = 'Unable to initialize CCM input card.';
    }
  }
  void initialize();
})();
</script>
</body></html>`;
