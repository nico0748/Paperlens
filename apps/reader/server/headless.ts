// MCP の中継役が、アプリが開いていないときに裏で起こす「画面のないサーバー」。
// アプリ内のサーバーと同じコード・同じトークン台帳・同じスコープ判定を使い、MCP の入口（/mcp）だけを開く。
// 最後のリクエストから 10 分たつか、アプリが起きて止める合図を送ると終了する。

import { startServer } from "./app.ts";
import { alive, readRuntime } from "./runtime.ts";

// すでに別のサーバー（アプリか、先に起きたヘッドレス）が動いていれば、何もしないで終わる
const cur = readRuntime();
if (cur && cur.pid !== process.pid && alive(cur.pid)) process.exit(0);

const idleMs = Number(process.env.PAPERLENS_HEADLESS_IDLE_MS) || undefined;
const s = await startServer({ port: 0, mode: "headless", idleMs });
const stop = () => void s.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
