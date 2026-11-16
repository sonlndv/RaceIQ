import { HomePageContainer } from "@/components/home/HomePageContainer";
import { SandboxDashboardView } from "./SandboxDashboardView";

/** Separate presentation; the original F1 game identity and data hooks stay shared. */
export function SandboxPage() {
  return (
    <section data-f1-sandbox className="min-h-full bg-app-bg">
      <header className="mx-auto max-w-[1400px] px-3 pt-4 pb-2 @3xl/workspace:px-6">
        <h1 className="text-app-heading font-semibold text-app-text">Sandbox</h1>
        <p className="mt-1 text-app-detail text-app-text-muted">F1 2025 · Shared recordings, separate workspace.</p>
      </header>
      <HomePageContainer view={SandboxDashboardView} />
    </section>
  );
}
