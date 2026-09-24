import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <>
      <h1>Not found</h1>
      <p>
        There's nothing here. <Link to="/">Go home</Link>
      </p>
    </>
  );
}
