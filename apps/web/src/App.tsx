import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useMe } from "./auth";
import { ViewAsProvider } from "./lib/viewAs";
import { Layout } from "./components/Layout";
import { SiteGate } from "./components/SiteGate";
import { ContactPage } from "./pages/ContactPage";
import { AboutPage } from "./pages/AboutPage";
import { AccountantsPage } from "./pages/AccountantsPage";
import { AnalysisTab } from "./pages/AnalysisTab";
import { AssetsTab } from "./pages/AssetsTab";
import { BusinessPage } from "./pages/BusinessPage";
import { ChartPage } from "./pages/ChartPage";
import { ClientPage } from "./pages/ClientPage";
import { FinaliseTab } from "./pages/FinaliseTab";
import { GlTab } from "./pages/GlTab";
import { HomePage } from "./pages/HomePage";
import { JournalsTab } from "./pages/JournalsTab";
import { NewBusinessPage } from "./pages/NewBusinessPage";
import { NotesTab } from "./pages/NotesTab";
import { NotFoundPage } from "./pages/NotFoundPage";
import { MappingPage } from "./pages/MappingPage";
import { MasterChartPage } from "./pages/MasterChartPage";
import { ParagraphLibraryPage } from "./pages/ParagraphLibraryPage";
import { TemplatePage } from "./pages/TemplatePage";
import { PricingPage } from "./pages/PricingPage";
import { ProductPage } from "./pages/ProductPage";
import { ReconcileTab } from "./pages/ReconcileTab";
import { SaveTaxPage } from "./pages/SaveTaxPage";
import { AdminSettingsTab, MyAccountTab, SettingsHome, SettingsLayout, ToolsTab } from "./pages/SettingsLayout";
import { HomeRoute } from "./pages/OverviewPage";
import { AcceptInvitePage, InviteSignedOutPage, SignUpPage } from "./pages/SignUpPage";
import { StatementsTab } from "./pages/StatementsTab";
import { TbImportTab } from "./pages/TbImportTab";
import { TrialBalanceTab } from "./pages/TrialBalanceTab";
import { YearLayout } from "./pages/YearLayout";

// Loaded on first visit: the editor and its libraries are only for the few who open it.
const InvoiceMakerPage = lazy(() => import("./pages/InvoiceMakerPage").then((m) => ({ default: m.InvoiceMakerPage })));

export function App() {
  const me = useMe();

  if (me.isPending) {
    return <p className="page">Checking server…</p>;
  }
  if (me.isError) {
    return (
      <p className="page" role="alert">
        Server unreachable: {me.error.message}
      </p>
    );
  }
  if (!me.data) {
    return (
      <SiteGate>
        <Routes>
          <Route path="accountants" element={<AccountantsPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="contact" element={<ContactPage />} />
        <Route path="pricing" element={<PricingPage />} />
        <Route path="product" element={<ProductPage />} />
          <Route path="signup" element={<SignUpPage />} />
          <Route path="invite/:token" element={<InviteSignedOutPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </SiteGate>
    );
  }
  return (
    <ViewAsProvider me={me.data}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomeRoute />} />
          <Route path="clients/:clientId" element={<ClientPage />} />
          <Route path="clients/:clientId/chart" element={<ChartPage />} />
          <Route path="businesses/new" element={<NewBusinessPage />} />
          <Route path="businesses/:clientId" element={<BusinessPage />} />
          <Route path="businesses/:clientId/save-tax" element={<SaveTaxPage />} />
          <Route path="years/:yearId" element={<YearLayout />}>
            <Route index element={<JournalsTab />} />
            <Route path="tb" element={<TrialBalanceTab />} />
            <Route path="import" element={<TbImportTab />} />
            <Route path="assets" element={<AssetsTab />} />
            <Route path="statements" element={<StatementsTab />} />
            <Route path="notes" element={<NotesTab />} />
            <Route path="reconcile" element={<ReconcileTab />} />
            <Route path="gl" element={<GlTab />} />
            <Route path="analysis" element={<AnalysisTab />} />
            <Route path="finalise" element={<FinaliseTab />} />
          </Route>
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<SettingsHome />} />
            <Route path="admin" element={<AdminSettingsTab />} />
            <Route path="account" element={<MyAccountTab />} />
            <Route path="tools" element={<ToolsTab />} />
          </Route>
          <Route path="settings/paragraphs" element={<ParagraphLibraryPage />} />
          <Route path="settings/charts/:entityType" element={<MasterChartPage />} />
          <Route path="settings/templates/:templateId" element={<TemplatePage />} />
          <Route path="settings/mappings/:mappingId" element={<MappingPage />} />
          <Route
            path="tools/invoice"
            element={
              <Suspense fallback={<p>Opening the invoice maker…</p>}>
                <InvoiceMakerPage />
              </Suspense>
            }
          />
          <Route path="account" element={<Navigate to="/settings/account" replace />} />
          <Route path="invite/:token" element={<AcceptInvitePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ViewAsProvider>
  );
}
