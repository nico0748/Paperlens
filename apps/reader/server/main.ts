// npm start で動かす入口。表示された URL（合言葉付き）をブラウザで開く。
import { startServer } from "./app.ts";

const s = await startServer();
console.log(`PaperLens を起動しました。次の URL をブラウザで開いてください（合言葉付き。人に見せないでください）:`);
console.log(`  ${process.env.PAPERLENS_LOGIN_URL_BASE ? `${process.env.PAPERLENS_LOGIN_URL_BASE}/?login=${s.sessionSecret}` : s.loginUrl}`);
console.log(`保存先: ${s.dataRoot}`);
console.log("止めるときは Ctrl + C を押してください。");
