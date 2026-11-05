import { loadConfig } from './config.js';
import { openFolder } from './host.js';
import { createAppServer } from './server.js';

const config = loadConfig();

createAppServer({ ...config, openFolder }).listen(config.port, '127.0.0.1', () => {
  console.log(`Channel Downloader: http://127.0.0.1:${config.port}`);
  console.log(`Saving videos to ${config.outputRoot}`);
});
