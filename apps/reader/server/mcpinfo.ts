// 設定画面に出す、MCP サーバーの登録方法。
// Claude Desktop の設定（JSON）と Claude Code のコマンドを、この端末のパスで組み立てる。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRANSLATION_WORKFLOW } from "../mcp/sentenceTools.ts";
import { scopeOf } from "../mcp/scopes.ts";
import { SENTENCE_TOOL_NAMES, TOOLS } from "../mcp/tools.ts";
import { APP_ROOT, configPath, readConfig } from "./config.ts";

/** Electron の中から呼ばれたときは execPath が Electron 本体になるため、node を探させる。 */
function resolveNode() {
  return process.versions.electron ? "node" : process.execPath;
}

function desktopConfigPath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

const quote = (s: string) => (/^[\w./:@=•-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** MCP の起動コマンドと、それに渡す環境変数（保存先の決め方）。トークンは含めない */
export function mcpLaunch() {
  const node = resolveNode();
  const built = path.join(APP_ROOT, "dist-server", "mcp.js");
  const isBuilt = fs.existsSync(built);
  // ビルド前はソースをそのまま動かす（Node.js 22.6 以上の型除去を使う）
  const args = isBuilt ? [built] : ["--experimental-strip-types", "--no-warnings", path.join(APP_ROOT, "mcp", "main.ts")];
  const dataRoot = readConfig().dataRoot;
  // 保存先そのものではなく設定ファイルを渡す。画面で保存先を変えると、AI エージェントも同じフォルダに付いてくる
  const env: Record<string, string> = { PAPERLENS_CONFIG: configPath() };
  if (process.env.PAPERLENS_DATA) env.PAPERLENS_DATA = dataRoot;
  if (process.env.PAPERLENS_DEFAULT_DATA) env.PAPERLENS_DEFAULT_DATA = process.env.PAPERLENS_DEFAULT_DATA;
  return { node, args, env, built: isBuilt, dataRoot };
}

/** Claude Desktop の設定 JSON と Claude Code のコマンドを組み立てる */
export function mcpSnippets(extraEnv: Record<string, string>) {
  const { node, args, env } = mcpLaunch();
  const all = { ...env, ...extraEnv };
  const desktop = JSON.stringify({ mcpServers: { paperlens: { command: node, args, env: all } } }, null, 2);
  const code = ["claude mcp add paperlens", ...Object.entries(all).map(([k, v]) => `-e ${k}=${quote(v)}`), "--", quote(node), ...args.map(quote)].join(" ");
  return { desktopConfig: desktop, claudeCode: code };
}

export function mcpInfo() {
  const { node, args, built: isBuilt, dataRoot } = mcpLaunch();
  // 旧方式（トークン無し・ファイルを直接読み書き）。移行のあいだだけ残す
  const legacy = mcpSnippets({});
  const legacyRo = mcpSnippets({ PAPERLENS_MCP_READONLY: "1" });

  return {
    node,
    script: args[args.length - 1],
    dataRoot,
    built: isBuilt,
    desktopConfig: legacy.desktopConfig,
    desktopConfigReadOnly: legacyRo.desktopConfig,
    claudeCode: legacy.claudeCode,
    claudeCodeReadOnly: legacyRo.claudeCode,
    desktopConfigPath: desktopConfigPath(),
    /** トークン方式の渡し方のうち、この端末で選べるもの */
    deliveries: process.platform === "darwin" ? ["env", "keychain", "file"] : ["env", "file"],
    // group: notes = 読解ノート・マーカー・用語・数式、sentences = 1 文ずつの対訳（sentences.json）
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.config.title,
      write: !t.config.annotations.readOnlyHint,
      scope: scopeOf(t.name, t.config.annotations.readOnlyHint),
      group: SENTENCE_TOOL_NAMES.has(t.name) ? ("sentences" as const) : ("notes" as const),
    })),
    /** 全文翻訳の手順（設定画面で「Claude に全文を訳させるには」として見せる）。 */
    translationWorkflow: [...TRANSLATION_WORKFLOW],
    /** 全文翻訳を頼むときのプロンプト名（MCP のプロンプト）。 */
    translationPrompt: "translate_paper",
  };
}
