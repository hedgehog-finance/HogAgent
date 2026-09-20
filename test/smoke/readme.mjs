/** Exercise the documented entry points with isolated settings and a local model fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = mkdtempSync(join(tmpdir(), 'hogagent-readme-'));
const system = join(runtime, 'settings');
const workspace = join(runtime, 'workspace with spaces');
const children = [];
const marker = 'HOGAGENT_SMOKE_OK';
const prompt = `Reply with exactly ${marker}. Do not use tools.`;
let socket;
let requests = 0;
let toolCalls = 0;
const model = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'readme-smoke' }] }));
  }
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer readme-test-key');
  const request = JSON.parse(body);
  assert.ok(request.messages.length > 0);
  requests++;
  // Allow the queueing examples to send steer/follow_up during the active turn.
  await delay(100);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const useTool = request.tools?.some(tool => tool.function?.name === 'math_calc') && request.messages.at(-1).role === 'user';
  if (useTool) toolCalls++;
  const deltas = useTool
    ? [[{ role: 'assistant', tool_calls: [{ index: 0, id: `calc-${requests}`, type: 'function', function: { name: 'math_calc', arguments: '{"expression":"1+1"}' } }] }, null], [{}, 'tool_calls']]
    : [[{ role: 'assistant', content: marker }, null], [{}, 'stop']];
  for (const [delta, finishReason] of deltas) {
    res.write(`data: ${JSON.stringify({ id: 'readme-smoke', object: 'chat.completion.chunk', created: 1, model: 'readme-smoke', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function until(predicate, label, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = predicate();
    if (value) return value;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
function launch(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, HOGAGENT_USER_DIR: system, HOGAGENT_PROJECT_ROOT: root, HOGAGENT_GATEWAY_MANAGED: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { child, stdout: '', stderr: '', events: [], error: null };
  children.push(child);
  let pending = '';
  child.on('error', error => { state.error = error; });
  child.stdout.on('data', chunk => {
    state.stdout += chunk;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) { try { state.events.push(JSON.parse(line)); } catch { /* Interactive text. */ } }
  });
  child.stderr.on('data', chunk => { state.stderr += chunk; });
  return state;
}
async function exited(state, expectedSignal) {
  await until(() => state.error || state.child.exitCode !== null || state.child.signalCode !== null, 'process exit');
  if (state.error) throw state.error;
  if (expectedSignal && state.child.signalCode === expectedSignal) return;
  assert.equal(state.child.exitCode, 0, state.stderr);
}
function send(state, command) { state.child.stdin.write(JSON.stringify(command) + '\n'); }

