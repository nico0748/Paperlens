// 発表の窓（URL に ?present=<論文ID> を付けて開いた窓）。スライド・論文・補足情報を、いつも全画面の見た目で映す。
// 中身は元の窓と同じ Workspace を発表の形（present）で動かす。補足情報の読み込みと保存も元の窓と同じ仕組みを使い、
// 保存先が同じなので、どちらの窓で書いたものも、もう一方の窓にそのまま映る。
// 元の窓（台本）とのやりとりは usePresentWindow.ts。

import { useEffect, useState } from "react";
import { Workspace } from "../../App.tsx";
import { type ServerBackend, connectServer } from "../../lib/backend.ts";

export function PresenterApp({ paperId }: { paperId: string }) {
  const [backend, setBackend] = useState<ServerBackend | null | undefined>(undefined);
  useEffect(() => {
    void connectServer().then((b) => setBackend(b));
  }, []);
  if (backend === undefined) return <div className="welcome" aria-busy="true" />;
  if (!backend) {
    return (
      <div className="welcome">
        <p>発表の窓は、PaperLens のアプリかローカルサーバーの画面から「発表」で開いてください。</p>
      </div>
    );
  }
  return <Workspace backend={backend} present={paperId} />;
}
