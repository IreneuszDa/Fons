// App frame scaffolded from the Astryx `shell-top-nav` page template (AppShell + TopNav), mega menus removed.
import { Activity, lazy, Suspense, useEffect } from "react";

import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import { SiteFooter } from "./components/SiteFooter";
import { Center } from "@astryxdesign/core/Center";
import { Spinner } from "@astryxdesign/core/Spinner";
import ChatPage from "./pages/ChatPage";
import { installLinkInterception, matchRoute, usePathname, type Route } from "./router";

// Only the citizen chat is in the main chunk; the rest loads on demand (the admin panel never reaches citizens).
const ResultPage = lazy(() => import("./pages/ResultPage"));
const SourcesPage = lazy(() => import("./pages/SourcesPage"));
const PhoneOnboardingPage = lazy(() => import("./pages/PhoneOnboardingPage"));
const AdminApp = lazy(() => import("./admin/AdminApp"));

export const BRAND = "Fons";
export const TAGLINE = "Sprawdź informację u źródła";

export const TITLES: Record<Route["name"], string> = {
  chat: `${BRAND} — ${TAGLINE.toLowerCase()}`,
  result: `Wynik sprawdzenia — ${BRAND}`,
  sources: `Źródła i metoda — ${BRAND}`,
  phone: `Profil telefoniczny — ${BRAND}`,
  admin: `Panel zespołu — ${BRAND}`,
  notfound: `Nie ma takiej strony — ${BRAND}`,
};

function PageLoading() {
  return (
    <Center axis="both" padding={6}>
      <Spinner size="lg" label="Wczytuję stronę…" aria-label="Wczytuję stronę" />
    </Center>
  );
}

function NotFound() {
  return (
    <EmptyState
      headingLevel={1}
      title="Nie ma takiej strony"
      description="Sprawdź adres albo wróć na stronę główną."
      actions={<Button label="Strona główna" variant="primary" href="/" />}
    />
  );
}

function Page({ route }: { route: Exclude<Route, { name: "chat" }> }) {
  switch (route.name) {
    case "result":
      return <ResultPage key={route.token} token={route.token} />;
    case "sources":
      return <SourcesPage />;
    case "phone":
      return <PhoneOnboardingPage />;
    case "admin":
      return <AdminApp />;
    default:
      return <NotFound />;
  }
}

export default function App() {
  const path = usePathname();
  const route = matchRoute(path);
  const showNavigation = route.name !== "chat" && route.name !== "sources" && route.name !== "phone";

  useEffect(() => installLinkInterception(), []);
  useEffect(() => {
    document.title = TITLES[route.name];
  }, [route.name]);

  return (
    <AppShell
      variant="surface"
      contentPadding={0}
      topNav={showNavigation && (
        <TopNav
          label="Nawigacja główna"
          heading={<TopNavHeading heading={BRAND} headingHref="/" logo={<Icon icon={ShieldCheckIcon} size="sm" color="accent" />} />}
          startContent={
            <>
              <TopNavItem label="Sprawdź" href="/" />
              <TopNavItem label="Źródła" href="/zrodla" />
            </>
          }
        />
      )}>
      <Layout
        height="fill"
        content={
          <LayoutContent padding={0} isScrollable={route.name !== "chat"}>
            <Activity mode={route.name === "chat" ? "visible" : "hidden"}>
              <ChatPage />
            </Activity>
            {route.name !== "chat" && (
              <Suspense fallback={<PageLoading />}>
                <Page route={route} />
              </Suspense>
            )}
          </LayoutContent>
        }
        footer={showNavigation && (
          <LayoutFooter hasDivider padding={2} label="Stopka">
            <SiteFooter />
          </LayoutFooter>
        )}
      />
    </AppShell>
  );
}
