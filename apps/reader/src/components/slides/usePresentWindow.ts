// 発表の窓（?present=<論文ID>）の側の、台本（元の窓）とのやりとり。lib/presenter.ts の BroadcastChannel を使う。
// - 見えているスライドのページと、選んでいるグループを台本へ知らせる
// - 台本からの指示で、スライドのページを動かす・グループと論文の該当箇所を見せる・窓を閉じる
// 発表の窓でないとき（paperId が null）は何もしない。

import { useCallback, useEffect, useRef, useState } from "react";
import { type PresentMsg, presentChannel } from "../../lib/presenter.ts";
import type { SlideFocus } from "./SlidesView.tsx";

export function usePresentWindow(
  paperId: string | null,
  opts: { active: string | null; setActive: (id: string | null) => void; setFocus: (f: SlideFocus) => void },
) {
  const [slideGoto, setSlideGoto] = useState<{ page: number; n: number } | null>(null);
  const chan = useRef<BroadcastChannel | null>(null);
  const pos = useRef({ page: 1, count: 0 });
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!paperId) return;
    const c = presentChannel(paperId);
    chan.current = c;
    const send = (m: PresentMsg) => c.postMessage(m);
    c.onmessage = (e: MessageEvent<PresentMsg>) => {
      const m = e.data;
      if (m.t === "ping") send({ t: "hello", ...pos.current });
      else if (m.t === "goto") setSlideGoto({ page: m.page, n: Date.now() });
      else if (m.t === "focus") {
        optsRef.current.setActive(m.id);
        optsRef.current.setFocus({ id: m.id, link: m.link, nonce: Date.now() });
      } else if (m.t === "close") window.close();
    };
    send({ t: "hello", ...pos.current });
    const bye = () => send({ t: "bye" });
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      c.close();
      chan.current = null;
    };
  }, [paperId]);

  const onSlidePage = useCallback((page: number, count: number) => {
    pos.current = { page, count };
    chan.current?.postMessage({ t: "page", page, count } satisfies PresentMsg);
  }, []);

  useEffect(() => {
    chan.current?.postMessage({ t: "active", id: opts.active } satisfies PresentMsg);
  }, [opts.active]);

  return { onSlidePage, slideGoto };
}