try {
  mkdirSync(system);
  mkdirSync(workspace);
  const port = await listen(model);
  const liveIndex = process.argv.indexOf('--live-config');
  const settings = liveIndex < 0
    ? { provider: 'hedgehog', apiKey: 'readme-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'readme-smoke' }
    : JSON.parse(readFileSync(process.argv[liveIndex + 1], 'utf8'));
  writeFileSync(join(system, 'llm-settings.json'), JSON.stringify(settings), { mode: 0o600 });
  writeFileSync(join(system, 'hogagent.json'), JSON.stringify({ sandboxMode: 'disabled', memory: { enabled: false } }));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal((await import(new URL('../../dist/src/version.js', import.meta.url))).getVersion(), manifest.version);
  for (const args of [['dist/bin/hogagent.js', '--version'], ['dist/bin/hogagent.js', '--help'], ['dist/bin/hogagent-web.js', '--help']]) await exited(launch(args));
  console.log('PASS CLI help/version');

  const rpc = launch(['dist/bin/hogagent.js', '--mode', 'rpc', '--user', 'default', '--session', 'readme-rpc', '--workspace', workspace]);
  await until(() => rpc.events.find(event => event.type === 'ready'), 'RPC ready');
  send(rpc, { type: 'get_state' });
  await until(() => rpc.events.find(event => event.type === 'state'), 'RPC state');
  send(rpc, { type: 'prompt', text: prompt, mode: 'quick' });
  await until(() => rpc.events.find(event => event.type === 'agent_end'), 'RPC completion');
  assert.ok(rpc.events.filter(event => event.type === 'message_update').map(event => event.delta ?? '').join('').includes(marker), JSON.stringify(rpc.events.slice(-8)));
  send(rpc, { type: 'shutdown' });
  await exited(rpc);
  console.log('PASS RPC ready/state/prompt/shutdown');

  const interactive = launch(['dist/bin/hogagent.js', '--mode', 'interactive', '--user', 'default', '--workspace', workspace]);
  await until(() => interactive.stderr.includes('hogagent> '), 'interactive ready');
  interactive.child.stdin.write(prompt + '\n');
  await until(() => interactive.stderr.includes(marker), 'interactive response');
  interactive.child.stdin.write('/exit\n');
  await exited(interactive);
  console.log('PASS interactive prompt/exit');

  const reservation = createServer();
  const webPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const web = launch(['dist/bin/hogagent-web.js', '--port', String(webPort), '--workspace', workspace]);
  await until(() => web.stdout.includes('is running at'), 'Web UI ready');
  const origin = `http://127.0.0.1:${webPort}`;
  const page = await (await fetch(origin)).text();
  assert.ok(page.includes(`v${manifest.version}`));
  const token = /name="hogagent-web-token" content="([^"]+)"/.exec(page)?.[1];
  assert.ok(token);
  for (const path of ['/app.js', '/preview-vendor/chart-data.js', '/preview-vendor/markdown-document.js', '/preview-vendor/marked.js', '/preview-vendor/purify.js', '/preview-vendor/echarts.js', '/preview-vendor/katex/katex.min.js']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    await response.arrayBuffer();
  }
  const events = [];
  socket = new WebSocket(`ws://127.0.0.1:${webPort}/?user=default&token=${encodeURIComponent(token)}`, { origin });
  socket.on('message', data => { const message = JSON.parse(data); events.push(message.event ?? message); });
  await until(() => events.find(event => event.type === 'ready' && !event._serverInit), 'WebSocket child ready');
  socket.send(JSON.stringify({ type: 'rpc_command', command: { type: 'prompt', text: prompt, mode: 'quick' } }));
  await until(() => events.find(event => event.type === 'agent_end'), 'WebSocket completion');
  assert.ok(events.filter(event => event.type === 'message_update').map(event => event.delta ?? '').join('').includes(marker));
  if (process.platform === 'win32') {
    // Windows terminates the Web server on SIGTERM; first stop its RPC child.
    socket.send(JSON.stringify({ type: 'rpc_command', command: { type: 'shutdown' } }));
    await until(() => events.find(event => event.type === 'connection_status' && event.status === 'disconnected'), 'WebSocket child shutdown');
  }
  socket.close();
  web.child.kill('SIGTERM');
  await exited(web, process.platform === 'win32' ? 'SIGTERM' : undefined);
  console.log('PASS Web UI assets/authenticated WebSocket/prompt');

  for (const debug of [false, true]) {
    const example = launch(['examples/basic-chat.ts', '--message', prompt, '--session', `readme-example-${debug}`, ...(debug ? ['--debug'] : [])]);
    await exited(example);
    const output = example.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(output, /HogAgent ready/);
    assert.match(output, new RegExp(`Assistant:[\\s\\S]*${marker}`));
    assert.doesNotMatch(output, /Response timeout|Startup failed|\[Error\]/);
    console.log(`PASS documented basic-chat example (debug=${debug})`);
  }
  if (liveIndex < 0) {
    assert.ok(requests >= 5);
    assert.ok(toolCalls >= 2, 'Examples must finish the tool loop before exiting');
    for (const file of ['mode-switching', 'tool-usage', 'delivery-example', 'workflow-example', 'full-session']) {
      const example = launch([`examples/${file}.ts`]);
      await exited(example);
      const output = example.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      assert.ok(output.includes(marker), file);
      assert.doesNotMatch(output, /Response timeout|\[Timeout|Startup failed|\[Error\]/, file);
      console.log(`PASS ${file} lifecycle with local model/tool fixtures`);
    }
  }
  console.log(liveIndex < 0 ? 'README smoke passed with a local model fixture; no provider credentials used.' : 'README smoke passed with the configured live provider through HogAgent.');
} finally {
  socket?.terminate();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(resolve => model.close(resolve));
  model.closeAllConnections();
  // Wait for normal shutdown before removing child process settings.
  await delay(500);
  rmSync(runtime, { recursive: true, force: true });
}
