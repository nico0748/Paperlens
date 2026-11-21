// MCP 接続のアクセストークン: 発行・一覧・スコープを狭める・再発行・取り消し・記録。
// 平文のトークンは発行した直後の 1 回だけ受け取り、画面には伏せて出す（コピーしたときだけ平文が入る）。
import { useCallback, useEffect, useState } from "react";
import { type AuditEntry, type Delivery, type IssuedToken, type McpInfo, type McpToken, type Scope, type TokenList, serverApi } from "../../lib/backend.ts";
import { CopyBlock } from "./IntegrationPages.tsx";
import { Input, Select, SettingHeading, SettingItem } from "./Setting.tsx";

export const SCOPE_INFO: Record<Scope, { label: string; desc: string; risky?: string }> = {
  read: { label: "読み取り", desc: "論文の一覧・本文・ノート・対訳・スライドを読む" },
  "notes:write": { label: "ノートの書き込み", desc: "記録欄・段階・マーカー・用語・数式・テンプレートを書く" },
  "sentences:write": { label: "対訳の書き込み", desc: "1 文ずつの訳・文のメモ・訳語・文の区切りを書く" },
  "slides:write": { label: "スライドの書き込み", desc: "スライドのグループ・論文へのリンク・台本を書く" },
  import: {
    label: "取り込み",
    desc: "URL や端末のファイルから論文・スライドを取り込む。保存先の変更も含む",
    risky: "ネットワークと端末のファイルに触ります。論文の本文に仕込まれた指示で、意図しない取り込みをされるおそれがあります。",
  },
  delete: {
    label: "削除",
    desc: "マーカー・訳・メモ・用語・スライドのグループを消す。テンプレートを初期に戻す",
    risky: "論文の本文に仕込まれた指示で、記録を消されるおそれがあります。普段使いのトークンには付けないでください。",
  },
};

const PRESETS: { label: string; scopes: Scope[] }[] = [
  { label: "読むだけ", scopes: ["read"] },
  { label: "訳を付けてもらう", scopes: ["read", "sentences:write"] },
  { label: "読解を手伝ってもらう", scopes: ["read", "notes:write", "sentences:write", "slides:write"] },
];

const DELIVERY_LABEL: Record<Delivery, { label: string; desc: string }> = {
  env: { label: "環境変数", desc: "Claude の設定にトークンをそのまま書きます。いちばん手軽です。" },
  keychain: { label: "キーチェーン", desc: "トークンを macOS のキーチェーンに入れ、Claude の設定には参照だけを書きます。" },
  file: { label: "トークンファイル", desc: "設定フォルダに権限 0600 のファイルとして置き、Claude の設定にはパスだけを書きます。" },
};

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { dateStyle: "medium" });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function McpTokens({ info }: { info: McpInfo }) {
  const [list, setList] = useState<TokenList | null>(null);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [showForm, setShowForm] = useState(false);
  const reload = useCallback(() => {
    serverApi.tokens().then(setList, (e: unknown) => setError(errText(e)));
  }, []);
  useEffect(reload, [reload]);
  const deliveries = info.deliveries?.length ? info.deliveries : (["env", "file"] as Delivery[]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    }
    reload();
  };

  return (
    <div className="token-section">
      <SettingHeading>アクセストークン</SettingHeading>
      <p className="settings-text">
        Claude などの AI エージェントは、ここで発行したトークンで PaperLens に接続します。トークンごとに使える操作（スコープ）と有効期限を決められ、いつでも取り消せます。
        データの読み書きはすべて PaperLens のサーバーを通り、トークンを持たない接続は断られます。
      </p>
      {error && <p className="err-msg" role="alert">{error}</p>}

      {issued && <IssuedPanel issued={issued} onClose={() => setIssued(null)} desktopConfigPath={info.desktopConfigPath} />}

      {list && list.tokens.length > 0 && (
        <ul className="token-list">
          {list.tokens.map((t) => (
            <TokenRow
              key={t.id}
              t={t}
              onNarrow={(scopes) => act(() => serverApi.narrowToken(t.id, scopes))}
              onRotate={(d) =>
                act(async () => {
                  setIssued(await serverApi.rotateToken(t.id, d));
                })
              }
              onRevoke={() => {
                if (window.confirm(`トークン「${t.name}」を取り消しますか？ このトークンを使っている AI エージェントは、次の呼び出しから接続できなくなります。`)) void act(() => serverApi.revokeToken(t.id));
              }}
              deliveries={deliveries}
            />
          ))}
        </ul>
      )}
      {list && list.tokens.length === 0 && !showForm && <p className="settings-text">まだトークンはありません。</p>}

      <div className="row token-actions">
        {!showForm && (
          <button type="button" className="btn primary sm" onClick={() => setShowForm(true)}>
            トークンを発行する
          </button>
        )}
        {list && list.tokens.length > 1 && (
          <button
            type="button"
            className="btn text sm danger-text"
            onClick={() => {
              if (window.confirm("すべてのトークンを取り消しますか？ 漏れたおそれがあるときに使います。接続しているすべての AI エージェントが使えなくなります。")) void act(() => serverApi.revokeAllTokens());
            }}
          >
            すべて取り消す
          </button>
        )}
      </div>

      {showForm && list && (
        <IssueForm
          list={list}
          deliveries={deliveries}
          onCancel={() => setShowForm(false)}
          onIssue={(body) =>
            act(async () => {
              setIssued(await serverApi.issueToken(body));
              setShowForm(false);
            })
          }
        />
      )}

      <AuditLog tokens={list?.tokens ?? []} />
    </div>
  );
}

