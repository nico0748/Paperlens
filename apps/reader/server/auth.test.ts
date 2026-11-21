// MCP のトークン認証と、画面の合言葉のテスト。台帳・runtime.json・保存先は一時フォルダに置く。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-auth-"));
process.env.PAPERLENS_DATA = path.join(data, "vault");
process.env.PAPERLENS_CONFIG = path.join(data, "conf", "config.json");

const { startServer } = await import("./app.ts");
const tokens = await import("./tokens.ts");
const { readRuntime, helloProof } = await import("./runtime.ts");
const { scopeOf } = await import("../mcp/scopes.ts");
const { TOOLS, WRITE_TOOLS } = await import("../mcp/tools.ts");
const { resolveToken } = await import("../mcp/token.ts");
const { verifyServer, findServer } = await import("../mcp/proxy.ts");

let s: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  s = await startServer({ port: 0 });
});
after(async () => {
  await s.close();
  fs.rmSync(data, { recursive: true, force: true });
});

const mcp = async (token: string | null, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${s.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const listTools = async (token: string) => ((await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools as { name: string }[]).map((t) => t.name);

// --- 台帳 -----------------------------------------------------------------------

test("書き込みのツールは、どれもスコープの表に載っている（載っていないと、どのトークンにも見せない）", () => {
  for (const t of WRITE_TOOLS) assert.ok(scopeOf(t.name, false), `${t.name} にスコープがありません`);
  for (const t of TOOLS) if (t.config.annotations.readOnlyHint) assert.equal(scopeOf(t.name, true), "read", t.name);
});

test("発行: 平文は一度だけ返り、台帳には SHA-256 だけが 0600 で残る", () => {
  const { token, record } = tokens.issueToken({ name: "テスト", scopes: ["read"] });
  assert.match(token, /^plk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  const file = path.join(data, "conf", "paperlens.tokens.json");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(token.split("_")[2]), "台帳に平文がある");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(record.days, 90);
  assert.equal(tokens.verifyBearer(`Bearer ${token}`).id, record.id);
  tokens.revokeToken(record.id);
});

test("有効期限は 7 / 30 / 90 / 365 日だけ。無期限や半端な日数は断る", () => {
  assert.throws(() => tokens.issueToken({ name: "x", days: 0 }), /有効期限/);
  assert.throws(() => tokens.issueToken({ name: "x", days: 1000 }), /有効期限/);
  assert.throws(() => tokens.issueToken({ name: "x", scopes: [] }), /スコープ/);
  assert.throws(() => tokens.issueToken({ name: "x", scopes: ["admin"] }), /知らないスコープ/);
  assert.throws(() => tokens.issueToken({ name: "" }), /名前/);
});

test("期限切れ・取り消し・形の違い・知らない識別子は通さない", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const { token, record } = tokens.issueToken({ name: "期限", days: 7 }, t0);
  assert.equal(tokens.verifyBearer(`Bearer ${token}`, undefined, t0 + 1000).id, record.id);
  assert.throws(() => tokens.verifyBearer(`Bearer ${token}`, undefined, t0 + 8 * 86400_000), /有効期限が切れています/);
  tokens.revokeToken(record.id);
  assert.throws(() => tokens.verifyBearer(`Bearer ${token}`), /違うか、取り消されています/);
  assert.throws(() => tokens.verifyBearer("Bearer abc"), /形が正しくありません/);
  assert.throws(() => tokens.verifyBearer(undefined), /ありません/);
});

test("再発行すると古いトークンはその場で使えなくなる。スコープは狭められるが、広げられない", () => {
  const a = tokens.issueToken({ name: "回す", scopes: ["read", "notes:write"], days: 30 });
  const b = tokens.rotateToken(a.record.id);
  assert.throws(() => tokens.verifyBearer(`Bearer ${a.token}`), /取り消されています/);
  assert.equal(tokens.verifyBearer(`Bearer ${b.token}`).name, "回す");
  assert.equal(b.record.days, 30);
  assert.deepEqual(tokens.narrowToken(b.record.id, ["read"]).scopes, ["read"]);
  assert.throws(() => tokens.narrowToken(b.record.id, ["read", "delete"]), /広げる/);
  tokens.revokeToken(b.record.id);
});

test("同じ識別子で 10 回を超えて間違えると、しばらく締め出す", () => {
  const { token, record } = tokens.issueToken({ name: "総当たり" });
  const wrong = `${token.slice(0, 13)}${"A".repeat(43)}`;
  for (let i = 0; i < 11; i++) assert.throws(() => tokens.verifyBearer(`Bearer ${wrong}`));
  assert.throws(() => tokens.verifyBearer(`Bearer ${token}`), (e: Error & { status?: number }) => e.status === 429);
  tokens.revokeToken(record.id);
  tokens._resetTokenCache();
});

test("記録には、トークン文字列を出さない", () => {
  tokens.audit({ event: "auth", ok: false, detail: "plk_0123abcd_SECRETSECRETSECRETSECRETSECRETSECRETSECRETS" });
  const raw = fs.readFileSync(path.join(data, "conf", "paperlens.audit.log"), "utf8");
  assert.ok(!raw.includes("SECRETSECRET"));
});

// --- 画面の合言葉 ---------------------------------------------------------------

test("合言葉の無い /api は、Origin が無くても断る。合言葉か Cookie があれば通す", async () => {
  assert.equal((await fetch(`${s.url}/api/papers`)).status, 401);
  assert.equal((await fetch(`${s.url}/api/tokens`)).status, 401);
  assert.equal((await fetch(`${s.url}/api/papers`, { headers: { "x-paperlens-session": "wrong" } })).status, 401);
  assert.equal((await fetch(`${s.url}/api/papers`, { headers: { "x-paperlens-session": s.sessionSecret } })).status, 200);

  const bad = await fetch(`${s.url}/api/session`, { method: "POST", body: JSON.stringify({ secret: "nope" }) });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${s.url}/api/session`, { method: "POST", body: JSON.stringify({ secret: s.sessionSecret }) });
  const cookie = ok.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await fetch(`${s.url}/api/papers`, { headers: { cookie: cookie.split(";")[0] } })).status, 200);
});

test("画面（静的ファイル）は合言葉なしで配る。合言葉そのものは中に入れない", async () => {
  const res = await fetch(`${s.url}/`);
  const text = await res.text();
  assert.ok(!text.includes(s.sessionSecret));
});

// --- MCP の入口 -----------------------------------------------------------------

test("MCP: トークンが無い・ブラウザから・URL にトークン、は断る", async () => {
  const none = await mcp(null, init);
  assert.equal(none.status, 401);
  const { token, record } = tokens.issueToken({ name: "入口" });
  assert.equal((await mcp(token, init, { origin: "http://127.0.0.1:5173" })).status, 403);
  const q = await fetch(`${s.url}/mcp?token=${token}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(q.status, 400);
  // MCP のトークンでは画面の API（トークンの管理を含む）は使えない
  assert.equal((await fetch(`${s.url}/api/tokens`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  tokens.revokeToken(record.id);
});

test("MCP: スコープに入るツールだけが見え、呼んだことが記録に残る（本文は残さない）", async () => {
  const ro = tokens.issueToken({ name: "読むだけ", scopes: ["read"] });
  const r = await mcp(ro.token, init);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.serverInfo.name, "paperlens");
  const names = await listTools(ro.token);
  assert.ok(names.includes("list_papers"));
  assert.ok(!names.includes("set_translations"));
  assert.ok(!names.includes("remove_annotation"));

  const tr = tokens.issueToken({ name: "訳す", scopes: ["read", "sentences:write"] });
  const trNames = await listTools(tr.token);
  assert.ok(trNames.includes("set_translations"));
  assert.ok(!trNames.includes("clear_translations"), "delete のツールは見えない");
  assert.ok(!trNames.includes("import_paper"), "import のツールは見えない");

  // スコープ外のツールは、呼んでも存在しない扱い
  const denied = await mcp(ro.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clear_translations", arguments: { paper: "x", hashes: ["a"] } } });
  assert.ok(denied.body.error || denied.body.result?.isError);

  const call = await mcp(ro.token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_papers", arguments: {} } });
  assert.ok(!call.body.result.isError);
  const log = tokens.readAudit(50);
  assert.ok(log.some((e) => e.event === "call" && e.tool === "list_papers" && e.token === ro.record.id && e.ok));

  // 取り消したら次の呼び出しから断る
  tokens.revokeToken(ro.record.id);
  assert.equal((await mcp(ro.token, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 401);
  tokens.revokeToken(tr.record.id);
});

test("画面からトークンを発行・一覧・取り消しできる。一覧にハッシュは出さない", async () => {
  const h = { "x-paperlens-session": s.sessionSecret };
  const res = await fetch(`${s.url}/api/tokens`, { method: "POST", headers: h, body: JSON.stringify({ name: "画面から", scopes: ["read"], days: 30 }) });
  const issued = await res.json();
  assert.equal(res.status, 200);
  assert.match(issued.setup.claudeCode, new RegExp(`PAPERLENS_TOKEN=${issued.token}`));
  assert.ok(!issued.setup.claudeCodeMasked.includes(issued.token), "画面に出す方には平文を入れない");
  const list = await (await fetch(`${s.url}/api/tokens`, { headers: h })).json();
  const row = list.tokens.find((t: { id: string }) => t.id === issued.record.id);
  assert.ok(row && !("hash" in row));
  const del = await fetch(`${s.url}/api/tokens/${issued.record.id}`, { method: "DELETE", headers: h });
  assert.equal(del.status, 200);
});

test("トークンファイル方式: 0600 で書き、権限が緩いファイルは中継役が読まない", async () => {
  const h = { "x-paperlens-session": s.sessionSecret };
  const issued = await (await fetch(`${s.url}/api/tokens`, { method: "POST", headers: h, body: JSON.stringify({ name: "ファイル", delivery: "file" }) })).json();
  const file = path.join(data, "conf", "tokens", `${issued.record.id}.token`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await resolveToken({ PAPERLENS_TOKEN_FILE: file }), issued.token);
  fs.chmodSync(file, 0o644);
  await assert.rejects(resolveToken({ PAPERLENS_TOKEN_FILE: file }), /権限が緩すぎます/);
  await fetch(`${s.url}/api/tokens/${issued.record.id}`, { method: "DELETE", headers: h });
  assert.ok(!fs.existsSync(file), "取り消したらファイルも消す");
});

// --- サーバーの見つけ方 ---------------------------------------------------------

test("runtime.json の鍵で、相手が本物かを確かめる。鍵を知らない偽物は通さない", async () => {
  const rt = readRuntime();
  assert.ok(rt && rt.port === s.port);
  assert.equal(await verifyServer(rt), true);
  // 同じポート番号を名乗るが鍵の違う相手
  assert.equal(await verifyServer({ ...rt, key: "0".repeat(64) }), false);
  // 先にポートを取った偽物（何でも 200 で答える）
  const fake = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify({ proof: helloProof("1".repeat(64), "x") }));
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  const port = (fake.address() as { port: number }).port;
  assert.equal(await verifyServer({ ...rt, port }), false);
  fake.close();
});

test("アプリが開いていなければ、中継役が画面のないサーバーを起こし、同じトークンで使える", { timeout: 30_000 }, async () => {
  // アプリ役のサーバーを止めて runtime.json を消す
  await s.close();
  assert.equal(readRuntime(), null);
  const { token, record } = tokens.issueToken({ name: "ヘッドレス" });
  const rt = await findServer({ timeoutMs: 20_000 });
  assert.equal(rt.mode, "headless");
  const res = await fetch(`http://127.0.0.1:${rt.port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(init),
  });
  assert.equal(res.status, 200);
  // ヘッドレスは画面と画面の API を出さない
  assert.equal((await fetch(`http://127.0.0.1:${rt.port}/api/papers`)).status, 404);

  // アプリが起きると、ヘッドレスは止められ、runtime.json はアプリを指す
  s = await startServer({ port: 0, mode: "app" });
  const now = readRuntime();
  assert.equal(now?.mode, "app");
  // ヘッドレスは止まる（プロセスが終わるまで少し待つ）
  let stopped = false;
  for (let i = 0; i < 30 && !stopped; i++) {
    await new Promise((r) => setTimeout(r, 200));
    stopped = await fetch(`http://127.0.0.1:${rt.port}/mcp/hello`, { method: "POST", body: "{}", signal: AbortSignal.timeout(500) }).then(
      () => false,
      () => true,
    );
  }
  assert.ok(stopped, "ヘッドレスが止まっていない");
  tokens.revokeToken(record.id);
});
