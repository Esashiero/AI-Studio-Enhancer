# Google AI Studio Pro Enhancer

[![UserScript Version](https://img.shields.io/badge/UserScript%20Version-v60.3-blue?style=flat-square)](aistudio-plus.user.js)
[![License](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

A powerful Tampermonkey/Greasemonkey script designed to enhance the quality of life and functionality within the Google AI Studio interface. It adds advanced navigation, library organization, detailed metadata, and customization options.

## ✨ Visual Tour & Features

### 1. Enhanced Library Management
The library view is completely transformed to provide more data at a glance.
*   **New Columns**: Adds "Created" (Date), "Count" (Messages), and "Tokens" (Total context).
*   **Visual Grouping**: Automatically detects "Branch of" and "Copy of" relationships, visually indenting them under their parent chat for a clean file tree structure.
*   **Sorting**: All new columns are sortable.

<img width="1018" height="216" alt="Library View with Branching" src="https://github.com/user-attachments/assets/5b45d355-04ed-4815-bb26-f7f884a9d59e" />

### 2. Family Tree Toolbar & Session Metadata
Never lose track of your conversation branches again.
*   **Family Tree**: The top toolbar displays numbered links to the Parent, Siblings, and Children of the current chat.
*   **Smart Coloring**: Links turn **Green** if that branch is newer than the one you are currently viewing.
*   **Session Info**: Displays the exact creation date and a relative "Last Modified" timer right next to the token count.

<img width="827" height="58" alt="Family Tree Toolbar" src="https://github.com/user-attachments/assets/1999fc19-e10e-41a2-89fe-0b951a3cfb16" />

### 3. Smart Navigation Tools
Navigate long context windows with ease using dedicated tools injected into the UI.

*   **Find in Chat**: A custom search bar (accessible via the 3-dot menu) allows you to search specifically within the chat message content, highlighting results and jumping between them.
*   **Dual Scroll Buttons**: Floating Action Buttons (FABs) in the bottom right allow you to jump precisely to the Previous or Next message turn, skipping over long blocks of text.

| **Find in Chat** | **Scroll Navigator** |
| :--- | :--- |
| <img width="367" height="50" alt="Find in Chat" src="https://github.com/user-attachments/assets/b36d9ccc-a142-4ab3-8fa6-55a8f21b611d" /> | <img width="67" height="144" alt="Scroll Buttons" src="https://github.com/user-attachments/assets/88d74100-a486-43d4-92be-30eab43da427" /> |

### 4. Customization & Data Sync
A new "Enhancer" button in the Settings menu opens a dedicated configuration modal.
*   **Appearance**: Customize date formats (Short, American, Relative) and the color of the Token count in the library.
*   **Force Sync**: A dedicated button to force a synchronization with Google Drive, useful for cleaning up "ghost" chats or updating metadata immediately.

<img width="406" height="516" alt="Settings Modal" src="https://github.com/user-attachments/assets/9534e0be-6733-4d42-963b-f3a1a4c82dc1" />

### 5. Toolbar Cleanup & Export
To reduce clutter, native buttons like "Share", "Compare", and "New Chat" are moved into the "More Actions" (3-dot) menu.
*   **Export Options**: Adds one-click options to export your full chat history to **JSON** or **Markdown**.

<img width="172" height="342" alt="Toolbar Cleanup" src="https://github.com/user-attachments/assets/d4ae51bc-7385-4973-80a2-c3b8d9eafba5" />

---

## 🔑 Google Credentials Configuration

The script requires Google Drive API credentials to access creation and modification dates for your conversations.

1. **Create a Google Cloud Project** at the [Google Cloud Console](https://console.cloud.google.com/).
2. **Enable the Google Drive API** in "APIs & Services" → "Library".
3. **Create OAuth Credentials**:
   *   Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client IDs".
   *   Select "Desktop App".
   *   Copy your **Client ID** and **Client Secret**.
4. **Generate a Refresh Token**:
   *   Use the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
   *   Settings (Gear icon): Check "Use your own OAuth credentials" and paste your ID/Secret.
   *   Scope: `https://www.googleapis.com/auth/drive.readonly`
   *   Exchange the authorization code for tokens to get your **Refresh Token**.
5. **Update the Script**:
   *   Open the script in Tampermonkey.
   *   Replace the values in the `CONFIG` object at the top of the script:
   ```javascript
   const CONFIG = {
       CLIENT_ID: "YOUR_CLIENT_ID",
       CLIENT_SECRET: "YOUR_CLIENT_SECRET",
       REFRESH_TOKEN: "YOUR_REFRESH_TOKEN",
       FOLDER_NAME: "Google AI Studio",
       SYNC_INTERVAL_MINUTES: 15
   };
   ```

## 💾 Installation

1.  **Install Manager**: Get [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) (Chrome/Edge) or [Greasemonkey](https://addons.mozilla.org/en-US/firefox/addon/greasemonkey/) (Firefox).
2.  **Install Script**: [**Click here to install `aistudio-plus.user.js`**](aistudio-plus.user.js)
3.  **Configure**: Add your credentials as described above.
4.  **Enjoy**: Reload Google AI Studio.

## 📜 Development

Developed by Esashiero, with architectural guidance provided by Gemini.

---
*Developed for the Google AI Studio platform.*
