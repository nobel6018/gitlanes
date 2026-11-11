import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";

import { whenFontsReady } from "./fonts";

// ref pill 폭을 canvas로 재므로 번들 폰트가 준비된 뒤 첫 렌더를 한다 (로컬 파일이라 수 ms)
whenFontsReady().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
