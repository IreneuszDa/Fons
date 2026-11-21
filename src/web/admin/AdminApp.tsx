// Admin panel (lazy chunk). Login view scaffolded from the Astryx `login` page template; the signed-in view from `table`.
import { useCallback, useEffect, useMemo, useState } from "react";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { HStack, Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { ApiError, isFixtureMode, NETWORK_ERROR_PL } from "../api";
import { CachePanel, ExportsPanel, TokensPanel, UsersPanel } from "./AccessPanels";
import { adminLogin, adminLogout, adminMe, type AdminUser } from "./adminApi";
import CasesPanel from "./CasesPanel";
import MetricsPanel from "./MetricsPanel";
import { Forbidden } from "./parts";
import { isAdminTab, ROLE_LABEL_PL, TAB_LABEL_PL, tabsForRole, type AdminTab } from "./roles";
import { AdminContext } from "./useAdminData";

type Phase = { kind: "checking" } | { kind: "login"; notice?: string } | { kind: "forbidden"; message: string } | { kind: "in"; user: AdminUser };

export default function AdminApp() {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  useEffect(() => {
    let alive = true;
    adminMe()
      .then((user) => alive && setPhase(user ? { kind: "in", user } : { kind: "login" }))
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 403) setPhase({ kind: "forbidden", message: err.messagePl });
        else setPhase({ kind: "login", notice: err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL });
      });
    return () => {
      alive = false;
    };
  }, []);

  const onUnauthorized = useCallback(() => setPhase({ kind: "login", notice: "Sesja wygasła. Zaloguj się ponownie." }), []);

  if (phase.kind === "checking") {
    return (
      <Center axis="both" padding={6}>
        <Spinner size="lg" label="Sprawdzam sesję…" aria-label="Sprawdzam sesję" />
      </Center>
    );
  }
  if (phase.kind === "login") return <LoginView notice={phase.notice} onDone={(user) => setPhase({ kind: "in", user })} />;
  if (phase.kind === "forbidden") {
    return (
      <Center axis="both" padding={6}>
        <Forbidden message={phase.message} />
      </Center>
    );
  }
  return <SignedIn user={phase.user} onUnauthorized={onUnauthorized} onLogout={() => setPhase({ kind: "login", notice: "Wylogowano." })} />;
}

function LoginView({ notice, onDone }: { notice?: string; onDone: (user: AdminUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const fixtures = isFixtureMode();

  const signIn = async () => {
    setError("");
    if (!username.trim() || !password) {
      setError("Podaj nazwę użytkownika i hasło.");
      return;
    }
    setIsLoading(true);
    try {
      const user = await adminLogin(username.trim(), password);
      setPassword("");
      onDone(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Center axis="both" padding={6}>
      {/* Cap the login column at 400px but let it shrink to fit narrow screens (structural width, from the template). */}
      <VStack gap={4} hAlign="center" width="100%" maxWidth={400}>
        <Card padding={8} width="100%">
          <VStack gap={4} hAlign="stretch">
            <VStack gap={1} hAlign="center">
              <Heading level={2} accessibilityLevel={1}>
                Panel zespołu Fons
              </Heading>
              <Text type="body" color="secondary" size="sm">
                Dla moderatorów, analityków i administratorów. Obywatele nie potrzebują konta.
              </Text>
            </VStack>
            {notice && !error ? <Banner status="info" title={notice} container="card" collapsible={false} /> : null}
            {error ? <Banner status="error" title={error} container="card" collapsible={false} /> : null}
            {fixtures ? (
              <Banner
                status="info"
                container="card"
                collapsible={false}
                title="Dane przykładowe"
                description="Zaloguj się jako moderator, analityk albo administrator — dowolnym hasłem."
              />
            ) : null}
            <TextInput label="Nazwa użytkownika" value={username} onChange={setUsername} size="lg" autoComplete="username" autoCapitalize="none" />
            <TextInput
              label="Hasło"
              value={password}
              onChange={setPassword}
              onEnter={() => void signIn()}
              type="password"
              size="lg"
              autoComplete="current-password"
            />
            <Button label="Zaloguj" variant="primary" size="lg" isLoading={isLoading} onClick={() => void signIn()} />
          </VStack>
        </Card>
      </VStack>
    </Center>
  );
}

function TabPanel({ tab }: { tab: AdminTab }) {
  switch (tab) {
    case "cases":
      return <CasesPanel />;
    case "metrics":
      return <MetricsPanel />;
    case "exports":
      return <ExportsPanel />;
    case "tokens":
      return <TokensPanel />;
    case "users":
      return <UsersPanel />;
    case "cache":
      return <CachePanel />;
  }
}

function SignedIn({ user, onUnauthorized, onLogout }: { user: AdminUser; onUnauthorized: () => void; onLogout: () => void }) {
  const tabs = tabsForRole(user.role);
  const [tab, setTab] = useState<AdminTab | undefined>(tabs[0]);
  const ctx = useMemo(() => ({ user, onUnauthorized }), [user, onUnauthorized]);
  const [loggingOut, setLoggingOut] = useState(false);

  return (
    <AdminContext.Provider value={ctx}>
      <Layout
        height="auto"
        contentWidth={1200}
        padding={6}
        header={
          <LayoutHeader hasDivider padding={4}>
            <VStack gap={3}>
              <HStack gap={3} wrap="wrap" vAlign="center" hAlign="between">
                <Heading level={1}>Panel zespołu</Heading>
                <HStack gap={2} wrap="wrap" vAlign="center">
                  <Text color="secondary">{user.username}</Text>
                  <Token label={ROLE_LABEL_PL[user.role]} size="sm" color="blue" />
                  <Button
                    label="Wyloguj"
                    variant="ghost"
                    isLoading={loggingOut}
                    onClick={() => {
                      setLoggingOut(true);
                      void adminLogout()
                        .catch(() => undefined)
                        .finally(onLogout);
                    }}
                  />
                </HStack>
              </HStack>
              {tabs.length > 1 && tab ? (
                <TabList value={tab} onChange={(v) => isAdminTab(v) && setTab(v)} hasDivider>
                  {tabs.map((t) => (
                    <Tab key={t} value={t} label={TAB_LABEL_PL[t]} />
                  ))}
                </TabList>
              ) : null}
            </VStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent isScrollable={false} padding={4} role="region" aria-label={tab ? TAB_LABEL_PL[tab] : "Panel zespołu"}>
            {tab ? <TabPanel key={tab} tab={tab} /> : <Forbidden />}
          </LayoutContent>
        }
      />
    </AdminContext.Provider>
  );
}
