import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

if (window.resona?.desktop) document.documentElement.classList.add("desktop"); // running in the Mac app

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
