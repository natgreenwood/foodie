import type { ComponentType } from "react";
import { AdminAiPage } from "./AdminAiPage";
import { Link } from "./router";

// The pages under /admin. Each one is routed, listed on the index and given
// a breadcrumb from this entry alone, so a new admin page (NATG-242's users)
// is one more entry here.
export const adminPages: {
  path: string;
  title: string;
  description: string;
  Page: ComponentType;
}[] = [
  {
    path: "/admin/ai",
    title: "AI settings",
    description: "Provider keys, the default model and the reasoning level.",
    Page: AdminAiPage,
  },
];

export function AdminIndex() {
  return (
    <section aria-labelledby="admin-heading">
      <h2 id="admin-heading">Admin</h2>
      <p>Settings here apply to everyone who uses this Foodie.</p>
      <ul className="identity-list">
        {adminPages.map(({ path, title, description }) => (
          <li key={path} className="identity">
            <Link to={path} className="identity-name">
              {title}
            </Link>
            <p className="hint">{description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdminBreadcrumb({ title }: { title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol>
        <li>
          <Link to="/admin">Admin</Link>
        </li>
        <li aria-current="page">{title}</li>
      </ol>
    </nav>
  );
}

// For a signed-in user who is not an admin, at the address they asked for.
export function NoPermission() {
  return (
    <section aria-labelledby="no-permission-heading">
      <h2 id="no-permission-heading">
        You don't have permission to see this page
      </h2>
      <p>
        The admin area is only for Foodie admins. If you need access, ask one of
        them.
      </p>
      <p>
        <Link to="/">Go to the import page</Link>
      </p>
    </section>
  );
}
