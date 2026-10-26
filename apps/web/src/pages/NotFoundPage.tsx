import { Link } from "react-router";
import { EmptyState, PageHeader } from "../ui";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState title="There's nothing here.">
        <p>
          <Link to="/">Go home</Link>
        </p>
      </EmptyState>
    </>
  );
}
