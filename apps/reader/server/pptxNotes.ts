// PPTX の発表者ノートを、スライドの順に取り出す（取り込むときに台本へ入れるため）。
// PPTX は ZIP なので、中央ディレクトリを読んで必要な XML だけを展開する（ZIP のライブラリは使わない）。
//   ppt/presentation.xml の sldIdLst がスライドの順。r:id を ppt/_rels/presentation.xml.rels で slides/slideN.xml へ、
//   その slides/_rels/slideN.xml.rels で notesSlides/notesSlideM.xml へたどる。
// 非表示のスライド（show="0"）は PDF に書き出されないので、ページの順を合わせるために飛ばす。
// 読めないところがあっても取り込みは止めない（ノートが入らないだけ）。

import { inflateRawSync } from "node:zlib";

/** ZIP の中のファイル名 → 中身 */
function readZip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // 終端レコード（EOCD）を後ろから探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name) || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    try {
      if (method === 0) out.set(name, raw);
      else if (method === 8) out.set(name, inflateRawSync(raw));
    } catch {
      // 壊れた項目は読まない
    }
  }
  return out;
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

/** .rels の Id → Target */
function rels(xml: string | undefined): Map<string, { target: string; type: string }> {
  const m = new Map<string, { target: string; type: string }>();
  for (const t of xml?.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(t, "Id");
    const target = attr(t, "Target");
    if (id && target) m.set(id, { target, type: attr(t, "Type") ?? "" });
  }
  return m;
}

/** dir からの相対パスを、ZIP の中のパスにする */
function resolve(dir: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dir.split("/").filter(Boolean);
  for (const s of target.split("/")) {
    if (s === "..") parts.pop();
    else if (s && s !== ".") parts.push(s);
  }
  return parts.join("/");
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** ノートのスライドから、本文の欄（type="body"）の文字を段落ごとに取り出す。スライド番号や画像の欄は読まない */
export function notesText(xml: string): string {
  const paras: string[] = [];
  for (const sp of xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? []) {
    const ph = sp.match(/<p:ph\b[^>]*>/)?.[0];
    if (!ph || attr(ph, "type") !== "body") continue;
    for (const para of sp.match(/<a:p\/>|<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
      const text = (para.match(/<a:t>([\s\S]*?)<\/a:t>|<a:t\/>|<a:br\/>/g) ?? [])
        .map((r) => (r === "<a:br/>" ? "\n" : unescape(r.replace(/^<a:t>|<\/a:t>$|^<a:t\/>$/g, ""))))
        .join("");
      paras.push(text);
    }
  }
  return paras.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** スライドの順（PDF のページの順）の発表者ノート。ノートの無いスライドは空。読めなければ空の配列 */
export function pptxNotes(data: ArrayBuffer): string[] {
  try {
    const buf = Buffer.from(data);
    const files = readZip(buf, (n) => n.startsWith("ppt/") && (n.endsWith(".xml") || n.endsWith(".rels")));
    const text = (n: string) => files.get(n)?.toString("utf8");
    const pres = text("ppt/presentation.xml");
    if (!pres) return [];
    const presRels = rels(text("ppt/_rels/presentation.xml.rels"));
    const out: string[] = [];
    for (const t of pres.match(/<p:sldId\b[^>]*>/g) ?? []) {
      const rid = attr(t, "r:id");
      const slideRel = rid ? presRels.get(rid) : undefined;
      if (!slideRel) continue;
      const slide = resolve("ppt", slideRel.target);
      const slideXml = text(slide) ?? "";
      if (/<p:sld\b[^>]*\sshow="(0|false)"/.test(slideXml)) continue;
      const dir = slide.slice(0, slide.lastIndexOf("/"));
      const base = slide.slice(slide.lastIndexOf("/") + 1);
      const notes = [...rels(text(`${dir}/_rels/${base}.rels`)).values()].find((r) => r.type.endsWith("/notesSlide"));
      const xml = notes ? text(resolve(dir, notes.target)) : undefined;
      out.push(xml ? notesText(xml) : "");
    }
    return out;
  } catch {
    return [];
  }
}
