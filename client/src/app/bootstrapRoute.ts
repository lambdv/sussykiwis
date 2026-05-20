export type BootstrapRoute = "menu" | "root" | "openday";

export function resolveBootstrapRoute(pathname: string): BootstrapRoute {
  // Normalize away trailing slashes so `/openday/` behaves like `/openday`.
  const normalized = pathname.replace(/\/+$/, "") || "/";

  if (normalized === "/openday" || normalized === "/server-view") {
    return "openday";
  }

  if (normalized === "/") {
    return "root";
  }

  return "menu";
}
