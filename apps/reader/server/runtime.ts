// 動いているサーバーの居場所（paperlens.runtime.json）。
//
// MCP の中継役はこのファイルでサーバーのポートを知り、トークンを送る前に「相手が本物の PaperLens か」を
// チャレンジ応答で確かめる。ファイルは設定フォルダに 0600 で置くので、読めるのは同じ利用者のプロセスだけ。
// 先にポートを取った偽物はサーバー鍵を知らないので、正しい応答を返せない。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir, writePrivate } from "./tokens.ts";

export type RuntimeMode = "app" | "headless" | "server";
export interface Runtime {
  pid: number;
  port: number;
  mode: RuntimeMode;
  /** サーバー鍵（hex）。チャレンジ応答と、ヘッドレスを止める合図に使う */
  key: string;
  startedAt: string;
}

export const runtimePath = () => path.join(configDir(), "paperlens.runtime.json");

export function readRuntime(): Runtime | null {
  try {
    const r = JSON.parse(fs.readFileSync(runtimePath(), "utf8")) as Runtime;
    if (Number.isInteger(r.port) && typeof r.key === "string" && r.key.length === 64) return r;
  } catch {
    /* 無い・壊れている */
  }
  return null;
}

export function writeRuntime(r: Runtime) {
  writePrivate(runtimePath(), `${JSON.stringify(r, null, 2)}\n`);
}

/** 自分が書いたものだけを消す（後から起きた別のサーバーの分は残す） */
export function removeRuntime(key: string) {
  const cur = readRuntime();
  if (cur && cur.key === key) {
    try {
      fs.unlinkSync(runtimePath());
    } catch {
      /* もう無い */
    }
  }
}

export const newServerKey = () => crypto.randomBytes(32).toString("hex");

export const helloProof = (key: string, nonce: string) => crypto.createHmac("sha256", Buffer.from(key, "hex")).update(`paperlens-hello:${nonce}`).digest("hex");

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** そのプロセスが生きているか */
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
