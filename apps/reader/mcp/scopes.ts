// MCP ツールとスコープの対応。サーバーはトークンのスコープに入るツールだけを見せ、呼ばれたときにももう一度確かめる。

import type { Scope } from "../server/tokens.ts";

const MAP: Record<Exclude<Scope, "read">, string[]> = {
  "notes:write": [
    "set_fields",
    "set_status",
    "set_meta",
    "add_highlight",
    "update_highlight",
    "add_term",
    "update_term",
    "add_equation",
    "update_equation",
    "set_template",
  ],
  "sentences:write": ["parse_sentences", "set_translations", "add_sentence_note", "update_glossary", "skip_sentences", "fix_sentence_boundary"],
  "slides:write": [
    "add_slide_markup",
    "link_slide_markup",
    "update_slide_link",
    "unlink_slide_markup",
    "update_slide_markup",
    "set_slide_markup_memo",
    "set_slide_script",
    "restore_slide_markup",
  ],
  // ネットワークや端末の任意のパスに触るもの
  import: ["import_paper", "import_slides", "set_data_root"],
  delete: ["remove_annotation", "reset_template", "remove_glossary_terms", "remove_sentence_note", "clear_translations", "delete_slide_markup"],
};

const BY_TOOL = new Map<string, Scope>(Object.entries(MAP).flatMap(([scope, tools]) => tools.map((t) => [t, scope as Scope] as const)));

/** そのツールに要るスコープ。書き込みの表に無いツールは読み取り（read） */
export function scopeOf(tool: string, readOnly: boolean): Scope | null {
  const s = BY_TOOL.get(tool);
  if (s) return s;
  return readOnly ? "read" : null;
}

export const TOOLS_BY_SCOPE = MAP;
