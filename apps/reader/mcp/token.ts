// MCP の中継役がトークンを受け取る。上から順に見て、最初に見つかったものを使う。

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TOKEN_RE = /^plk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

function check(t: string, from: string) {
  const v = t.trim();
  if (!TOKEN_RE.test(v)) throw new Error(`${from} のトークンの形が正しくありません（plk_ で始まる文字列を設定してください）。`);
  return v;
}

const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.PAPERLENS_TOKEN) return check(env.PAPERLENS_TOKEN, "PAPERLENS_TOKEN");

  if (env.PAPERLENS_TOKEN_REF) {
    const m = /^keychain:([^/]+)\/(.+)$/.exec(env.PAPERLENS_TOKEN_REF);
    if (!m) throw new Error("PAPERLENS_TOKEN_REF は keychain:<サービス>/<識別子> の形で指定してください。");
    if (process.platform !== "darwin") throw new Error("キーチェーンからの読み出しは macOS でだけ使えます。");
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", m[1], "-a", m[2], "-w"]);
      return check(stdout, "キーチェーン");
    } catch (e) {
      if ((e as Error).message.includes("トークンの形")) throw e;
      throw new Error(`キーチェーンにトークン（${m[1]}/${m[2]}）が見つかりません。PaperLens の設定画面で発行し直してください。`);
    }
  }

  if (env.PAPERLENS_TOKEN_FILE) {
    const file = expand(env.PAPERLENS_TOKEN_FILE);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      throw new Error(`トークンファイルが見つかりません: ${file}`);
    }
    // SSH の秘密鍵と同じく、ほかの利用者が読めるファイルは使わない
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new Error(`トークンファイルの権限が緩すぎます（${(st.mode & 0o777).toString(8)}）。chmod 600 ${file} を実行してください。`);
    }
    return check(fs.readFileSync(file, "utf8"), "トークンファイル");
  }
  return null;
}
