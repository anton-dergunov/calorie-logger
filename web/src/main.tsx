import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { registerCalorieLoggerServiceWorker } from "./pwa";

registerCalorieLoggerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
