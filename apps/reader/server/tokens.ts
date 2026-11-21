// MCP 接続用のアクセストークン。
//
// - 形は plk_<識別子 8 桁>_<秘密 43 文字>。秘密は 32 バイトの乱数を base64url にしたもの。
// - 台帳に残すのは秘密の SHA-256 だけ。平文は発行した直後に一度だけ返す。
// - 台帳と記録は、保存先フォルダ（Obsidian の保管庫として同期・公開されうる）ではなく、
//   設定ファイルと同じフォルダに 0600 で置く。
// - 照合は識別子で行を引き、ハッシュを timingSafeEqual で比べる。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configPath } from "./config.ts";

export const SCOPES = ["read", "notes:write", "sentences:write", "slides:write", "import", "delete"] as const;
export type Scope = (typeof SCOPES)[number];
export const EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const DEFAULT_EXPIRY_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

export interface TokenRecord {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string;
  /** 発行時に選んだ日数。再発行で同じ長さを使う */
  days: number;
  hash: string;
  lastUsedAt?: string;
  lastClient?: string;
}
export type PublicToken = Omit<TokenRecord, "hash"> & { prefix: string; expired: boolean; expiresSoon: boolean };

export class TokenError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/** 設定ファイルと同じフォルダ。台帳・記録・runtime.json を置く */
export const configDir = () => path.dirname(configPath());
const ledgerPath = () => path.join(configDir(), "paperlens.tokens.json");
const auditPath = () => path.join(configDir(), "paperlens.audit.log");

const TOKEN_RE = /^plk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

