// PaperLens の MCP サーバー（stdio）。
// 標準出力は MCP の通信専用なので、ログは標準エラー出力に出す。
//
// トークン方式（推奨）: Claude からの要求を、PaperLens のローカルサーバーの /mcp へそのまま中継する。
//   ファイルには触らない。トークンの検査・スコープ・記録はサーバー側で行う。
//   アプリが開いていなければ、画面のないサーバー（server/headless.ts）を裏で起こす。
//   トークンを送る前に、相手が本物の PaperLens かをチャレンジ応答で確かめる。
//
//   PAPERLENS_TOKEN=plk_…                         トークンそのもの
//   PAPERLENS_TOKEN_REF=keychain:paperlens/<id>   macOS のキーチェーンから読む
//   PAPERLENS_TOKEN_FILE=<パス>                   権限 0600 のファイルから読む
//
// 旧方式（トークン無し）: 保存先のファイルを直接読み書きする。移行のあいだだけ残す。
//   PAPERLENS_CONFIG / PAPERLENS_DATA   保存先（アプリと同じ決め方。server/config.ts を参照）
//   PAPERLENS_MCP_READONLY=1            読み取りのツールだけを公開する

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveToken } from "./token.ts";

let token: string | null;
try {
  token = await resolveToken();
} catch (e) {
  process.stderr.write(`paperlens-mcp: ${(e as Error).message}\n`);
  process.exit(1);
}

if (token) {
  const { startProxy } = await import("./proxy.ts");
  await startProxy(token);
} else {
  const { dataRoot } = await import("../server/config.ts");
  const { createServer } = await import("./server.ts");
  const readOnly = process.env.PAPERLENS_MCP_READONLY === "1";
  const server = createServer({ readOnly });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`paperlens-mcp: 保存先 ${dataRoot()}${readOnly ? "（読み取りのみ）" : ""}\n`);
  process.stderr.write("paperlens-mcp: トークン無しの旧方式で動いています。PaperLens の設定画面でアクセストークンを発行し、登録し直してください。\n");
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
