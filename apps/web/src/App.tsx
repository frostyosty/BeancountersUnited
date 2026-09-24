import { Route, Routes } from "react-router";
import { CurrentUser, useMe } from "./auth";
import { Layout } from "./components/Layout";
import { AccountPage } from "./pages/AccountPage";
import { AssetsTab } from "./pages/AssetsTab";
import { ChartPage } from "./pages/ChartPage";
import { ClientPage } from "./pages/ClientPage";
import { ClientsPage } from "./pages/ClientsPage";
import { LoginPage } from "./pages/LoginPage";
import { JournalsTab } from "./pages/JournalsTab";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StatementsTab } from "./pages/StatementsTab";
import { TbImportTab } from "./pages/TbImportTab";
import { TrialBalanceTab } from "./pages/TrialBalanceTab";
import { YearLayout } from "./pages/YearLayout";

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
    return <LoginPage />;
  }
  return (
    <CurrentUser value={me.data}>
      <Routes>
        <Route element={<Layout me={me.data} />}>
          <Route index element={<ClientsPage />} />
          <Route path="clients/:clientId" element={<ClientPage />} />
          <Route path="clients/:clientId/chart" element={<ChartPage />} />
          <Route path="years/:yearId" element={<YearLayout />}>
            <Route index element={<JournalsTab />} />
            <Route path="tb" element={<TrialBalanceTab />} />
            <Route path="import" element={<TbImportTab />} />
            <Route path="assets" element={<AssetsTab />} />
            <Route path="statements" element={<StatementsTab />} />
          </Route>
          <Route path="settings" element={<SettingsPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </CurrentUser>
  );
}
