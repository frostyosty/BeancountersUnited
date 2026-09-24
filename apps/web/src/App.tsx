import { Route, Routes } from "react-router";
import { useMe } from "./auth";
import { Layout } from "./components/Layout";
import { ChartPage } from "./pages/ChartPage";
import { ClientPage } from "./pages/ClientPage";
import { ClientsPage } from "./pages/ClientsPage";
import { LoginPage } from "./pages/LoginPage";
import { JournalsTab } from "./pages/JournalsTab";
import { NotFoundPage } from "./pages/NotFoundPage";
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
    <Routes>
      <Route element={<Layout me={me.data} />}>
        <Route index element={<ClientsPage />} />
        <Route path="clients/:clientId" element={<ClientPage />} />
        <Route path="clients/:clientId/chart" element={<ChartPage />} />
        <Route path="years/:yearId" element={<YearLayout />}>
          <Route index element={<JournalsTab />} />
          <Route path="tb" element={<TrialBalanceTab />} />
          <Route path="import" element={<TbImportTab />} />
          <Route path="statements" element={<StatementsTab />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
