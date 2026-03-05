const net = require('net');
const { execSync } = require('child_process');

const port = 3002;

const server = net.createServer();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`❌ Port ${port} is in use`);
    console.log('\nSearching for the process...\n');
    
    try {
      // List all listening ports
      console.log('=== All listening ports in 3000-3100 range ===');
      const pythonScript = `
import socket
for port in range(3000, 3101):
    try:
        s = socket.socket()
        s.bind(('', port))
        s.close()
    except OSError as e:
        if e.errno == 98:
            print(f'Port {port} is IN USE')
`;
      execSync(`python3 -c "${pythonScript.replace(/\n/g, '; ')}"`, { encoding: 'utf-8', stdio: 'inherit' });
    } catch (e) {
      console.log('Error:', e.message);
    }
  } else {
    console.log('Other error:', err);
  }
  process.exit(1);
});

server.on('listening', () => {
  console.log(`✅ Port ${port} is FREE!`);
  server.close();
  process.exit(0);
});

server.listen(port, '0.0.0.0');
