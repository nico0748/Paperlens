// トークン方式の MCP 中継役。Claude（stdio）と PaperLens のローカルサーバー（HTTP の /mcp）をつなぐ。
// ここではファイルに一切触らない。データへの入口はサーバー 1 か所だけにする。

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { type Runtime, helloProof, readRuntime, safeEqual } from "../server/runtime.ts";

const log = (s: string) => process.stderr.write(`paperlens-mcp: ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 相手が本物の PaperLens か。runtime.json の鍵で作った応答を返せるかで確かめる */
export async function verifyServer(rt: Runtime): Promise<boolean> {
  const nonce = crypto.randomBytes(16).toString("hex");
  try {
    const res = await fetch(`http://127.0.0.1:${rt.port}/mcp/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const { proof } = (await res.json()) as { proof?: unknown };
    return typeof proof === "string" && safeEqual(proof, helloProof(rt.key, nonce));
  } catch {
    return false;
  }
}

/** 画面のないサーバーを起こす。この中継役とは切り離して動かす（中継役が終わっても、少しのあいだ残る） */
function spawnHeadless() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = import.meta.url.endsWith(".js");
  const args = built ? [path.join(here, "headless.js")] : ["--experimental-strip-types", "--no-warnings", path.join(here, "..", "server", "headless.ts")];
  const env = { ...process.env };
  // トークンはヘッドレスには要らない
  delete env.PAPERLENS_TOKEN;
  delete env.PAPERLENS_TOKEN_REF;
  delete env.PAPERLENS_TOKEN_FILE;
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env });
  child.unref();
}

export class ServerUnavailable extends Error {}

/** 動いている本物のサーバーを探す。無ければ起こして、起きるまで待つ */
export async function findServer(opts: { spawn?: boolean; timeoutMs?: number } = {}): Promise<Runtime> {
  const rt = readRuntime();
  if (rt && (await verifyServer(rt))) return rt;
  if (rt) log(`runtime.json のサーバー（ポート ${rt.port}）が応答しないか、本物と確かめられませんでした。`);
  if (opts.spawn === false) throw new ServerUnavailable("PaperLens のサーバーが見つかりません。");
  log("PaperLens が開いていないため、画面のないサーバーを起動します。");
  spawnHeadless();
  const until = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < until) {
    await sleep(200);
    const next = readRuntime();
    if (next && (await verifyServer(next))) return next;
  }
  throw new ServerUnavailable("PaperLens のサーバーを起動できませんでした。保存先フォルダと設定（PAPERLENS_CONFIG）を確かめてください。");
}

type Msg = JSONRPCMessage & { id?: string | number; method?: string; params?: { clientInfo?: { name?: string; version?: string } } };

export async function startProxy(token: string) {
  const stdio = new StdioServerTransport();
  let conn: Runtime | null = null;
  let client = "";

  const errorReply = (msg: Msg, message: string, code = -32000) => {
    if (msg.id === undefined || !msg.method) return; // 通知には返事をしない
    void stdio.send({ jsonrpc: "2.0", id: msg.id, error: { code, message } } as JSONRPCMessage);
  };

  async function post(rt: Runtime, msg: Msg) {
    return fetch(`http://127.0.0.1:${rt.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": client || "paperlens-mcp",
      },
      body: JSON.stringify(msg),
    });
  }

  async function forward(msg: Msg) {
    if (msg.method === "initialize" && msg.params?.clientInfo?.name) {
      client = `${msg.params.clientInfo.name}${msg.params.clientInfo.version ? ` ${msg.params.clientInfo.version}` : ""}`;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // アプリが起きてヘッドレスが止まった、などで居場所が変わっていたら探し直す
        const cur = readRuntime();
        if (conn && (!cur || cur.key !== conn.key)) conn = null;
        conn ??= await findServer();
        const res = await post(conn, msg);
        if (res.status === 202) return;
        const text = await res.text();
        let body: (Msg & { error?: { code: number; message: string } }) | null = null;
        try {
          body = JSON.parse(text);
        } catch {
          /* JSON でない */
        }
        if (!res.ok) {
          errorReply(msg, body?.error?.message ?? `PaperLens のサーバーがエラーを返しました（${res.status}）。`, body?.error?.code ?? -32000);
          return;
        }
        if (body) await stdio.send(body as JSONRPCMessage);
        return;
      } catch (e) {
        conn = null;
        if (e instanceof ServerUnavailable || attempt === 1) {
          errorReply(msg, e instanceof Error ? e.message : String(e));
          return;
        }
        // 接続が切れた（サーバーが止まった）。次の周で探し直す
      }
    }
  }

  stdio.onmessage = (m) => void forward(m as Msg);
  stdio.onerror = (e) => log(`通信エラー: ${e.message}`);
  await stdio.start();
  log("トークン方式で起動しました（データへの読み書きは PaperLens のサーバーを通します）。");

  const shutdown = async () => {
    await stdio.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
}
