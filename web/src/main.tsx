import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AdminPage from "./pages/AdminPage";
import SlotsPage from "./pages/SlotsPage";
import LeadsPage from "./pages/LeadsPage";
import InvitePage from "./pages/InvitePage";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/slots" element={<SlotsPage />} />
        <Route path="/admin/leads" element={<LeadsPage />} />
        <Route path="/invite/:id" element={<InvitePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
