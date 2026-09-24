import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "../lib/api";

export function HomePage() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => fetchHealth() });
  return (
    <>
      <h1>Home</h1>
      {health.data && (
        <p className="muted">
          Server {health.data.status}, version {health.data.version}
        </p>
      )}
    </>
  );
}