/** 0600 で書く。一時ファイルから置き換えるので、途中で落ちても台帳は壊れない */
export function writePrivate(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

let cache: { file: string; mtime: number; tokens: TokenRecord[] } | null = null;

function load(): TokenRecord[] {
  const file = ledgerPath();
  let mtime = -1;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cache = { file, mtime, tokens: [] };
    return cache.tokens;
  }
  if (cache && cache.file === file && cache.mtime === mtime) return cache.tokens;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { tokens?: TokenRecord[] };
    cache = { file, mtime, tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch {
    cache = { file, mtime, tokens: [] };
  }
  return cache.tokens;
}

function save(tokens: TokenRecord[]) {
  const file = ledgerPath();
  writePrivate(file, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`);
  cache = { file, mtime: fs.statSync(file).mtimeMs, tokens };
}

function checkScopes(v: unknown): Scope[] {
  if (!Array.isArray(v) || v.length === 0) throw new TokenError(400, "スコープを 1 つ以上選んでください。");
  const out = [...new Set(v)];
  for (const s of out) if (!SCOPES.includes(s as Scope)) throw new TokenError(400, `知らないスコープです: ${String(s)}`);
  return SCOPES.filter((s) => out.includes(s));
}

function checkDays(v: unknown): number {
  const d = v === undefined ? DEFAULT_EXPIRY_DAYS : Number(v);
  if (!EXPIRY_DAYS.includes(d as (typeof EXPIRY_DAYS)[number])) throw new TokenError(400, `有効期限は ${EXPIRY_DAYS.join(" / ")} 日のどれかです（無期限は選べません）。`);
  return d;
}

function newSecret() {
  const id = crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  return { id, token: `plk_${id}_${secret}`, hash: sha256(secret).toString("hex") };
}

export function toPublic(t: TokenRecord, now = Date.now()): PublicToken {
  const { hash: _hash, ...rest } = t;
  const exp = Date.parse(t.expiresAt);
  return { ...rest, prefix: `plk_${t.id}`, expired: exp <= now, expiresSoon: exp > now && exp - now <= 7 * DAY };
}

export function listTokens(): PublicToken[] {
  const now = Date.now();
  return load().map((t) => toPublic(t, now));
}

export function issueToken(input: { name?: unknown; scopes?: unknown; days?: unknown }, now = Date.now()) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new TokenError(400, "名前を入れてください（例: Claude Desktop・自宅の Mac）。");
  if ([...name].length > 64) throw new TokenError(400, "名前は 64 文字までです。");
  const scopes = checkScopes(input.scopes ?? ["read"]);
  const days = checkDays(input.days);
  const s = newSecret();
  const rec: TokenRecord = {
    id: s.id,
    name,
    scopes,
    days,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + days * DAY).toISOString(),
    hash: s.hash,
  };
  save([...load(), rec]);
  audit({ token: rec.id, event: "issue", ok: true });
  return { token: s.token, record: toPublic(rec, now) };
}

/** 同じ名前・スコープ・期間で新しいトークンを出し、古いものはその場で無効にする */
export function rotateToken(id: string, now = Date.now()) {
  const tokens = load();
  const old = tokens.find((t) => t.id === id);
  if (!old) throw new TokenError(404, "そのトークンはありません。");
  const s = newSecret();
  const rec: TokenRecord = {
    ...old,
    id: s.id,
    hash: s.hash,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + old.days * DAY).toISOString(),
    lastUsedAt: undefined,
    lastClient: undefined,
  };
  save([...tokens.filter((t) => t.id !== id), rec]);
  audit({ token: id, event: "rotate", ok: true, detail: rec.id });
  return { token: s.token, record: toPublic(rec, now), previous: id };
}

/** スコープは狭めることだけできる。広げるなら発行し直す（漏れたトークンが後から強くならないように） */
export function narrowToken(id: string, scopes: unknown) {
  const tokens = load();
  const t = tokens.find((x) => x.id === id);
  if (!t) throw new TokenError(404, "そのトークンはありません。");
  const next = checkScopes(scopes);
  if (next.some((s) => !t.scopes.includes(s))) throw new TokenError(400, "スコープを広げるときは、トークンを発行し直してください。");
  t.scopes = next;
  save(tokens);
  audit({ token: id, event: "narrow", ok: true, detail: next.join(" ") });
  return toPublic(t);
}

export function revokeToken(id: string) {
  const tokens = load();
  if (!tokens.some((t) => t.id === id)) throw new TokenError(404, "そのトークンはありません。");
  save(tokens.filter((t) => t.id !== id));
  audit({ token: id, event: "revoke", ok: true });
}

export function revokeAll() {
  const n = load().length;
  save([]);
  audit({ event: "revoke-all", ok: true, detail: String(n) });
  return n;
}

// --- 照合 -----------------------------------------------------------------------

/** 識別子ごとの失敗回数。1 分に 10 回を超えたら、その識別子を 1 分間締め出す（総当たり対策） */
const failures = new Map<string, { count: number; since: number; lockedUntil: number }>();
const FAIL_WINDOW = 60_000;
const FAIL_LIMIT = 10;

function noteFailure(id: string, now: number) {
  const f = failures.get(id);
  if (!f || now - f.since > FAIL_WINDOW) {
    failures.set(id, { count: 1, since: now, lockedUntil: 0 });
    return;
  }
  f.count++;
  if (f.count > FAIL_LIMIT) f.lockedUntil = now + FAIL_WINDOW;
}

let touchTimer: NodeJS.Timeout | null = null;
function touch(t: TokenRecord, client: string | undefined, now: number) {
  t.lastUsedAt = new Date(now).toISOString();
  if (client) t.lastClient = client.slice(0, 80);
  // 使った時刻は 5 秒ごとにまとめて書く（1 回ごとに台帳を書き換えない）
  if (touchTimer) return;
  touchTimer = setTimeout(() => {
    touchTimer = null;
    const tokens = load();
    const cur = tokens.find((x) => x.id === t.id);
    if (!cur) return;
    cur.lastUsedAt = t.lastUsedAt;
    cur.lastClient = t.lastClient;
    try {
      save(tokens);
    } catch {
      /* 使った時刻が残らなくても、照合には影響しない */
    }
  }, 5000);
  touchTimer.unref?.();
}

/**
 * `Authorization` ヘッダーの値を確かめ、通ったトークンを返す。
 * 失敗の理由は利用者に見せられる文で投げる（どこが違ったかの細部は出さない）。
 */
export function verifyBearer(header: string | undefined, client?: string, now = Date.now()): TokenRecord {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) throw new TokenError(401, "アクセストークンがありません。PaperLens の設定画面でトークンを発行し、PAPERLENS_TOKEN に設定してください。");
  const parsed = TOKEN_RE.exec(m[1]);
  if (!parsed) {
    audit({ event: "auth", ok: false, detail: "malformed" });
    throw new TokenError(401, "アクセストークンの形が正しくありません。");
  }
  const [, id, secret] = parsed;
  const f = failures.get(id);
  if (f && f.lockedUntil > now) throw new TokenError(429, "認証の失敗が続いたため、しばらく受け付けません。1 分ほど待ってください。");
  const t = load().find((x) => x.id === id);
  const expected = t ? Buffer.from(t.hash, "hex") : crypto.randomBytes(32);
  const ok = crypto.timingSafeEqual(sha256(secret), expected) && !!t;
  if (!ok || !t) {
    noteFailure(id, now);
    audit({ token: id, event: "auth", ok: false, detail: t ? "mismatch" : "unknown" });
    throw new TokenError(401, "アクセストークンが違うか、取り消されています。PaperLens の設定画面で確かめてください。");
  }
  if (Date.parse(t.expiresAt) <= now) {
    audit({ token: id, event: "auth", ok: false, detail: "expired" });
    throw new TokenError(401, `アクセストークン「${t.name}」は有効期限が切れています。PaperLens の設定画面で再発行してください。`);
  }
  touch(t, client, now);
  return t;
}

// --- 記録（監査ログ） -----------------------------------------------------------
// 1 行 1 件の JSON。ツール名・論文 ID・成否・日時だけを残し、引数の本文（訳文・メモ）は残さない。

export interface AuditEntry {
  at?: string;
  token?: string;
  event: "call" | "auth" | "issue" | "rotate" | "narrow" | "revoke" | "revoke-all";
  tool?: string;
  paper?: string;
  ok: boolean;
  detail?: string;
}
const AUDIT_KEEP = 90 * DAY;
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

/** ログに出してよい形にする。plk_ で始まる文字列は伏せる */
export const redact = (s: string) => s.replace(/plk_[0-9a-f]{8}_[A-Za-z0-9_-]+/g, (m) => `${m.slice(0, 13)}…`);

export function audit(e: AuditEntry) {
  const entry = { at: new Date().toISOString(), ...e, detail: e.detail ? redact(e.detail).slice(0, 200) : undefined };
  const file = auditPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (fs.statSync(file).size > AUDIT_MAX_BYTES) pruneAudit();
  } catch {
    /* 記録できなくても処理は止めない */
  }
}

function pruneAudit(now = Date.now()) {
  const lines = readAuditLines();
  const keep = lines.filter((l) => now - Date.parse(l.at ?? "") < AUDIT_KEEP).slice(-5000);
  writePrivate(auditPath(), keep.map((l) => JSON.stringify(l)).join("\n") + (keep.length ? "\n" : ""));
}

function readAuditLines(): AuditEntry[] {
  try {
    return fs
      .readFileSync(auditPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as AuditEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** 新しい順。90 日より古いものは出さない */
export function readAudit(limit = 200, now = Date.now()) {
  return readAuditLines()
    .filter((l) => now - Date.parse(l.at ?? "") < AUDIT_KEEP)
    .slice(-limit)
    .reverse();
}

/** テスト用: 台帳の読み込みを捨てる */
export function _resetTokenCache() {
  cache = null;
  failures.clear();
}
