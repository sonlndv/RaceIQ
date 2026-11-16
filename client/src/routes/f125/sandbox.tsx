import { createFileRoute } from "@tanstack/react-router";
import { SandboxPage } from "@/components/sandbox/SandboxPage";

export const Route = createFileRoute("/f125/sandbox")({
  component: SandboxPage,
});
