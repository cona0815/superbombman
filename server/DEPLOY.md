# 成語炸彈超人・連線對戰 部署說明　v6.0　2026-10-21

跟「大橋大車拚」一樣：遊戲網頁放 Netlify（或 GitHub Pages），另外一台 Node.js WebSocket 伺服器放 Render。
網頁更新不會自動啟動伺服器，伺服器要自己在 Render 建一次。

## 一、在 Render 建伺服器（只做一次）

1. 到 https://dashboard.render.com → New → **Blueprint** → 連結 GitHub 的 `cona0815/superbombman`。
   Render 會讀到根目錄的 `render.yaml`，用 `server/` 建一個 Web Service（免費方案）。
2. 填兩個環境變數：
   - `TEACHER_KEY`：自己想一組至少 16 個字的金鑰，只給老師用（開房時輸入）。
   - `ALLOWED_ORIGINS`：遊戲網站的完整網址，例如 `https://你的網站.netlify.app`（結尾不要斜線；多個用逗號分隔）。
3. 部署完成後，打開 `https://服務名稱.onrender.com/health`，看到 `"ok":true` 就是成功。

## 二、把伺服器網址填進遊戲

把 `multiplayer-config.js` 裡的
```js
window.BOMB_MP_SERVER = '';
```
改成
```js
window.BOMB_MP_SERVER = 'wss://服務名稱.onrender.com/room';
```
再更新 Netlify（連同 index.html、teacher.html、multiplayer-config.js 三個檔案一起放）。

## 三、上課流程

1. 老師打開 `https://你的網站/teacher.html`，輸入金鑰登入，輸入房名、選「成語大亂鬥」與分鐘數，按「＋ 開新房間」（每房最多 8 人，可以開很多房）。
2. 學生打開遊戲，先在「我的人物」上傳並儲存自己的 Tinkercad 人物，再按「🌐 連線對戰」，點老師開的房間加入。
3. 老師看到名單都「✅ 準備好」後按「🏁 開始」，學生畫面會倒數 4 秒自動開打。
4. 時間到或只剩一人時自動結算，老師頁面會記錄名次（可匯出 CSV），按「再來一場」就能重打。

## 免費方案要注意

- Render 免費方案閒置 15 分鐘會休眠，第一個人連線時要等 30–60 秒喚醒（遊戲和老師頁面都會自動等）。上課前老師先登入控制台就會先喚醒。
- 房間裡第一位準備好的學生是「主機」，世界規則（傷害、磚塊、寶盒、計時）由他的電腦計算；他離開時伺服器自動換下一位接手。

## 本機測試（不用先買任何服務）

```sh
cd server
npm ci
npm start            # 伺服器開在 ws://127.0.0.1:8787/room，老師金鑰 local-classroom-test
```
另開一個終端機，在遊戲根目錄：
```sh
python -m http.server 8080 --bind 127.0.0.1
```
瀏覽器開 `http://127.0.0.1:8080/teacher.html` 登入開房，再用無痕視窗開 `http://127.0.0.1:8080/` 當學生加入。
