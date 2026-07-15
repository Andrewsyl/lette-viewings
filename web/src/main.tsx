import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import AdminPage from "./pages/AdminPage";
import SlotsPage from "./pages/SlotsPage";
import LeadsPage from "./pages/LeadsPage";
import InvitePage from "./pages/InvitePage";
import "./index.css";

// Keyed on the navigation entry so clicking "New viewing" (a same-path push) remounts
// the chat. A remount alone is harmless — the page restores its saved exchange — it only
// starts fresh when the nav click has also cleared the session (see Shell in ui.tsx).
function AdminChat() {
  const location = useLocation();
  return <AdminPage key={location.key} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route path="/admin" element={<AdminChat />} />
        <Route path="/admin/slots" element={<SlotsPage />} />
        <Route path="/admin/leads" element={<LeadsPage />} />
        <Route path="/invite/:id" element={<InvitePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
