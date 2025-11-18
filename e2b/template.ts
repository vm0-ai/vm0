import { Template } from 'e2b'

export const template = Template()
  .fromImage('node:22-slim')
  .setUser('root')
  .setWorkdir('/')
  .runCmd('apt-get update && apt-get install -y git curl jq && rm -rf /var/lib/apt/lists/*')
  .runCmd('npm install -g @anthropic-ai/claude-code@2.0.24')
  .runCmd('claude --version')
  .copy('run-agent.sh', '/usr/local/bin/run-agent.sh')
  .runCmd('chmod +x /usr/local/bin/run-agent.sh')
  .setUser('user')
  .runCmd('mkdir -p $HOME/workspace')
  .setWorkdir('/home/user/workspace')