const { execSync } = require('child_process');
try { console.log('netstat :8080\n', execSync('netstat -ano | findstr :8080', { shell: 'powershell.exe' }).toString()); } catch (e) {}
try { console.log('\nnode processes\n', execSync('wmic process where name="node.exe" get ProcessId,CommandLine', { shell: 'powershell.exe' }).toString()); } catch (e) {}
