import { Route, Routes } from "react-router";
import { useMe } from "./auth";
import { Layout } from "./components/Layout";
import { ClientPage } from "./pages/ClientPage";
import { ClientsPage } from "./pages/ClientsPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";

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
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
