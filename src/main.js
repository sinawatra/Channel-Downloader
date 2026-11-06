import { loadConfig } from './config.js';
import { openFolder, readClipboard } from './host.js';
import { createAppServer } from './server.js';

const config = loadConfig();

createAppServer({ ...config, openFolder, readClipboard }).listen(config.port, '127.0.0.1', () => {
  console.log(`Channel Downloader: http://127.0.0.1:${config.port}`);
  console.log(`Saving videos to ${config.outputRoot}`);
});
