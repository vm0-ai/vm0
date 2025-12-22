import { Metadata } from 'next';
import SkillsContent from './SkillsContent';

export const metadata: Metadata = {
  title: 'VM0 Skills - Pre-built Integrations',
  description: 'Explore our comprehensive collection of pre-built skills for AI agents. Connect to 50+ services including Slack, GitHub, Notion, and more.',
  openGraph: {
    title: 'VM0 Skills - Pre-built Integrations',
    description: 'Explore our comprehensive collection of pre-built skills for AI agents.',
    type: 'website',
  },
};

export default function SkillsPage() {
  return <SkillsContent />;
}