function IssueForm({
  list,
  deliveries,
  onIssue,
  onCancel,
}: {
  list: TokenList;
  deliveries: Delivery[];
  onIssue: (b: { name: string; scopes: Scope[]; days: number; delivery: Delivery }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [days, setDays] = useState(list.defaultDays);
  const [delivery, setDelivery] = useState<Delivery>("env");
  const toggle = (s: Scope, on: boolean) => {
    if (on && SCOPE_INFO[s].risky && !window.confirm(`「${SCOPE_INFO[s].label}」を許可しますか？\n${SCOPE_INFO[s].risky}`)) return;
    setScopes((cur) => list.scopes.filter((x) => (x === s ? on : cur.includes(x))));
  };
  return (
    <form
      className="token-form"
      onSubmit={(e) => {
        e.preventDefault();
        onIssue({ name: name.trim(), scopes, days, delivery });
      }}
    >
      <SettingItem name="名前" desc="どの AI エージェントのためのトークンか（例: Claude Desktop・自宅の Mac）。" htmlFor="token-name">
        <Input id="token-name" value={name} maxLength={64} placeholder="Claude Code" onChange={(e) => setName(e.target.value)} />
      </SettingItem>
      <SettingItem name="使える操作" desc="必要なものだけを選びます（最小権限）。ひな形から始めて、個別に外せます。" stacked>
        <div className="row token-presets">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="btn tonal sm" onClick={() => setScopes(p.scopes)}>
              {p.label}
            </button>
          ))}
        </div>
        <ul className="scope-list">
          {list.scopes.map((s) => (
            <li key={s}>
              <label>
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => toggle(s, e.target.checked)} />
                <span className="scope-name">
                  {SCOPE_INFO[s].label} <code>{s}</code>
                  {SCOPE_INFO[s].risky && <span className="tag tag-risky">注意</span>}
                </span>
                <span className="scope-desc">{SCOPE_INFO[s].desc}</span>
              </label>
            </li>
          ))}
        </ul>
      </SettingItem>
      <SettingItem name="有効期限" desc="期限が来たら使えなくなります。7 日前から再発行を促します。無期限は選べません。" htmlFor="token-days">
        <Select id="token-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {list.expiryDays.map((d) => (
            <option key={d} value={d}>
              {d === 365 ? "1 年" : `${d} 日`}
              {d === list.defaultDays ? "（既定）" : ""}
            </option>
          ))}
        </Select>
      </SettingItem>
      <SettingItem name="Claude への渡し方" desc={DELIVERY_LABEL[delivery].desc} htmlFor="token-delivery">
        <Select id="token-delivery" value={delivery} onChange={(e) => setDelivery(e.target.value as Delivery)}>
          {deliveries.map((d) => (
            <option key={d} value={d}>
              {DELIVERY_LABEL[d].label}
            </option>
          ))}
        </Select>
      </SettingItem>
      <div className="row token-actions">
        <button type="submit" className="btn primary sm" disabled={!name.trim() || scopes.length === 0}>
          発行する
        </button>
        <button type="button" className="btn text sm" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function IssuedPanel({ issued, onClose, desktopConfigPath }: { issued: IssuedToken; onClose: () => void; desktopConfigPath: string }) {
  const masked = `${issued.token.slice(0, 13)}${"•".repeat(12)}`;
  return (
    <div className="token-issued" role="status">
      <p className="notice warn">
        トークン「{issued.record.name}」を発行しました。<strong>このトークンはいまだけ表示されます。</strong>閉じると二度と見られません（失くしたら再発行します）。
        {issued.setup.delivery === "keychain" && " トークンはキーチェーンに保存しました。"}
        {issued.setup.delivery === "file" && " トークンは設定フォルダのファイル（0600）に保存しました。"}
      </p>
      {issued.setup.delivery === "env" && <CopyBlock label="トークン" text={masked} copyText={issued.token} />}
      <SettingHeading>Claude Code で使う</SettingHeading>
      <p className="settings-text">すでに paperlens を登録しているときは、先に <code>claude mcp remove paperlens</code> を実行してから、次のコマンドを実行します。</p>
      <CopyBlock label="Claude Code のコマンド" text={issued.setup.claudeCodeMasked} copyText={issued.setup.claudeCode} />
      <SettingHeading>Claude Desktop で使う</SettingHeading>
      <p className="settings-text">
        設定ファイル <code className="path">{desktopConfigPath}</code> の <code>paperlens</code> の項目を次の内容に置き換え、Claude Desktop を再起動します。
      </p>
      <CopyBlock label="Claude Desktop の設定" text={issued.setup.desktopConfigMasked} copyText={issued.setup.desktopConfig} />
      <div className="row token-actions">
        <button type="button" className="btn sm" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}

function TokenRow({
  t,
  deliveries,
  onNarrow,
  onRotate,
  onRevoke,
}: {
  t: McpToken;
  deliveries: Delivery[];
  onNarrow: (s: Scope[]) => void;
  onRotate: (d: Delivery) => void;
  onRevoke: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [scopes, setScopes] = useState<Scope[]>(t.scopes);
  const [delivery, setDelivery] = useState<Delivery>("env");
  const state = t.expired ? { cls: "is-error", text: "期限切れ" } : t.expiresSoon ? { cls: "is-warn", text: "まもなく期限切れ" } : { cls: "is-ok", text: "有効" };
  return (
    <li className="token-row">
      <div className="token-head">
        <span className="token-name">{t.name}</span>
        <code className="token-prefix">{t.prefix}_…</code>
        <span className={`status-pill ${state.cls}`}>{state.text}</span>
      </div>
      <div className="token-scopes">
        {t.scopes.map((s) => (
          <span key={s} className={`tag${SCOPE_INFO[s].risky ? " tag-risky" : ""}`} title={SCOPE_INFO[s].desc}>
            {SCOPE_INFO[s].label}
          </span>
        ))}
      </div>
      <dl className="token-meta">
        <dt>作成</dt>
        <dd>{fmt(t.createdAt)}</dd>
        <dt>期限</dt>
        <dd>{fmtDate(t.expiresAt)}（{t.days === 365 ? "1 年" : `${t.days} 日`}）</dd>
        <dt>最後に使った</dt>
        <dd>
          {fmt(t.lastUsedAt)}
          {t.lastClient ? `（${t.lastClient}）` : ""}
        </dd>
      </dl>
      {editing ? (
        <div className="token-narrow">
          <p className="settings-text">外せるだけです。広げるときは新しく発行してください（漏れたトークンが後から強くならないように）。</p>
          <ul className="scope-list compact">
            {t.scopes.map((s) => (
              <li key={s}>
                <label>
                  <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? t.scopes.filter((x) => x === s || cur.includes(x)) : cur.filter((x) => x !== s)))} />
                  <span className="scope-name">{SCOPE_INFO[s].label}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row token-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={scopes.length === 0 || scopes.length === t.scopes.length}
              onClick={() => {
                onNarrow(scopes);
                setEditing(false);
              }}
            >
              狭める
            </button>
            <button type="button" className="btn text sm" onClick={() => setEditing(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <div className="row token-actions">
          {t.scopes.length > 1 && (
            <button type="button" className="btn text sm" onClick={() => setEditing(true)}>
              スコープを狭める
            </button>
          )}
          <Select aria-label="再発行したトークンの渡し方" className="sm" value={delivery} onChange={(e) => setDelivery(e.target.value as Delivery)}>
            {deliveries.map((d) => (
              <option key={d} value={d}>
                {DELIVERY_LABEL[d].label}
              </option>
            ))}
          </Select>
          <button
            type="button"
            className="btn text sm"
            onClick={() => {
              if (window.confirm(`トークン「${t.name}」を再発行しますか？ 今のトークンはすぐに使えなくなるので、Claude の設定も新しいものに置き換えてください。`)) onRotate(delivery);
            }}
          >
            再発行
          </button>
          <button type="button" className="btn text sm danger-text" onClick={onRevoke}>
            取り消す
          </button>
        </div>
      )}
    </li>
  );
}

const EVENT_LABEL: Record<string, string> = {
  call: "呼び出し",
  auth: "認証の失敗",
  issue: "発行",
  rotate: "再発行",
  narrow: "スコープを狭めた",
  revoke: "取り消し",
  "revoke-all": "すべて取り消し",
};

function AuditLog({ tokens }: { tokens: McpToken[] }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    if (open) serverApi.tokenAudit(100).then((r) => setEntries(r.entries), () => setEntries([]));
  }, [open]);
  const nameOf = (id?: string) => (id ? (tokens.find((t) => t.id === id)?.name ?? `plk_${id}`) : "—");
  return (
    <details className="token-audit" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>記録（直近 100 件・90 日分まで残します）</summary>
      <p className="settings-text">どのトークンが、いつ、どのツールを、どの論文に使ったかを残します。訳文やメモの中身は残しません。</p>
      {entries && entries.length === 0 && <p className="settings-text">まだ記録はありません。</p>}
      {entries && entries.length > 0 && (
        <table className="audit-table">
          <thead>
            <tr>
              <th>日時</th>
              <th>トークン</th>
              <th>内容</th>
              <th>論文</th>
              <th>結果</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className={e.ok ? undefined : "is-fail"}>
                <td>{fmt(e.at)}</td>
                <td>{nameOf(e.token)}</td>
                <td>{e.event === "call" ? <code>{e.tool}</code> : EVENT_LABEL[e.event] ?? e.event}</td>
                <td>{e.paper ?? ""}</td>
                <td>{e.ok ? "成功" : "失敗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
