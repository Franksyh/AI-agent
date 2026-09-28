# Mini Codex 商店發布準備

目前公開網站支援 HTTPS、Web App Manifest、Service Worker、192／512 PNG 圖示與 Apple 主畫面圖示。手機和電腦可先透過瀏覽器安裝 PWA：

- Android：Chrome 選單 → 安裝應用程式／加到主畫面。
- iPhone／iPad：Safari 分享 → 加入主畫面。
- Windows／macOS：Edge 或 Chrome 的安裝圖示／選單。

隱私權政策網址：[https://future-assistant-jade.vercel.app/privacy.html](https://future-assistant-jade.vercel.app/privacy.html)。網站有安裝介面、離線 shell 和 Mini Codex 圖示。

## 商店草稿

- 名稱：Mini Codex
- 語言：繁體中文（台灣）
- 短描述：個人 AI 工作台，規劃任務、審查開源程式，並從本機 Codex 繼續工作。
- 長描述：Mini Codex 提供繁體中文的 AI 工作台、開源專案即時中繼資料、語音輸入、對話整理與 Windows 本機 Codex 伴侶程式。安裝版會隨網站更新。本機檔案和 Windows 操作只在擁有者自己的電腦處理，並由擁有者確認。
- 支援網址：[GitHub 專案](https://github.com/Franksyh/AI-agent)
- 隱私權網址：[公開隱私權政策](https://future-assistant-jade.vercel.app/privacy.html)
- 可直接下載 Windows 桌面可攜版：[MiniCodex-Windows.zip](https://github.com/Franksyh/AI-agent/releases/latest/download/MiniCodex-Windows.zip)；解壓後執行 `Start-Mini-Codex.cmd` 或 `MiniCodex.exe`。不需要另外安裝 Python；仍需自行安裝並登入官方 Codex CLI。此 ZIP 未簽署，也不是 Microsoft Store 套件。
- 原始碼 ZIP：[GitHub main.zip](https://github.com/Franksyh/AI-agent/archive/refs/heads/main.zip)；從原始碼啟動需 Python 3.10+ 與 Codex CLI。
- 圖示：`assets/mini-robot-512.png`；Store 封裝前要依各平台規格產生截圖和其他尺寸。

## Microsoft Store

網站可走 Microsoft 官方建議的 PWA → PWABuilder → MSIX → Partner Center 流程。尚未提交，因封裝需要 Partner Center 的產品識別資料與帳號；最後仍須由帳號擁有人完成商店資料並送交認證。

## Google Play

Android PWA 可封裝為 Trusted Web Activity（TWA）／Android App Bundle。封裝需要已保留的套件名稱、Play Console 帳號、簽署設定、網站 `assetlinks.json`，並在 Play Console 填好內容與資料安全聲明。新個人開發者帳號可能需要先完成 Google Play 規定的封閉測試才能申請正式發行。

目前沒有 Play Console 套件名稱、簽署金鑰或帳號資料，因此尚未產生可上傳的 AAB，也沒有送審。

## Apple App Store

iOS 使用者目前可直接安裝 PWA 至主畫面。App Store 需要原生 iOS 專案、macOS／Xcode 建置與簽署、Apple Developer 帳號和 App Review。Apple 的最低功能指引要求 app 提供超越單純網站包裝的實用功能；目前 Mini Codex 的 iOS 本機功能尚未實作，先包一層網站外殼不適合作為正式上架版本。

## 上架前仍需提供／完成

1. Microsoft Partner Center、Google Play Console、Apple Developer Program 的擁有者帳號／產品識別資料（請在各自官方平台登入，不要把密碼或簽署金鑰貼到聊天）。
2. 各平台正式商店名稱是否可用、聯絡信箱、支援網址、內容分級與隱私／資料安全聲明。
3. 商店用手機與桌面截圖；使用自己的 Mini Codex 介面，不使用其他產品的截圖或商標。
4. Google Play 的封閉測試安排；Apple App Store 需要完整原生 iOS 功能與 Xcode 簽署建置。

## 官方發布文件

- [Microsoft：將網站 PWA 封裝並提交 Microsoft Store](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/pwa/turn-your-website-pwa)
- [Microsoft：選擇 Windows app 發布路徑](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path)
- [Google Play：建立與設定 app](https://support.google.com/googleplay/android-developer/answer/9859152)
- [Google Play：新個人開發者帳號測試規則](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Apple：App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
