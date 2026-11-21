// 発行したトークンを Claude 側へ渡す方法（D3）。
//
//   env       Claude の設定に PAPERLENS_TOKEN=plk_… を書く（既定・いちばん手軽）
//   keychain  macOS のキーチェーンに入れ、設定には PAPERLENS_TOKEN_REF=keychain:paperlens/<識別子> だけを書く
//   file      設定フォルダの tokens/<識別子>.token（0600）に書き、設定には PAPERLENS_TOKEN_FILE=<パス> を書く
//
// どの方式でも、組み立てたコマンドと JSON を返す。画面はトークン部分を伏せて見せ、コピーするときだけ平文を入れる。

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { mcpSnippets } from "./mcpinfo.ts";
import { TokenError, configDir, writePrivate } from "./tokens.ts";

const run = promisify(execFile);
export const KEYCHAIN_SERVICE = "paperlens";
export type Delivery = "env" | "keychain" | "file";

export const tokenFilePath = (id: string) => path.join(configDir(), "tokens", `${id}.token`);

function checkDelivery(v: unknown): Delivery {
  const d = v === undefined || v === null || v === "" ? "env" : v;
  if (d !== "env" && d !== "keychain" && d !== "file") throw new TokenError(400, "渡し方は env / keychain / file のどれかです。");
  if (d === "keychain" && process.platform !== "darwin") throw new TokenError(400, "キーチェーンは macOS でだけ使えます。");
  return d;
}

const MASK = (token: string) => `${token.slice(0, 13)}${"•".repeat(12)}`;

export async function deliverToken(token: string, id: string, delivery: unknown) {
  const d = checkDelivery(delivery);
  let env: Record<string, string>;
  let masked: Record<string, string>;
  if (d === "keychain") {
    // -U: 同じ識別子があれば上書き。値は引数で渡す（同じ利用者のプロセスからしか見えない）
    try {
      await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", id, "-l", `PaperLens MCP (${id})`, "-w", token]);
    } catch (e) {
      throw new TokenError(500, `キーチェーンに保存できませんでした: ${(e as Error).message.split("\n")[0]}`);
    }
    env = masked = { PAPERLENS_TOKEN_REF: `keychain:${KEYCHAIN_SERVICE}/${id}` };
  } else if (d === "file") {
    const file = tokenFilePath(id);
    writePrivate(file, `${token}\n`);
    env = masked = { PAPERLENS_TOKEN_FILE: file };
  } else {
    env = { PAPERLENS_TOKEN: token };
    masked = { PAPERLENS_TOKEN: MASK(token) };
  }
  const plain = mcpSnippets(env);
  const shown = mcpSnippets(masked);
  return {
    delivery: d,
    /** コピー用（平文入り） */
    desktopConfig: plain.desktopConfig,
    claudeCode: plain.claudeCode,
    /** 画面に出す用（トークンを伏せたもの） */
    desktopConfigMasked: shown.desktopConfig,
    claudeCodeMasked: shown.claudeCode,
  };
}

/** 取り消し・再発行のとき、キーチェーンとトークンファイルに残った秘密も消す */
export async function removeDeliveredToken(id: string) {
  try {
    fs.unlinkSync(tokenFilePath(id));
  } catch {
    /* 無い */
  }
  if (process.platform === "darwin") {
    try {
      await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id]);
    } catch {
      /* 無い */
    }
  }
}
