// テスト用の小さな PPTX（ZIP）を作る
import { deflateRawSync } from "node:zlib";

/** ZIP を作る（deflate と無圧縮を交互に使う。CRC は読まないので 0 のまま） */
export function makeZip(files: Record<string, string>): ArrayBuffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text, "utf8");
    const method = i % 2 ? 0 : 8;
    const body = method ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, body);
    central.push(ch, n);
    offset += lh.length + n.length + body.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const b = Buffer.concat([...locals, cd, end]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const NS = 'xmlns:p="p" xmlns:a="a" xmlns:r="r"';
export const notesXml = (...paras: string[]) =>
  `<p:notes ${NS}><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>3</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:notes>`;
const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas/${type}" Target="${target}"/>`;

/** 3 枚のスライド。順は slide3, slide1, slide2。slide1 は非表示、slide2 はノート無し */
export function samplePptx() {
  return makeZip({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships>${rel("rId1", "slide", "slides/slide1.xml")}${rel("rId2", "slide", "slides/slide2.xml")}${rel("rId3", "slide", "/ppt/slides/slide3.xml")}</Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld ${NS} show="0"/>`,
    "ppt/slides/slide2.xml": `<p:sld ${NS}/>`,
    "ppt/slides/slide3.xml": `<p:sld ${NS}/>`,
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships>${rel("rId2", "notesSlide", "../notesSlides/notesSlide1.xml")}</Relationships>`,
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships>${rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")}</Relationships>`,
    "ppt/slides/_rels/slide3.xml.rels": `<Relationships>${rel("rId2", "notesSlide", "../notesSlides/notesSlide9.xml")}</Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": notesXml("隠したスライド"),
    "ppt/notesSlides/notesSlide9.xml": notesXml("最初に背景を話す", "Q &amp; A は最後"),
  });
}

