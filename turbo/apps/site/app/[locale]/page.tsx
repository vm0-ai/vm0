import LandingPage from "../components/LandingPage";
import { fetchClaudeCodeVersion } from "../lib/claude-code-version";

export default async function Home() {
  const claudeCodeVersion = await fetchClaudeCodeVersion();
  return <LandingPage claudeCodeVersion={claudeCodeVersion} />;
}
