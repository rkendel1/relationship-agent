import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserTokenStore, createClient } from "@feltdb/feltkit/client";
import { FeltKitProvider } from "@feltdb/feltkit/react";
import { App } from "./App";
import "./styles.css";

// Same origin as the page: `feltkit dev` serves the app, its functions, and AppPort together.
// Default: an HttpOnly cookie session (the page never sees the token). FeltKit accepts only explicit
// bearer credentials on POST /appport, so sending through the external delivery provider from the
// browser needs VITE_FELTKIT_SESSION=bearer, which keeps the token in localStorage (readable by any
// script on the page). Opt in only where external delivery from the browser is needed.
const client = createClient(import.meta.env.VITE_FELTKIT_SESSION === "bearer" ? { session: "bearer", tokens: browserTokenStore() } : {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeltKitProvider client={client}>
      <App />
    </FeltKitProvider>
  </StrictMode>,
);
